// Runs the mutation check on a pull request: lists the changed files, chooses what to mutate
// (mutation.mjs), runs Stryker.NET once per core project and scores the reports. Below the
// threshold it passes only if someone in OVERRIDE_USER_IDS applied the mutation-override label.
//
// Stryker is installed at a pinned version into a folder of the check's own, and is given an empty
// config file of the check's own, so nothing in the product repo changes how it runs.
//
// Usage, on pull_request: node run-mutation.mjs <build-settings report folder> <work folder>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { OVERRIDE_LABEL, evaluate, selectRuns, tally, untestableResult } from './mutation.mjs';
import { projectName } from './run-tests.mjs';
import { fetchIssueEvents, labelAppliedBy, overridden } from './lib/override-label.mjs';
import { fetchChangedFiles, incompleteListing, parseUserIds, runIfMain } from './lib/pull-request.mjs';

export const STRYKER_VERSION = '5.0.0';

/** Installs the pinned Stryker into `toolDir`, unless it's there already. Returns the command to run. */
export function installStryker(toolDir, runDotnet = args => spawnSync('dotnet', args, { encoding: 'utf8' })) {
  const command = path.join(toolDir, process.platform === 'win32' ? 'dotnet-stryker.exe' : 'dotnet-stryker');
  if (fs.existsSync(command)) return command;
  const result = runDotnet(['tool', 'install', 'dotnet-stryker', '--version', STRYKER_VERSION, '--tool-path', toolDir]);
  if (result.status !== 0) throw new Error(`Installing Stryker ${STRYKER_VERSION} failed: ${result.stderr || result.stdout}`);
  return command;
}

/** Stryker's arguments for one run. Files to mutate are given relative to the project's folder, as Stryker expects. */
export function strykerArguments(run, { repoRoot, configFile, output }) {
  const projectDir = path.dirname(run.project.path);
  return [
    '--config-file', configFile,
    ...run.testProjects.flatMap(tests => ['--test-project', tests.path]),
    ...(run.files ?? []).flatMap(file => ['--mutate', path.relative(projectDir, path.join(repoRoot, file)).replace(/\\/g, '/')]),
    '--reporter', 'json',
    '--output', output,
  ];
}

// Stryker's reason for a mutant outside the --mutate files. One in a file the check chose means
// Stryker didn't mutate what it was asked to, which would otherwise pass as "no mutants".
const FILTERED = 'Removed by mutate filter';

function checkNothingFiltered(report, run, repoRoot) {
  const chosen = run.files && new Set(run.files.map(file => path.resolve(repoRoot, file)));
  for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
    const absolute = path.resolve(report.projectRoot ?? repoRoot, file);
    if ((!chosen || chosen.has(absolute)) && mutants.some(mutant => mutant.statusReason === FILTERED)) {
      throw new Error(`Stryker left out mutants in ${path.relative(repoRoot, absolute)}, which the check chose to mutate.`);
    }
  }
}

/**
 * Runs Stryker for each run and returns the reports. Throws if a run fails or leaves no report,
 * since neither may pass.
 */
export function mutate({ runs, repoRoot, work, runStryker }) {
  const configFile = path.join(work, 'stryker-config.json');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ 'stryker-config': {} }));
  return runs.map(run => {
    const output = path.join(work, projectName(run.project));
    fs.rmSync(output, { recursive: true, force: true });
    const result = runStryker(strykerArguments(run, { repoRoot, configFile, output }), path.dirname(run.project.path));
    if (result.status !== 0) throw new Error(`Stryker failed for ${projectName(run.project)}, with exit code ${result.status}.`);
    const reportFile = path.join(output, 'reports', 'mutation-report.json');
    if (!fs.existsSync(reportFile)) throw new Error(`Stryker left no report for ${projectName(run.project)} at ${reportFile}.`);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    checkNothingFiltered(report, run, repoRoot);
    return report;
  });
}

/**
 * The check, before any override. Returns { result, overridable }: only a low score can be
 * overridden, not a project that can't be tested.
 */
export function check({ records, changedFiles, repoRoot, work, runStryker }) {
  const runs = selectRuns({ records, changedFiles, repoRoot });
  if (runs.length === 0) {
    return { result: { passed: true, lines: ['This PR changes no core code or unit tests, so there is nothing to mutate.'] }, overridable: false };
  }
  const untestable = untestableResult(runs, repoRoot);
  if (untestable) return { result: untestable, overridable: false };
  const reports = mutate({ runs, repoRoot, work, runStryker });
  return { result: evaluate(tally(reports, repoRoot)), overridable: true };
}

await runIfMain(import.meta.url, async env => {
  const [reportDir, work] = process.argv.slice(2);
  if (!reportDir || !work) throw new Error('Usage: run-mutation.mjs <build-settings report folder> <work folder>');
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    throw new Error(`The mutation check runs the PR's code, so it must run on pull_request, not ${env.GITHUB_EVENT_NAME}.`);
  }
  const allowedUserIds = parseUserIds(env.OVERRIDE_USER_IDS, 'OVERRIDE_USER_IDS');
  const pr = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
  const api = { apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, number: pr.number, token: env.GITHUB_TOKEN };
  const changedFiles = await fetchChangedFiles(api);
  const incomplete = incompleteListing(changedFiles, pr.changed_files);
  if (incomplete) return incomplete;

  const stryker = installStryker(path.join(work, 'tool'));
  const { result, overridable } = check({
    records: readRecords(reportDir), changedFiles, repoRoot: env.GITHUB_WORKSPACE, work,
    runStryker: (args, cwd) => spawnSync(stryker, args, { cwd, stdio: 'inherit' }),
  });
  if (result.passed || !overridable) return result;
  const appliedBy = labelAppliedBy(await fetchIssueEvents(api), OVERRIDE_LABEL);
  return overridden(result, { label: OVERRIDE_LABEL, appliedBy, allowedUserIds });
});
