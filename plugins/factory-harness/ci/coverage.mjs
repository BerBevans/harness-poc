// The coverage ratchet. A PR's line and branch coverage, across every test project, must not fall
// more than 0.1 percentage points below the figure from the latest successful build of the target
// branch. Runs of the build workflow on that branch store their figure as an artifact; a PR run
// downloads it.
//
// Usage:
//   node coverage.mjs measure <build-settings report folder> <test results folder> <figure file>
//   node coverage.mjs find-baseline    (on pull_request; writes run-id to GITHUB_OUTPUT)
//   node coverage.mjs compare <figure file> <baseline figure file>

import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { annotation, getJson, runIfMain } from './lib/pull-request.mjs';

export const BASELINE_ARTIFACT = 'coverage-baseline';
export const ALLOWED_DROP = 0.1;

const FIX =
  'Coverage fell below the target branch. Add tests for the code this PR changes, and restore any ' +
  "test you deleted or weakened. Don't exclude code from coverage. If deleting well-covered code " +
  'lowered the figure, say so in the PR description.';
const UNMEASURED_FIX =
  "No test loads these projects, so their code isn't measured at all, not even as 0%. Add tests " +
  'that use them; for a project that is hard to unit test, an architecture test that loads it is enough.';

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

/**
 * Measures the product projects' coverage from the reports under the results folder. Returns the
 * figure and the product projects no report covers: a project no test loads is left out of the
 * reports, not counted as 0%, so adding an untested project would otherwise leave the figure alone.
 */
export function measure({ records, results }) {
  const productRecords = records.filter(r => !r.isTestProject);
  const product = new Set(productRecords.map(r => r.assemblyName.toLowerCase()));
  if (product.size === 0) throw new Error('No build-settings records for product projects, so there is nothing to measure.');
  const reports = fs.existsSync(results)
    ? fs.readdirSync(results, { recursive: true }).filter(name => name.endsWith('.cobertura.xml'))
      .map(name => fs.readFileSync(path.join(results, name), 'utf8')) : [];
  if (reports.length === 0) throw new Error(`No coverage reports under ${results}.`);
  const reported = new Set(reports.flatMap(reportedAssemblies));
  const unmeasured = productRecords.filter(r => !reported.has(r.assemblyName.toLowerCase()));
  return { figure: figure(reports.flatMap(xml => parseCobertura(xml, product))), unmeasured };
}

/** Fails for each product project no test loaded. Returns { passed, lines } or null. */
export function unmeasuredResult(unmeasured) {
  if (unmeasured.length === 0) return null;
  const name = r => path.basename(r.path).replace(/\.\w+proj$/i, '');
  return {
    passed: false,
    lines: [...unmeasured.map(r => annotation(path.relative(process.cwd(), r.path), `${name(r)} has no coverage: no test loads it.`)), UNMEASURED_FIX],
  };
}

/** Decides the ratchet. Returns { passed, lines }. */
export function compare({ current, baseline }) {
  const drops = ['lines', 'branches']
    .map(kind => ({ kind, drop: rate(baseline[kind]) - rate(current[kind]) }))
    .filter(({ drop }) => drop > ALLOWED_DROP + 1e-9);
  const summary = [`This PR: ${describe(current)}.`, `Target branch: ${describe(baseline)}.`];
  if (drops.length === 0) return { passed: true, lines: [...summary, 'Coverage held.'] };
  return {
    passed: false,
    lines: [
      ...drops.map(({ kind, drop }) => `::error::${kind === 'lines' ? 'Line' : 'Branch'} coverage fell by ${drop.toFixed(2)} percentage points.`),
      ...summary, FIX,
    ],
  };
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
    return { passed: true, lines: [`Coverage: ${describe(result)}.`] };
  }
  if (mode === 'find-baseline' && args.length === 0) {
    const { runId, url } = await findBaseline({ env, event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) });
    fs.appendFileSync(env.GITHUB_OUTPUT, `run-id=${runId}\n`);
    return { passed: true, lines: [`Comparing with ${url}.`] };
  }
  if (mode === 'compare' && args.length === 2) return compare({ current: readFigure(args[0]), baseline: readFigure(args[1]) });
  throw new Error('Usage: coverage.mjs measure <report folder> <results folder> <figure file> | find-baseline | compare <figure> <baseline>');
});
