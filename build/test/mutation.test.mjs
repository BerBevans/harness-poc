// Runs the mutation check with the real, pinned Stryker.NET on a copy of samples/consumer. Needs
// the .NET SDK, and the network the first time, to install Stryker.
//   node --test "build/test/*.test.mjs"

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../plugins/factory-harness/ci/build-settings-report.mjs';
import { STRYKER_VERSION, check, installStryker } from '../../plugins/factory-harness/ci/run-mutation.mjs';

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));
const targetsFile = path.join(harnessRoot, 'build/BuildSettings.targets');
// Not %TEMP%: Windows Smart App Control blocks loading freshly built DLLs from there.
const workFolder = process.env.HARNESS_TEST_WORK_DIR || path.join(harnessRoot, '.test-work');

let repo;
let stryker;

const writeFile = (relative, text) => fs.writeFileSync(path.join(repo, relative), text);

const signTests = assertion => [
  'namespace Consumer.UnitTests;', '', 'public class SignTests', '{',
  '    [Fact]', `    public void Positive() => ${assertion};`, '',
  '    [Fact]', '    public void NotPositive() => Assert.Equal("not positive", Sign.Of(0));', '}', '',
].join('\n');

// Builds with the build-settings records, then runs the check on the given changed files.
function runCheck(...filenames) {
  const reportDir = path.join(repo, '.build-settings-report');
  fs.rmSync(reportDir, { recursive: true, force: true });
  const built = spawnSync('dotnet', ['build', 'Consumer.slnx', '-nologo', '-v:q',
    `-p:CustomAfterMicrosoftCommonTargets=${targetsFile}`, `-p:BuildSettingsReportDir=${reportDir}`], { cwd: repo, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const output = [];
  const { result } = check({
    records: readRecords(reportDir),
    changedFiles: filenames.map(filename => ({ filename, status: 'modified' })),
    repoRoot: repo,
    work: path.join(repo, '.mutation'),
    runStryker: (args, cwd) => {
      const run = spawnSync(stryker, args, { cwd, encoding: 'utf8' });
      output.push(run.stdout + run.stderr);
      return run;
    },
  });
  return { result, output: output.join('\n') };
}

describe('mutation check with Stryker', { timeout: 900_000 }, () => {
  before(() => {
    fs.mkdirSync(workFolder, { recursive: true });
    stryker = installStryker(path.join(workFolder, `stryker-${STRYKER_VERSION}`));
    repo = fs.mkdtempSync(path.join(workFolder, 'mutation-'));
    fs.cpSync(path.join(harnessRoot, 'samples/consumer'), repo, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });
    // A stryker-config.json in the product that would pass anything. The check must ignore it.
    writeFile('src/Consumer/stryker-config.json', '{ "stryker-config": { "mutate": ["!**/*.cs"] } }');
    writeFile('src/Consumer/Sign.cs', [
      'namespace Consumer;', '', 'public static class Sign', '{',
      '    public static string Of(int value) => value > 0 ? "positive" : "not positive";', '}', '',
    ].join('\n'));
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('a changed file with tests that pin its behaviour passes', () => {
    writeFile('tests/Consumer.UnitTests/SignTests.cs', signTests('Assert.Equal("positive", Sign.Of(1))'));
    const { result, output } = runCheck('src/Consumer/Sign.cs');
    assert.equal(result.passed, true, result.lines.join('\n') + output);
    assert.match(result.lines[0], /Mutation score 100\.00%/);
  });

  test('weakening an assertion fails, even when the PR changes only the test', () => {
    writeFile('tests/Consumer.UnitTests/SignTests.cs', signTests('Assert.NotNull(Sign.Of(1))'));
    const { result, output } = runCheck('tests/Consumer.UnitTests/SignTests.cs');
    assert.equal(result.passed, false, output);
    assert.match(result.lines.join('\n'), /src\/Consumer\/Sign\.cs,line=5::Survived/);
    assert.match(result.lines.join('\n'), /::error::Mutation score .* the threshold is 75%/);
  });
});
