// Fails the run unless every test in every test project ran and passed, and every test project
// follows the naming convention. `dotnet test` treats a skipped test as a pass, and the summary
// counters in a TRX file can say nothing was skipped when something was, so this reads each result.
//
// Which projects are test projects comes from the build-settings records, so it's what MSBuild
// says, not a guess from names. Results are matched to projects by assembly name.
//
// Usage: node test-results.mjs <build-settings report folder> <test results folder>

import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { annotation, runIfMain } from './lib/pull-request.mjs';

// The Stop hook runs *.UnitTests and *.ArchitectureTests; CI runs them all.
const TEST_PROJECT_NAME = /\.(UnitTests|ArchitectureTests|IntegrationTests|UiTests)$/;

const RUN_FIX =
  "Every test must run and pass. Don't skip, ignore or make tests inconclusive; fix the test or the " +
  "code instead. If a test can't pass yet, comment on the issue to explain why.";
const NAMING_FIX =
  'Test projects must be named *.UnitTests, *.ArchitectureTests, *.IntegrationTests or *.UiTests, ' +
  'so the Stop hook and CI know when to run them.';

const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
}

// The assembly name from a test's storage path: "/repo/bin/Release/net10.0/app.unittests.dll" -> "app.unittests".
const assemblyOf = storage => path.basename(storage.replace(/\\/g, '/')).replace(/\.(dll|exe)$/i, '').toLowerCase();

/** Every result in a TRX file, as { name, outcome, assembly }. The summary counters are ignored. */
export function parseTrx(xml) {
  const assemblyById = new Map();
  for (const [tag] of xml.matchAll(/<UnitTest\s[^>]*>/g)) {
    const { id, storage = '' } = attributes(tag);
    assemblyById.set(id, assemblyOf(storage));
  }
  return [...xml.matchAll(/<UnitTestResult\s[^>]*>/g)].map(([tag]) => {
    const { testId, testName = '', outcome = '' } = attributes(tag);
    return { name: testName, outcome, assembly: assemblyById.get(testId) ?? '' };
  });
}

/** Every .trx file under the results folder, parsed. */
export function readResults(resultsDir) {
  if (!fs.existsSync(resultsDir)) return [];
  return fs.readdirSync(resultsDir, { recursive: true })
    .filter(name => name.endsWith('.trx'))
    .flatMap(name => parseTrx(fs.readFileSync(path.join(resultsDir, name), 'utf8')));
}

const projectName = record => path.basename(record.path).replace(/\.\w+proj$/i, '');
const relative = record => path.relative(process.cwd(), record.path);

/** Decides the check. Returns { passed, lines }. */
export function evaluate({ records, results }) {
  if (records.length === 0) return { passed: false, lines: ['No build-settings records, so the test projects are unknown.'] };

  const misnamed = records.filter(record => record.isTestProject !== TEST_PROJECT_NAME.test(projectName(record)));
  const testProjects = records.filter(record => record.isTestProject);
  const ranNothing = testProjects.filter(record =>
    !results.some(result => result.assembly === record.assemblyName.toLowerCase()));
  const notPassed = results.filter(result => result.outcome !== 'Passed');

  const lines = [
    ...misnamed.map(record => annotation(relative(record), record.isTestProject
      ? `${projectName(record)} is a test project, but its name doesn't follow the convention.`
      : `${projectName(record)} is named like a test project, but isn't one, so its tests never run.`)),
    ...ranNothing.map(record => annotation(relative(record), `${projectName(record)} ran no tests.`)),
    ...notPassed.map(result => `::error::${result.name} didn't pass: its outcome was ${result.outcome || 'missing'}.`),
  ];
  if (lines.length === 0) {
    return { passed: true, lines: [`All ${results.length} tests in ${testProjects.length} test projects ran and passed.`] };
  }
  if (misnamed.length > 0) lines.push(NAMING_FIX);
  if (ranNothing.length > 0 || notPassed.length > 0) lines.push(RUN_FIX);
  return { passed: false, lines };
}

await runIfMain(import.meta.url, () => {
  const [reportDir, resultsDir] = process.argv.slice(2);
  if (!reportDir || !resultsDir) throw new Error('Usage: test-results.mjs <build-settings report folder> <test results folder>');
  return evaluate({ records: readRecords(reportDir), results: readResults(resultsDir) });
});
