// Run with: node --test "workstation/claude/*.test.mjs"
// The parser-based rules. guard-git-hooks.test.mjs is the regression suite kept from the
// pattern-matching guard; every case there must still hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, evaluate } from './guard-git-hooks.mjs';
import { blocked, allowed } from './guard-git-hooks.cases.mjs';

const env = { home: '/home/dev', termsFile: undefined };
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const reason = command => evaluate(bash(command), env);

for (const [name, command] of blocked) test(`blocks: ${name}`, () => assert.ok(reason(command), 'expected a denial reason'));
for (const [name, command] of allowed) test(`allows: ${name}`, () => assert.equal(reason(command), null));

test('denials that ask for a plain rewrite say so, the rest say stop', () => {
  assert.match(reason('eval "$cmd"'), /Write the command out plainly/);
  assert.match(reason('git commit -n -m x'), /tell the user/);
});

test('any error in the hook is a denial', () => {
  const broken = { get home() { throw new Error('no home'); } };
  assert.match(decide(bash('git status'), broken), /failed closed/);
});

test('Write to a nested .git/config is denied', () => {
  assert.ok(evaluate({ tool_name: 'Write', tool_input: { file_path: '/home/dev/src/r/nested/.git/config' } }, env));
});
