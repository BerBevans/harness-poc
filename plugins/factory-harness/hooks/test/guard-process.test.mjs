// Runs guard.mjs as Claude Code would: JSON on stdin, decision on stdout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bash, edit, fakeContext, REPO } from './helpers.mjs';
import { evaluate } from '../guard.mjs';

const script = fileURLToPath(new URL('../guard.mjs', import.meta.url));
const run = (stdin, env = {}) =>
  spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: { ...process.env, FACTORY_ISSUE: '', ...env } });

test('denies with a PreToolUse decision', () => {
  const output = JSON.parse(run(JSON.stringify(bash('git push --force'))).stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('allows silently', () => {
  const result = run(JSON.stringify(bash('dotnet build')));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('fails closed on input that is not JSON', () => {
  const output = JSON.parse(run('not json').stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('fails closed on empty input', () => {
  const output = JSON.parse(run('').stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('with FACTORY_ISSUE, a denial points at the issue and the progress note', () => {
  const output = JSON.parse(run(JSON.stringify(bash('git push --force')), { FACTORY_ISSUE: '42' }).stdout);
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /comment on issue #42/);
  assert.match(reason, /\.factory\/progress\.md/);
});

test('without FACTORY_ISSUE, a denial tells the agent to explain to the user', () => {
  const reason = evaluate(edit(`${REPO}\\.editorconfig`, 'a', 'b'), fakeContext());
  assert.match(reason, /Stop and tell the user/);
  assert.doesNotMatch(reason, /issue #/);
});
