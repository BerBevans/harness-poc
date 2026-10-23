// Runs each test project on its own, with coverage, into a results folder named after the project.
// One `dotnet test` over the whole solution merges every project's coverage into a single report,
// so coverage couldn't be traced to the test project that produced it.
//
// Every project runs even after one fails, so a run shows all the failures. Which projects are test
// projects comes from the build-settings records.
//
// Usage: node run-tests.mjs <build-settings report folder> <test results folder> <configuration>

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { runIfMain } from './lib/pull-request.mjs';

export const projectName = record => path.basename(record.path).replace(/\.\w+proj$/i, '');

/** The test projects, by name. Throws if two share a name, since their results would share a folder. */
export function testProjects(records) {
  const projects = records.filter(record => record.isTestProject).sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const names = projects.map(projectName);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`Two test projects are named ${duplicate}. Test project names must be unique.`);
  return projects;
}

/** The arguments that test one project into its own folder under `results`. */
export const testArguments = (record, results, configuration) => [
  'test', record.path, '-c', configuration, '--no-build', '--logger', 'trx',
  '--results-directory', path.join(results, projectName(record)), '--collect', 'Code Coverage;Format=cobertura',
];

/** Runs every test project. Returns { passed, lines }. */
export function runTests({ records, results, configuration, runDotnet }) {
  const projects = testProjects(records);
  if (projects.length === 0) throw new Error('No build-settings records for test projects, so there is nothing to run.');
  const failed = projects.filter(record => runDotnet(testArguments(record, results, configuration)).status !== 0);
  if (failed.length === 0) return { passed: true, lines: [`Ran ${projects.length} test projects.`] };
  return { passed: false, lines: failed.map(record => `::error::Tests failed in ${projectName(record)}.`) };
}

await runIfMain(import.meta.url, () => {
  const [reportDir, results, configuration] = process.argv.slice(2);
  if (!reportDir || !results || !configuration) {
    throw new Error('Usage: run-tests.mjs <build-settings report folder> <test results folder> <configuration>');
  }
  return runTests({
    records: readRecords(reportDir), results, configuration,
    runDotnet: args => spawnSync('dotnet', args, { stdio: 'inherit' }),
  });
});
