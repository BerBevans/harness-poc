import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, installStryker, mutate, strykerArguments } from '../run-mutation.mjs';

const root = path.resolve('/r');
const domain = { path: path.join(root, 'src/App.Domain/App.Domain.csproj'), isTestProject: false, assemblyName: 'App.Domain', references: [] };
const unitTests = { path: path.join(root, 'tests/App.UnitTests/App.UnitTests.csproj'), isTestProject: true, assemblyName: 'App.UnitTests', references: [domain.path] };
const run = files => ({ project: domain, files, testProjects: [unitTests] });

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A fake Stryker that writes the given mutants for Price.cs to the report.
const fakeStryker = (mutants, status = 0) => args => {
  const output = args[args.indexOf('--output') + 1];
  if (mutants) {
    fs.mkdirSync(path.join(output, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(output, 'reports', 'mutation-report.json'), JSON.stringify({
      projectRoot: path.dirname(domain.path),
      files: { [path.join(root, 'src/App.Domain/Price.cs')]: { mutants } },
    }));
  }
  return { status };
};
const mutant = (status, statusReason) => ({ status, statusReason, mutatorName: 'Equality mutation', location: { start: { line: 4 } } });

test('Stryker gets its own config, the unit test projects, and files relative to the project folder', () => {
  assert.deepEqual(strykerArguments(run(['src/App.Domain/Rules/Price.cs']), { repoRoot: root, configFile: '/w/c.json', output: '/w/App.Domain' }), [
    '--config-file', '/w/c.json', '--test-project', unitTests.path, '--mutate', 'Rules/Price.cs', '--reporter', 'json', '--output', '/w/App.Domain',
  ]);
  assert.ok(!strykerArguments(run(null), { repoRoot: root, configFile: 'c', output: 'o' }).includes('--mutate'));
});

test('each run writes its report to its own folder, and the config file is empty', t => {
  const work = tempDir(t);
  const reports = mutate({ runs: [run(['src/App.Domain/Price.cs'])], repoRoot: root, work, runStryker: fakeStryker([mutant('Killed')]) });
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'stryker-config.json'), 'utf8')), { 'stryker-config': {} });
});

test('a Stryker failure or a missing report is an error, not a pass', t => {
  const work = tempDir(t);
  assert.throws(() => mutate({ runs: [run(null)], repoRoot: root, work, runStryker: fakeStryker([], 1) }), /Stryker failed for App\.Domain, with exit code 1/);
  assert.throws(() => mutate({ runs: [run(null)], repoRoot: root, work, runStryker: fakeStryker(null) }), /no report for App\.Domain/);
});

test('mutants filtered out of a chosen file are an error, since Stryker did not mutate what it was asked to', t => {
  const work = tempDir(t);
  const filtered = fakeStryker([mutant('Ignored', 'Removed by mutate filter')]);
  assert.throws(() => mutate({ runs: [run(['src/App.Domain/Price.cs'])], repoRoot: root, work, runStryker: filtered }), /left out mutants in src\/App\.Domain\/Price\.cs/);
  assert.throws(() => mutate({ runs: [run(null)], repoRoot: root, work, runStryker: filtered }), /left out mutants/);
  // A file the check didn't choose is filtered out on purpose.
  assert.equal(mutate({ runs: [run(['src/App.Domain/Other.cs'])], repoRoot: root, work, runStryker: filtered }).length, 1);
});

test('only a low score can be overridden; an untestable project or nothing to mutate cannot', t => {
  const work = tempDir(t);
  const records = [domain, unitTests];
  const changed = [{ filename: 'src/App.Domain/Price.cs', status: 'modified' }];
  const low = check({ records, changedFiles: changed, repoRoot: root, work, runStryker: fakeStryker([mutant('Survived')]) });
  assert.deepEqual([low.result.passed, low.overridable], [false, true]);

  const untestable = check({ records: [domain, { ...unitTests, references: [] }], changedFiles: changed, repoRoot: root, work, runStryker: fakeStryker([]) });
  assert.deepEqual([untestable.result.passed, untestable.overridable], [false, false]);

  const docs = check({ records, changedFiles: [{ filename: 'docs/a.md', status: 'added' }], repoRoot: root, work, runStryker: () => assert.fail('ran Stryker') });
  assert.deepEqual([docs.result.passed, docs.overridable], [true, false]);
});

test('Stryker is installed at the pinned version only when it is not there already', t => {
  const toolDir = tempDir(t);
  const calls = [];
  assert.throws(() => installStryker(toolDir, args => { calls.push(args); return { status: 1, stderr: 'no network' }; }), /Installing Stryker 5\.0\.0 failed: no network/);
  assert.deepEqual(calls[0], ['tool', 'install', 'dotnet-stryker', '--version', '5.0.0', '--tool-path', toolDir]);
  fs.writeFileSync(path.join(toolDir, process.platform === 'win32' ? 'dotnet-stryker.exe' : 'dotnet-stryker'), '');
  installStryker(toolDir, () => assert.fail('installed again'));
});
