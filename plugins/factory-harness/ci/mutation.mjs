// The mutation check: Stryker.NET breaks the code a PR touches in small ways, and the unit tests
// must notice. This file chooses what to mutate and scores Stryker's JSON reports.
//
// The harness chooses the files, not Stryker's own comparison with the target branch, because that
// ignores changes to tests: a PR that only weakens an assertion would pass. Changing a core file
// mutates the whole file. Changing a unit test project mutates every core project it references.
//
// Stryker only mutates a project that a test project references directly, so each core project is
// tested by the unit test projects that reference it. *.Adapters projects aren't mutated: integration
// tests are too slow to run once per mutant.

import path from 'node:path';
import { isAdapters } from './coverage.mjs';
import { projectName } from './run-tests.mjs';
import { annotation } from './lib/pull-request.mjs';

export const THRESHOLD = 75;
export const OVERRIDE_LABEL = 'mutation-override';

const FIX =
  'Mutants survived in the code this PR touched: the tests still pass when that code is broken. ' +
  'Strengthen the unit tests so each surviving mutant makes one fail. Do not weaken or delete tests, ' +
  'and do not add Stryker comments. If a mutant cannot be killed because it behaves exactly like the ' +
  `original code, say which one and why in a PR comment. Don't apply ${OVERRIDE_LABEL} yourself.`;
const UNTESTABLE_FIX =
  'Stryker only mutates a project that a test project references directly. Add a ProjectReference ' +
  'to these projects from the unit test project that tests them.';

const isCore = record => !record.isTestProject && !isAdapters(record);
const isUnitTests = record => record.isTestProject && projectName(record).endsWith('.UnitTests');
const normalise = p => path.resolve(p).replace(/\\/g, '/');

// Stryker counts these as caught or missed. Compile and runtime errors and ignored mutants count as neither.
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);
const NEITHER = new Set(['CompileError', 'RuntimeError', 'Ignored']);

/** The record of the project a file belongs to: the one whose folder holds it most closely. */
function owningProject(records, file) {
  const target = normalise(file);
  return records
    .filter(record => target.startsWith(`${path.dirname(normalise(record.path))}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * What to mutate, from the PR's changed files (as the API lists them: { filename, status }) and the
 * build-settings records. Returns one run per core project, sorted by name:
 * { project, files: repo-relative paths, or null for the whole project, testProjects }.
 */
export function selectRuns({ records, changedFiles, repoRoot }) {
  const selected = new Map();
  const select = (project, file) => {
    const run = selected.get(project.path) ?? { project, files: new Set() };
    if (file === null) run.files = null;
    else run.files?.add(file);
    selected.set(project.path, run);
  };

  for (const { filename, status } of changedFiles) {
    if (!filename.endsWith('.cs')) continue;
    const project = owningProject(records, path.join(repoRoot, filename));
    if (!project) continue;
    // A deleted core file has nothing left to mutate, but a deleted test may have been the one that caught a mutant.
    if (isCore(project) && status !== 'removed') select(project, filename);
    if (isUnitTests(project)) {
      for (const reference of project.references) {
        const referenced = records.find(record => normalise(record.path) === normalise(reference));
        if (referenced && isCore(referenced)) select(referenced, null);
      }
    }
  }

  const unitTests = records.filter(isUnitTests);
  return [...selected.values()]
    .map(({ project, files }) => ({
      project,
      files: files && [...files].sort(),
      testProjects: unitTests.filter(tests => tests.references.some(reference => normalise(reference) === normalise(project.path))),
    }))
    .sort((a, b) => projectName(a.project).localeCompare(projectName(b.project)));
}

/** Fails for each run that no unit test project can test. Returns { passed, lines } or null. */
export function untestableResult(runs, repoRoot) {
  const untestable = runs.filter(run => run.testProjects.length === 0);
  if (untestable.length === 0) return null;
  return {
    passed: false,
    lines: [
      ...untestable.map(run => annotation(path.relative(repoRoot, run.project.path),
        `${projectName(run.project)} can't be mutation tested: no unit test project references it directly.`)),
      UNTESTABLE_FIX,
    ],
  };
}

/**
 * Totals Stryker JSON reports. Returns { detected, undetected, missed }, where missed lists each
 * surviving or uncovered mutant as { file (repo-relative), line, status, mutatorName, replacement }.
 * Throws on a status it doesn't know, so a new Stryker version can't quietly change the score.
 */
export function tally(reports, repoRoot) {
  const total = { detected: 0, undetected: 0, missed: [] };
  for (const report of reports) {
    for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
      for (const mutant of mutants) {
        if (DETECTED.has(mutant.status)) total.detected++;
        else if (UNDETECTED.has(mutant.status)) {
          total.undetected++;
          total.missed.push({
            file: path.relative(repoRoot, path.resolve(report.projectRoot ?? repoRoot, file)).replace(/\\/g, '/'),
            line: mutant.location.start.line,
            status: mutant.status,
            mutatorName: mutant.mutatorName,
            replacement: mutant.replacement,
          });
        } else if (!NEITHER.has(mutant.status)) {
          throw new Error(`Stryker reported a mutant with status "${mutant.status}", which the check doesn't know how to score.`);
        }
      }
    }
  }
  return total;
}

const describeMissed = mutant => {
  const change = mutant.replacement === undefined ? mutant.mutatorName : `${mutant.mutatorName}, changing it to \`${mutant.replacement}\``;
  return mutant.status === 'NoCoverage'
    ? `Not covered: no unit test runs this code (${change}).`
    : `Survived: ${change}. Every unit test still passed.`;
};

/** Decides the check from the totals. Returns { passed, lines }. */
export function evaluate({ detected, undetected, missed }) {
  const mutants = detected + undetected;
  if (mutants === 0) return { passed: true, lines: ['No mutants in the code this PR touched, so there is nothing to score.'] };
  const score = (detected / mutants) * 100;
  const summary = `Mutation score ${score.toFixed(2)}% (${detected} of ${mutants} mutants caught); the threshold is ${THRESHOLD}%.`;
  if (score >= THRESHOLD) return { passed: true, lines: [summary] };
  return {
    passed: false,
    lines: [
      ...missed.map(mutant => annotation(mutant.file, describeMissed(mutant), mutant.line)),
      `::error::${summary}`,
      FIX,
    ],
  };
}
