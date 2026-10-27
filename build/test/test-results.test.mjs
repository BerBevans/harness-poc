// Builds and tests a copy of samples/consumer the way the build-and-test action does, then checks
// the test results. Needs the .NET SDK.
//   node --test "build/test/*.test.mjs"

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../plugins/factory-harness/ci/build-settings-report.mjs';
import { evaluate, readResults } from '../../plugins/factory-harness/ci/test-results.mjs';

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));
const targetsFile = path.join(harnessRoot, 'build/BuildSettings.targets');
// Not %TEMP%: Windows Smart App Control blocks loading freshly built DLLs from there.
const workFolder = process.env.HARNESS_TEST_WORK_DIR || path.join(harnessRoot, '.test-work');

let repo;
let reportDir;
let resultsDir;

const dotnet = (...args) => spawnSync('dotnet', args, { cwd: repo, encoding: 'utf8' });
const writeFile = (relative, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), text);
};

// Builds and tests as the action does, then runs the results check.
function buildAndTest() {
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.rmSync(resultsDir, { recursive: true, force: true });
  const built = dotnet('build', 'Consumer.slnx', '-nologo', '-v:q', '-c', 'Release',
    `-p:CustomAfterMicrosoftCommonTargets=${targetsFile}`, `-p:BuildSettingsReportDir=${reportDir}`, `-p:FactorySonarLintFile=${path.join(repo, '.github/SonarLint.xml')}`);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  dotnet('test', 'Consumer.slnx', '-nologo', '-c', 'Release', '--no-build', '--logger', 'trx', '--results-directory', resultsDir);
  const records = readRecords(reportDir);
  return { records, result: evaluate({ records, results: readResults(resultsDir) }) };
}

// A test project like the sample's, with the given C# files.
function addTestProject(name, files = {}) {
  const sampleProject = fs.readFileSync(path.join(repo, 'tests/Consumer.UnitTests/Consumer.UnitTests.csproj'), 'utf8');
  writeFile(`tests/${name}/${name}.csproj`, sampleProject);
  for (const [file, text] of Object.entries(files)) writeFile(`tests/${name}/${file}`, text);
  const added = dotnet('sln', 'Consumer.slnx', 'add', `tests/${name}/${name}.csproj`);
  assert.equal(added.status, 0, added.stdout + added.stderr);
}

describe('test results check', { timeout: 600_000 }, () => {
  before(() => {
    fs.mkdirSync(workFolder, { recursive: true });
    repo = fs.mkdtempSync(path.join(workFolder, 'test-results-'));
    reportDir = path.join(repo, '.build-settings-report');
    resultsDir = path.join(repo, '.test-results');
    fs.cpSync(path.join(harnessRoot, 'samples/consumer'), repo, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('the sample passes, and the records say which project is the test project', () => {
    const { records, result } = buildAndTest();
    assert.equal(result.passed, true, result.lines.join('\n'));
    assert.deepEqual(records.map(r => [path.basename(r.path), r.isTestProject, r.assemblyName]).sort(), [
      ['Consumer.UnitTests.csproj', true, 'Consumer.UnitTests'],
      ['Consumer.csproj', false, 'Consumer'],
    ]);
  });

  test('a skip that gets past the build, a misnamed project and an empty one all fail', () => {
    // The xUnit analyser fails the build on a skip, so the skip comes with the pragma an agent
    // might add. The diff scan catches the pragma; this check catches the skip.
    writeFile('tests/Consumer.UnitTests/LaterTests.cs', [
      'namespace Consumer.UnitTests;', '',
      '#pragma warning disable xUnit1004', 'public class LaterTests', '{',
      '    [Fact(Skip = "later")]', '    public void NotYet() => Assert.Equal(5, Calculator.Add(2, 3));', '}', '',
    ].join('\n'));
    addTestProject('Consumer.Checks', {
      'ChecksTests.cs': 'namespace Consumer.Checks;\n\npublic class ChecksTests\n{\n    [Fact]\n    public void Adds() => Assert.Equal(4, Calculator.Add(2, 2));\n}\n',
    });
    addTestProject('Consumer.Empty.UnitTests');

    const { result } = buildAndTest();
    assert.equal(result.passed, false);
    const text = result.lines.join('\n');
    assert.match(text, /Consumer\.UnitTests\.LaterTests\.NotYet didn't pass: its outcome was NotExecuted/);
    assert.match(text, /Consumer\.Checks is a test project, but its name doesn't follow the convention/);
    assert.match(text, /Consumer\.Empty\.UnitTests ran no tests/);
    assert.doesNotMatch(text, /Consumer\.UnitTests ran no tests/);
  });
});
