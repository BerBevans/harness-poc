import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluate, parseTrx } from '../test-results.mjs';

// A TRX file shaped like the one VSTest writes, with the misleading counters it really produces:
// notExecuted="0" even though a test was skipped.
function trx(assembly, tests) {
  const storage = `/repo/tests/${assembly}/bin/Release/net10.0/${assembly.toLowerCase()}.dll`;
  return `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
${tests.map(([name, outcome], i) => `    <UnitTestResult executionId="e${i}" testId="t${i}" testName="${name}" computerName="ci" outcome="${outcome}" />`).join('\n')}
  </Results>
  <TestDefinitions>
${tests.map(([name], i) => `    <UnitTest name="${name}" storage="${storage}" id="t${i}"><TestMethod codeBase="${storage}" name="${name}" /></UnitTest>`).join('\n')}
  </TestDefinitions>
  <ResultSummary outcome="Completed">
    <Counters total="${tests.length}" executed="${tests.length}" passed="${tests.length}" failed="0" notExecuted="0" />
  </ResultSummary>
</TestRun>`;
}

const record = (name, { isTestProject = true, assemblyName = name } = {}) =>
  ({ path: path.resolve(`/repo/tests/${name}/${name}.csproj`), isTestProject, assemblyName });

const APP = { path: path.resolve('/repo/src/App/App.csproj'), isTestProject: false, assemblyName: 'App' };
const UNIT = record('App.UnitTests');

test('parses each result with its outcome and assembly, ignoring the counters', () => {
  const results = parseTrx(trx('App.UnitTests', [['App.UnitTests.A.Works', 'Passed'], ['App.UnitTests.A.Later', 'NotExecuted']]));
  assert.deepEqual(results, [
    { name: 'App.UnitTests.A.Works', outcome: 'Passed', assembly: 'app.unittests' },
    { name: 'App.UnitTests.A.Later', outcome: 'NotExecuted', assembly: 'app.unittests' },
  ]);
});

test('decodes XML entities in test names, as theory data produces', () => {
  const [result] = parseTrx(trx('App.UnitTests', [['App.UnitTests.A.Adds(left: 1, name: &quot;x&quot;)', 'Passed']]));
  assert.equal(result.name, 'App.UnitTests.A.Adds(left: 1, name: "x")');
});

test('passes when every test in every test project passed', () => {
  const results = parseTrx(trx('App.UnitTests', [['App.UnitTests.A.Works', 'Passed']]));
  assert.deepEqual(evaluate({ records: [APP, UNIT], results }),
    { passed: true, lines: ['All 1 tests in 1 test projects ran and passed.'] });
});

test('a skipped test fails, though dotnet test and the counters call it a pass', () => {
  const results = parseTrx(trx('App.UnitTests', [['App.UnitTests.A.Works', 'Passed'], ['App.UnitTests.A.Later', 'NotExecuted']]));
  const result = evaluate({ records: [APP, UNIT], results });
  assert.equal(result.passed, false);
  assert.equal(result.lines[0], "::error::App.UnitTests.A.Later didn't pass: its outcome was NotExecuted.");
  assert.match(result.lines.at(-1), /Don't skip, ignore or make tests inconclusive/);
});

test('any outcome other than Passed fails', () => {
  for (const outcome of ['Inconclusive', 'Timeout', 'Aborted', 'Pending', 'Warning', 'Failed']) {
    const results = parseTrx(trx('App.UnitTests', [['App.UnitTests.A.X', outcome]]));
    assert.equal(evaluate({ records: [UNIT], results }).passed, false, outcome);
  }
});

test('a test project with no results fails', () => {
  const result = evaluate({ records: [APP, UNIT, record('App.ArchitectureTests')], results: parseTrx(trx('App.UnitTests', [['App.UnitTests.A.X', 'Passed']])) });
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /App\.ArchitectureTests\.csproj::App\.ArchitectureTests ran no tests\./);
});

test('results are matched by assembly name, so a renamed assembly is found', () => {
  const renamed = record('App.UnitTests', { assemblyName: 'Tests.Unit' });
  assert.equal(evaluate({ records: [renamed], results: parseTrx(trx('Tests.Unit', [['X', 'Passed']])) }).passed, true);
  assert.equal(evaluate({ records: [renamed], results: parseTrx(trx('App.UnitTests', [['X', 'Passed']])) }).passed, false);
});

test('a test project with the wrong name fails', () => {
  const misnamed = record('App.Tests');
  const result = evaluate({ records: [misnamed], results: parseTrx(trx('App.Tests', [['X', 'Passed']])) });
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /App\.Tests is a test project, but its name doesn't follow the convention/);
  assert.match(result.lines.at(-1), /must be named \*\.UnitTests/);
});

test('a project named like a test project that is not one fails, since it would never run', () => {
  const result = evaluate({ records: [record('App.IntegrationTests', { isTestProject: false })], results: [] });
  assert.match(result.lines[0], /App\.IntegrationTests is named like a test project, but isn't one/);
});

test('every convention name is accepted', () => {
  const names = ['App.UnitTests', 'App.ArchitectureTests', 'App.IntegrationTests', 'App.UiTests'];
  const results = names.flatMap(name => parseTrx(trx(name, [[`${name}.X`, 'Passed']])));
  assert.equal(evaluate({ records: names.map(name => record(name)), results }).passed, true);
});

test('no records is an error, not a pass', () => {
  assert.equal(evaluate({ records: [], results: [] }).passed, false);
});
