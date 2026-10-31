#!/usr/bin/env node
// Stop hook: the agent can't finish on a red build. It runs the build (warnings as
// errors) and the *.UnitTests and *.ArchitectureTests projects, and refuses the stop
// once if they fail, unless a valid progress note records why the work is paused.
// It never refuses twice in a row (stop_hook_active), because CI still catches a red build.

import { blockStop, isEntryPoint, parseInput, readStdin, warnUser, writeOutput } from './lib/hook-io.mjs';
import { nextStepAfterFailedChecks, PROGRESS_NOTE_PATH, PROGRESS_STATUSES } from './lib/next-step.mjs';
import { createStopDependencies } from './lib/stop-dependencies.mjs';
import { summariseBuildFailures, summariseTestFailures, truncate, withoutRepoPath } from './lib/failure-summary.mjs';

export const MAX_FAILURE_CHARACTERS = 4000;

export function isValidProgressNote(text) {
  if (!text) return false;
  const status = /^\s*status:\s*(.+?)\s*$/im.exec(text);
  return status !== null && PROGRESS_STATUSES.includes(status[1].toLowerCase());
}

function runChecks(root, solution, deps) {
  const build = deps.runBuild(root, solution);
  if (!build.ok) return { failures: [summariseBuildFailures(build.output)], testProjectCount: 0 };

  const projects = deps.findTestProjects(root);
  const failures = projects
    .map(project => deps.runTests(root, project))
    .filter(result => !result.ok)
    .map(result => summariseTestFailures(result.output));
  return { failures, testProjectCount: projects.length };
}

/** Returns the hook output, or null to allow the stop silently. */
export function decideStop(input, deps) {
  if (input.stop_hook_active) return null;

  const root = deps.repoRoot(deps.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!root) return null;
  const solution = deps.findSolution(root);
  if (!solution) return null;

  const fingerprint = deps.fingerprint(root);
  if (fingerprint === deps.lastGreen(root)) return null;

  // A new product repo's solution has no projects until the architecture session adds them, and
  // dotnet build fails on it. There's no code to check, and CI still fails a PR with no projects.
  if (!deps.solutionHasProjects(root, solution)) {
    deps.saveGreen(root, fingerprint);
    return warnUser('Factory harness: the solution has no projects yet, so the build and tests were skipped.');
  }

  const { failures, testProjectCount } = runChecks(root, solution, deps);

  if (failures.length === 0) {
    deps.saveGreen(root, fingerprint);
    return testProjectCount === 0
      ? warnUser('Factory harness: the build passed, but no *.UnitTests or *.ArchitectureTests projects were found to run.')
      : null;
  }

  if (isValidProgressNote(deps.readProgressNote(root))) {
    return deps.hasUncommittedChanges(root)
      ? blockStop(`Checks are failing and ${PROGRESS_NOTE_PATH} records why. Commit your work in progress ` +
        'and the progress note to the branch, then stop.')
      : null;
  }

  const details = truncate(withoutRepoPath(failures.join('\n\n'), root), MAX_FAILURE_CHARACTERS);
  return blockStop(`You can't stop yet: the build or tests are failing.\n\n${details}\n\n${nextStepAfterFailedChecks(deps.env)}`);
}

async function main() {
  const input = parseInput(await readStdin());
  if (!input) return;
  try {
    writeOutput(decideStop(input, createStopDependencies(process.env)));
  } catch {
    // Fail open: blocking here could trap the session, and CI catches a red build.
  }
}

if (isEntryPoint(import.meta.url)) await main();
