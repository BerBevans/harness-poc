// The coverage ratchet, on two figures: core code measured from unit tests, and *.Adapters
// projects measured from integration tests. Each figure's line and branch coverage must not fall
// more than 0.1 percentage points below the latest successful build of the target branch. Runs of
// the build workflow on that branch store their figure as an artifact; a PR run downloads it.
//
// Usage:
//   node coverage.mjs measure <build-settings report folder> <test results folder> <figure file>
//   node coverage.mjs find-baseline    (on pull_request; writes run-id to GITHUB_OUTPUT)
//   node coverage.mjs compare <figure file> <baseline figure file>    (on pull_request)
//
// Deleting well-covered code can lower the figure legitimately, so a drop passes when the
// coverage-override label is on the PR and someone in OVERRIDE_USER_IDS applied it.

import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { projectName } from './run-tests.mjs';
import { fetchIssueEvents, labelAppliedBy, overridden } from './lib/override-label.mjs';
import { annotation, getJson, parseUserIds, runIfMain } from './lib/pull-request.mjs';

export const BASELINE_ARTIFACT = 'coverage-baseline';
export const ALLOWED_DROP = 0.1;
export const OVERRIDE_LABEL = 'coverage-override';

const FIX =
  'Coverage fell below the target branch. Add tests for the code this PR changes, and restore any ' +
  "test you deleted or weakened. Don't exclude code from coverage. If deleting well-covered code " +
  'lowered the figure, say so in the PR description.';
const UNMEASURED_FIX =
  "No test of the right kind loads these projects, so their code isn't measured at all, not even as 0%. " +
  'Core code counts only unit tests, and *.Adapters projects count only integration tests; architecture ' +
  'and UI tests count towards neither. Add tests of the right kind that use these projects.';

// Core code is measured from unit tests, which fake the application's boundaries. The code that
// talks to those boundaries lives in *.Adapters projects, measured from integration tests.
const isAdapters = record => /\.Adapters$/.test(projectName(record));
export const GROUPS = [
  { key: 'core', label: 'Core code', testSuffix: '.UnitTests', testKind: 'unit test', isMember: record => !isAdapters(record) },
  { key: 'adapters', label: 'Adapter code', testSuffix: '.IntegrationTests', testKind: 'integration test', isMember: isAdapters },
];

const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, n, v]) => [n, v]));

/** The assembly names (lower case) a Cobertura report has a package for. */
export const reportedAssemblies = xml =>
  [...xml.matchAll(/<package\s[^>]*>/g)].map(([tag]) => (attributes(tag).name ?? '').toLowerCase());

/**
 * Every line in a Cobertura report, from the packages named in `assemblies` (lower case), as
 * { file, line, hits, branchesCovered, branches }. Reads each class's own line list, not the
 * per-method copies of it.
 */
export function parseCobertura(xml, assemblies) {
  const lines = [];
  for (const [, packageTag, packageBody] of xml.matchAll(/(<package\s[^>]*>)([\s\S]*?)<\/package>/g)) {
    if (!assemblies.has((attributes(packageTag).name ?? '').toLowerCase())) continue;
    for (const [, classTag, classBody] of packageBody.matchAll(/(<class\s[^>]*>)([\s\S]*?)<\/class>/g)) {
      const file = attributes(classTag).filename ?? '';
      const ownLines = classBody.replace(/<methods>[\s\S]*?<\/methods>/, '');
      for (const [tag] of ownLines.matchAll(/<line\s[^>]*>/g)) {
        const line = attributes(tag);
        const [, covered = 0, total = 0] = /\((\d+)\/(\d+)\)/.exec(line['condition-coverage'] ?? '') ?? [];
        lines.push({ file, line: Number(line.number), hits: Number(line.hits), branchesCovered: Number(covered), branches: Number(total) });
      }
    }
  }
  return lines;
}

/**
 * Merges lines from every report into one figure. A line is covered if any test project covered
 * it. A report only says how many of a line's branches were covered, not which, so a line's
 * branch count is the best any one report managed. That understates coverage when two projects
 * cover different branches of a line, but it does so the same way for the PR and the baseline.
 */
export function figure(lines) {
  const byLine = new Map();
  for (const entry of lines) {
    const key = `${entry.file}\n${entry.line}`;
    const seen = byLine.get(key);
    byLine.set(key, seen ? {
      hits: Math.max(seen.hits, entry.hits),
      branchesCovered: Math.max(seen.branchesCovered, entry.branchesCovered),
      branches: Math.max(seen.branches, entry.branches),
    } : entry);
  }
  const merged = [...byLine.values()];
  return {
    lines: { covered: merged.filter(l => l.hits > 0).length, valid: merged.length },
    branches: { covered: merged.reduce((sum, l) => sum + l.branchesCovered, 0), valid: merged.reduce((sum, l) => sum + l.branches, 0) },
  };
}

/** A percentage; code with no branches counts as fully branch-covered. */
export const rate = ({ covered, valid }) => (valid === 0 ? 100 : (covered / valid) * 100);

const describe = f => `line ${rate(f.lines).toFixed(2)}% (${f.lines.covered}/${f.lines.valid}), ` +
  `branch ${rate(f.branches).toFixed(2)}% (${f.branches.covered}/${f.branches.valid})`;

// The Cobertura reports in one test project's results folder. Throws if there are none, since a
// test project that ran must have produced one.
function readReports(results, testRecord) {
  const folder = path.join(results, projectName(testRecord));
  const names = fs.existsSync(folder)
    ? fs.readdirSync(folder, { recursive: true }).filter(name => name.endsWith('.cobertura.xml')) : [];
  if (names.length === 0) throw new Error(`No coverage report for ${projectName(testRecord)} under ${folder}.`);
  return names.map(name => fs.readFileSync(path.join(folder, name), 'utf8'));
}

/**
 * Measures each group's coverage from its own kind of test project, as run-tests.mjs lays the
 * results out. Returns the figure, with null for a group that has no projects, and the projects no
 * test of the right kind loaded: a project no test loads is left out of the reports, not counted
 * as 0%, so adding an untested project would otherwise leave the figure alone.
 */
export function measure({ records, results }) {
  const product = records.filter(r => !r.isTestProject);
  if (product.length === 0) throw new Error('No build-settings records for product projects, so there is nothing to measure.');
  const figures = {};
  const unmeasured = [];
  for (const group of GROUPS) {
    const members = product.filter(group.isMember);
    if (members.length === 0) {
      figures[group.key] = null;
      continue;
    }
    const reports = records.filter(r => r.isTestProject && projectName(r).endsWith(group.testSuffix))
      .flatMap(r => readReports(results, r));
    const reported = new Set(reports.flatMap(reportedAssemblies));
    unmeasured.push(...members.filter(r => !reported.has(r.assemblyName.toLowerCase())).map(r => ({ ...r, group })));
    const assemblies = new Set(members.map(r => r.assemblyName.toLowerCase()));
    figures[group.key] = figure(reports.flatMap(xml => parseCobertura(xml, assemblies)));
  }
  return { figure: figures, unmeasured };
}

/** Fails for each project no test of the right kind loaded. Returns { passed, lines } or null. */
export function unmeasuredResult(unmeasured) {
  if (unmeasured.length === 0) return null;
  return {
    passed: false,
    lines: [
      ...unmeasured.map(r => annotation(path.relative(process.cwd(), r.path), `${projectName(r)} has no coverage: no ${r.group.testKind} loads it.`)),
      UNMEASURED_FIX,
    ],
  };
}

/** A one-line description of a measured figure, for the log. */
export const describeFigure = figures => GROUPS.filter(g => figures[g.key])
  .map(g => `${g.label}: ${describe(figures[g.key])}`).join('; ');

/** Decides the ratchet for each group. Returns { passed, lines }. */
export function compare({ current, baseline }) {
  if (!baseline || !('core' in baseline)) {
    throw new Error("The target branch's coverage figure is in an older format. Rerun the build workflow on the target branch.");
  }
  const errors = [];
  const summary = [];
  for (const group of GROUPS) {
    const now = current[group.key];
    const before = baseline[group.key];
    if (!now) continue;
    summary.push(`${group.label}, this PR: ${describe(now)}.`);
    if (!before) {
      summary.push(`${group.label}, target branch: none yet, so there's nothing to compare with.`);
      continue;
    }
    summary.push(`${group.label}, target branch: ${describe(before)}.`);
    for (const kind of ['lines', 'branches']) {
      const drop = rate(before[kind]) - rate(now[kind]);
      if (drop > ALLOWED_DROP + 1e-9) {
        errors.push(`::error::${group.label} ${kind === 'lines' ? 'line' : 'branch'} coverage fell by ${drop.toFixed(2)} percentage points.`);
      }
    }
  }
  if (errors.length === 0) return { passed: true, lines: [...summary, 'Coverage held.'] };
  return { passed: false, lines: [...errors, ...summary, FIX] };
}

/**
 * The latest successful run of this workflow on the PR's target branch, started by a push or by
 * hand in this repo, and its baseline artifact. Throws if there isn't one, since a missing
 * baseline must not pass.
 */
export async function findBaseline({ env, event, fetchImpl }) {
  const workflow = /\/\.github\/workflows\/([^@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1];
  if (!workflow) throw new Error(`Can't tell the workflow file from GITHUB_WORKFLOW_REF "${env.GITHUB_WORKFLOW_REF}".`);
  const branch = event.pull_request.base.ref;
  const repo = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}`;
  const get = url => getJson(url, env.GITHUB_TOKEN, fetchImpl);

  const { workflow_runs: runs } = await get(
    `${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=100`);
  // A fork's PR from its own branch of the same name also has this head branch, so check the event and the repo.
  const run = runs.find(r => ['push', 'workflow_dispatch'].includes(r.event) && r.head_repository?.full_name === env.GITHUB_REPOSITORY);
  if (!run) throw new Error(`No successful push run of ${workflow} on ${branch}, so there's no coverage to compare with. Run the workflow on ${branch}.`);

  const { artifacts } = await get(`${repo}/actions/runs/${run.id}/artifacts?name=${BASELINE_ARTIFACT}`);
  if (!artifacts.some(a => a.name === BASELINE_ARTIFACT && !a.expired)) {
    throw new Error(`The latest successful run on ${branch} (${run.html_url}) has no ${BASELINE_ARTIFACT} artifact, or it expired. Rerun the workflow on ${branch}.`);
  }
  return { runId: run.id, url: run.html_url };
}

const readFigure = file => JSON.parse(fs.readFileSync(file, 'utf8'));

await runIfMain(import.meta.url, async env => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'measure' && args.length === 3) {
    const { figure: result, unmeasured } = measure({ records: readRecords(args[0]), results: args[1] });
    const failed = unmeasuredResult(unmeasured);
    if (failed) return failed;
    fs.writeFileSync(args[2], JSON.stringify({ ...result, commit: env.GITHUB_SHA }, null, 2));
    return { passed: true, lines: [`Coverage: ${describeFigure(result)}.`] };
  }
  if (mode === 'find-baseline' && args.length === 0) {
    const { runId, url } = await findBaseline({ env, event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) });
    fs.appendFileSync(env.GITHUB_OUTPUT, `run-id=${runId}\n`);
    return { passed: true, lines: [`Comparing with ${url}.`] };
  }
  if (mode === 'compare' && args.length === 2) {
    const allowedUserIds = parseUserIds(env.OVERRIDE_USER_IDS, 'OVERRIDE_USER_IDS');
    const result = compare({ current: readFigure(args[0]), baseline: readFigure(args[1]) });
    if (result.passed) return result;
    const events = await fetchIssueEvents({
      apiUrl: env.GITHUB_API_URL,
      repository: env.GITHUB_REPOSITORY,
      number: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request.number,
      token: env.GITHUB_TOKEN,
    });
    return overridden(result, { label: OVERRIDE_LABEL, appliedBy: labelAppliedBy(events, OVERRIDE_LABEL), allowedUserIds });
  }
  throw new Error('Usage: coverage.mjs measure <report folder> <results folder> <figure file> | find-baseline | compare <figure> <baseline>');
});
