// Runs the Stop and format hooks as processes against a copy of samples/consumer.
// Needs git and the .NET SDK, and takes a minute or two, so it runs separately:
//   node --test "test/integration/*.test.mjs"

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksFolder = fileURLToPath(new URL('../../', import.meta.url));
const harnessRoot = path.resolve(hooksFolder, '../../..');
const sampleFolder = path.join(harnessRoot, 'samples/consumer');
// Not %TEMP%: Windows Smart App Control blocks loading freshly built DLLs from there.
const workFolder = process.env.HARNESS_TEST_WORK_DIR || path.join(harnessRoot, '.test-work');
const calculator = 'src/Consumer/Calculator.cs';
const greenCalculator = 'namespace Consumer;\n\npublic static class Calculator\n{\n    public static int Add(int left, int right) => left + right;\n}\n';

let repo;
let pluginData;

const git = (...args) => {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const writeFile = (relative, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), text);
};
const readFile = relative => fs.readFileSync(path.join(repo, relative), 'utf8');

function runHook(script, input) {
  const result = spawnSync(process.execPath, [path.join(hooksFolder, script)], {
    input: JSON.stringify({ cwd: repo, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: pluginData, FACTORY_ISSUE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
const stop = (input = {}) => runHook('verify-before-stop.mjs', { hook_event_name: 'Stop', ...input });
const commit = command => runHook('format-on-commit.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

function resetToGreen() {
  git('reset', '--hard', 'HEAD');
  git('clean', '-fdq', '-e', 'bin', '-e', 'obj');
}

describe('sample consumer', { timeout: 600_000 }, () => {
  before(() => {
    fs.mkdirSync(workFolder, { recursive: true });
    repo = fs.mkdtempSync(path.join(workFolder, 'sample-'));
    pluginData = fs.mkdtempSync(path.join(workFolder, 'data-'));
    fs.cpSync(sampleFolder, repo, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });
    git('init', '-q', '-b', 'feature/1-sample');
    git('add', '.');
    git('-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-qm', 'Sample consumer');
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  });

  test('allows a green stop and remembers it', () => {
    assert.equal(stop(), null);
    assert.equal(fs.readdirSync(pluginData).filter(f => f.startsWith('last-green-')).length, 1);
    assert.equal(stop(), null);
  });

  test('blocks a stop on a compile error, with a repo-relative location', () => {
    writeFile(calculator, greenCalculator.replace('=> left + right;', '=> missing;'));
    const output = stop();
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /src[\\/]Consumer[\\/]Calculator\.cs\(\d+,\d+\): error CS0103/);
    assert.doesNotMatch(output.reason, new RegExp(path.basename(repo)));
  });

  test('never refuses twice in a row', () => {
    assert.equal(stop({ stop_hook_active: true }), null);
  });

  test('blocks a stop on a failing unit test, with the assertion', () => {
    writeFile(calculator, greenCalculator.replace('left + right', 'left - right'));
    const output = stop();
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /CalculatorTests\.AddsTwoNumbers/);
    assert.match(output.reason, /Expected: 5/);
  });

  test('with a progress note, asks for a commit and then allows the stop', () => {
    writeFile('.factory/progress.md', 'Status: paused: work in progress\n\nSubtraction half done.\n');
    assert.match(stop().reason, /Commit your work in progress/);

    git('add', '.');
    git('-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-qm', 'WIP');
    assert.equal(stop(), null);
    git('reset', '-q', '--hard', 'HEAD~1');
  });

  test('formats staged files on commit and denies so they can be re-staged', () => {
    resetToGreen();
    writeFile(calculator, 'namespace Consumer\n{\npublic static class Calculator\n{\n  public static int Add(int left,int right)=>left+right;\n}\n}\n');
    git('add', calculator);

    const output = commit('git commit -m "Reformat me"');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /src\/Consumer\/Calculator\.cs/);
    assert.match(readFile(calculator), /^namespace Consumer;/m);
    assert.match(readFile(calculator), / {4}public static int Add\(int left, int right\) => left \+ right;/);
  });

  test('allows a commit of files that are already formatted', () => {
    git('add', calculator);
    assert.equal(commit('git commit -m "Formatted"'), null);
  });
});
