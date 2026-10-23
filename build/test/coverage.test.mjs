// Builds and tests a copy of samples/consumer with coverage, the way the build-and-test action
// does, then checks what it measured and the coverage ratchet. Needs the .NET SDK.
//   node --test "build/test/*.test.mjs"

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../plugins/factory-harness/ci/build-settings-report.mjs';
import { compare, measure, unmeasuredResult } from '../../plugins/factory-harness/ci/coverage.mjs';
import { runTests } from '../../plugins/factory-harness/ci/run-tests.mjs';

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));
const targetsFile = path.join(harnessRoot, 'build/BuildSettings.targets');
// Not %TEMP%: Windows Smart App Control blocks loading freshly built DLLs from there.
const workFolder = process.env.HARNESS_TEST_WORK_DIR || path.join(harnessRoot, '.test-work');

let repo;

const dotnet = (...args) => spawnSync('dotnet', args, { cwd: repo, encoding: 'utf8' });
const writeFile = (relative, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), text);
};

// Builds and tests with coverage as the action does, one test project at a time, and returns what was measured.
function measureCoverage() {
  const reportDir = path.join(repo, '.build-settings-report');
  const resultsDir = path.join(repo, '.test-results');
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.rmSync(resultsDir, { recursive: true, force: true });
  const built = dotnet('build', 'Consumer.slnx', '-nologo', '-v:q', '-c', 'Release',
    `-p:CustomAfterMicrosoftCommonTargets=${targetsFile}`, `-p:BuildSettingsReportDir=${reportDir}`);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const records = readRecords(reportDir);
  const outputs = [];
  const tested = runTests({
    records, results: resultsDir, configuration: 'Release',
    runDotnet: args => { const run = dotnet(...args); outputs.push(run.stdout + run.stderr); return run; },
  });
  assert.equal(tested.passed, true, outputs.join('\n'));
  return measure({ records, results: resultsDir });
}

const signTests = tests => [
  'namespace Consumer.UnitTests;', '', 'public class SignTests', '{',
  ...tests.map(([name, value, expected]) => `    [Fact]\n    public void ${name}() => Assert.Equal("${expected}", Sign.Of(${value}));`),
  '}', '',
].join('\n');

describe('coverage measurement', { timeout: 600_000 }, () => {
  before(() => {
    fs.mkdirSync(workFolder, { recursive: true });
    repo = fs.mkdtempSync(path.join(workFolder, 'coverage-'));
    fs.cpSync(path.join(harnessRoot, 'samples/consumer'), repo, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });
    writeFile('src/Consumer/Sign.cs', [
      'namespace Consumer;', '', 'public static class Sign', '{',
      '    public static string Of(int value)', '    {',
      '        if (value > 0)', '        {', '            return "positive";', '        }', '',
      '        return "not positive";', '    }', '}', '',
    ].join('\n'));
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('measures only product code, and deleting a test fails the ratchet', () => {
    writeFile('tests/Consumer.UnitTests/SignTests.cs', signTests([['Positive', 1, 'positive'], ['NotPositive', 0, 'not positive']]));
    const { figure, unmeasured } = measureCoverage();
    assert.deepEqual(unmeasured, []);
    // Calculator.Add has one statement and Sign.Of three; the test code isn't counted.
    assert.deepEqual(figure.core.lines, { covered: 4, valid: 4 });
    assert.equal(figure.core.branches.covered, figure.core.branches.valid);
    assert.ok(figure.core.branches.valid > 0);
    assert.equal(figure.adapters, null);

    writeFile('tests/Consumer.UnitTests/SignTests.cs', signTests([['NotPositive', 0, 'not positive']]));
    const current = measureCoverage().figure;
    assert.deepEqual(current.core.lines, { covered: 3, valid: 4 });
    const result = compare({ current, baseline: figure });
    assert.equal(result.passed, false);
    assert.match(result.lines.join('\n'), /Core code line coverage fell by 25\.00 percentage points/);
    assert.match(result.lines.join('\n'), /Core code branch coverage fell by/);
  });

  test('adapter code counts integration tests only, and integration tests add nothing to core code', () => {
    const project = fs.readFileSync(path.join(repo, 'src/Consumer/Consumer.csproj'), 'utf8');
    writeFile('src/Consumer.Adapters/Consumer.Adapters.csproj', project);
    writeFile('src/Consumer.Adapters/Store.cs',
      'namespace Consumer.Adapters;\n\npublic static class Store\n{\n    public static int Save(int value) => value + 1;\n}\n');
    assert.equal(dotnet('sln', 'Consumer.slnx', 'add', 'src/Consumer.Adapters/Consumer.Adapters.csproj').status, 0);

    const withoutIntegration = measureCoverage();
    assert.deepEqual(withoutIntegration.unmeasured.map(r => r.assemblyName), ['Consumer.Adapters']);
    assert.match(unmeasuredResult(withoutIntegration.unmeasured).lines[0], /no integration test loads it/);

    const unitProject = fs.readFileSync(path.join(repo, 'tests/Consumer.UnitTests/Consumer.UnitTests.csproj'), 'utf8');
    writeFile('tests/Consumer.IntegrationTests/Consumer.IntegrationTests.csproj', unitProject.replace(
      '<ProjectReference Include="..\\..\\src\\Consumer\\Consumer.csproj" />',
      '<ProjectReference Include="..\\..\\src\\Consumer\\Consumer.csproj" />\n    ' +
      '<ProjectReference Include="..\\..\\src\\Consumer.Adapters\\Consumer.Adapters.csproj" />'));
    writeFile('tests/Consumer.IntegrationTests/StoreTests.cs', [
      'namespace Consumer.IntegrationTests;', '', 'public class StoreTests', '{',
      '    [Fact]', '    public void SavesNextValue() => Assert.Equal(2, Consumer.Adapters.Store.Save(1));', '',
      '    [Fact]', '    public void SignOfPositive() => Assert.Equal("positive", Sign.Of(1));', '}', '',
    ].join('\n'));
    assert.equal(dotnet('sln', 'Consumer.slnx', 'add', 'tests/Consumer.IntegrationTests/Consumer.IntegrationTests.csproj').status, 0);

    const { figure, unmeasured } = measureCoverage();
    assert.deepEqual(unmeasured, []);
    assert.deepEqual(figure.adapters.lines, { covered: 1, valid: 1 });
    // The previous test left Sign.Of's positive branch untested; the integration test covers it, but doesn't count.
    assert.deepEqual(figure.core.lines, { covered: 3, valid: 4 });
  });

  test('a product project no test loads fails, since it would not count at all', () => {
    const project = fs.readFileSync(path.join(repo, 'src/Consumer/Consumer.csproj'), 'utf8');
    writeFile('src/Orphan/Orphan.csproj', project);
    writeFile('src/Orphan/Lonely.cs', 'namespace Orphan;\n\npublic static class Lonely\n{\n    public static int Twice(int value) => value * 2;\n}\n');
    const added = dotnet('sln', 'Consumer.slnx', 'add', 'src/Orphan/Orphan.csproj');
    assert.equal(added.status, 0, added.stdout + added.stderr);

    const result = unmeasuredResult(measureCoverage().unmeasured);
    assert.equal(result?.passed, false);
    assert.match(result.lines[0], /Orphan has no coverage: no unit test loads it/);
  });
});
