import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runTests, testArguments, testProjects } from '../run-tests.mjs';

const record = (name, isTestProject = true) =>
  ({ path: path.resolve(`/r/tests/${name}/${name}.csproj`), isTestProject, assemblyName: name });

test('each test project runs on its own, into a folder named after it', () => {
  assert.deepEqual(testArguments(record('App.UnitTests'), '/results', 'Release'), [
    'test', path.resolve('/r/tests/App.UnitTests/App.UnitTests.csproj'), '-c', 'Release', '--no-build',
    '--logger', 'trx', '--results-directory', path.join('/results', 'App.UnitTests'),
    '--collect', 'Code Coverage;Format=cobertura',
  ]);
});

test('only test projects run, and every one runs even after one fails', () => {
  const ran = [];
  const runDotnet = args => {
    ran.push(path.basename(args[1], '.csproj'));
    return { status: args[1].includes('IntegrationTests') ? 1 : 0 };
  };
  const records = [record('App', false), record('App.UnitTests'), record('App.IntegrationTests'), record('App.UiTests')];
  const result = runTests({ records, results: '/results', configuration: 'Release', runDotnet });
  assert.deepEqual(ran, ['App.IntegrationTests', 'App.UiTests', 'App.UnitTests']);
  assert.deepEqual(result, { passed: false, lines: ['::error::Tests failed in App.IntegrationTests.'] });
});

test('passes when every project passes', () => {
  const result = runTests({ records: [record('App.UnitTests')], results: '/r', configuration: 'Release', runDotnet: () => ({ status: 0 }) });
  assert.deepEqual(result, { passed: true, lines: ['Ran 1 test projects.'] });
});

test('no test projects is an error, not a pass', () => {
  assert.throws(() => runTests({ records: [record('App', false)], results: '/r', configuration: 'Release', runDotnet: () => ({ status: 0 }) }),
    /nothing to run/);
});

test('two test projects with the same name are refused, since their results would mix', () => {
  const twin = { ...record('App.UnitTests'), path: path.resolve('/r/other/App.UnitTests/App.UnitTests.csproj') };
  assert.throws(() => testProjects([record('App.UnitTests'), twin]), /Two test projects are named App\.UnitTests/);
});
