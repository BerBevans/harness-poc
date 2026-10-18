// Run with: node --test hooks/claude
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate } from './guard-git-hooks.mjs';

const env = { home: 'C:\\Users\\dev', termsFile: undefined };
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const file = (tool_name, file_path) => ({ tool_name, tool_input: { file_path } });

const blocked = [
  ['--no-verify on commit', bash('git commit --no-verify -m "x"')],
  ['--no-verify on push', bash('git push --no-verify origin main')],
  ['-n on commit', bash('git commit -n -m "x"')],
  ['-n in a flag cluster', bash('git commit -anm "x"')],
  ['-n after global options', bash('git -C ../repo commit -n -m x')],
  ['-n in a chained command', bash('git add . && git commit -n -m x')],
  ['-n via git.exe path', bash('"/c/Program Files/Git/cmd/git.exe" commit -n')],
  ['hooksPath override', bash('git -c core.hooksPath=/dev/null commit -m x')],
  ['hooksPath unset', bash('git config --global --unset core.hooksPath')],
  ['hooksPath via env config', bash('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hookspath git commit')],
  ['terms env override', bash('GIT_BLOCKED_TERMS_FILE=/tmp/empty git commit -m x')],
  ['reading terms file', bash('cat ~/.config/git/blocked-terms.txt')],
  ['deleting a git hook', bash('rm ~/.config/git/hooks/pre-commit')],
  ['git bash home path', bash('sed -i d /c/Users/dev/.config/git/hooks/_lib.sh')],
  ['powershell home path', { tool_name: 'PowerShell', tool_input: { command: 'Remove-Item $env:USERPROFILE\\.config\\git\\hooks\\pre-push' } }],
  ['editing installed claude hook', bash('echo > ~/.claude/hooks/guard-git-hooks.mjs')],
  ['Read of terms file', file('Read', 'C:\\Users\\dev\\.config\\git\\blocked-terms.txt')],
  ['Edit of git hook', file('Edit', 'C:/Users/dev/.config/git/hooks/pre-commit')],
  ['Write of installed claude hook', file('Write', 'C:\\Users\\dev\\.claude\\hooks\\guard-git-hooks.mjs')],
  ['Write of ~/.gitconfig', file('Write', '~/.gitconfig')],
  ['Grep in git config dir', { tool_name: 'Grep', tool_input: { pattern: '.', path: '~/.config/git' } }],
  ['Glob on terms file', { tool_name: 'Glob', tool_input: { pattern: '**/blocked-terms*' } }],
];

const allowed = [
  ['plain commit', bash('git commit -m "Add -n flag handling"')],
  ['commit message value cluster', bash('git commit -mnotes')],
  ['git log -n', bash('git log -n 5 --grep commit')],
  ['push dry run -n', bash('git push -n origin main')],
  ['unrelated command', bash('dotnet test')],
  ['project .claude/hooks path', bash('ls .claude/hooks')],
  ['Read of ~/.gitconfig', file('Read', 'C:\\Users\\dev\\.gitconfig')],
  ['Read of installed claude hook', file('Read', 'C:\\Users\\dev\\.claude\\hooks\\guard-git-hooks.mjs')],
  ['Edit of project file', file('Edit', 'C:\\Development\\app\\Program.cs')],
];

for (const [name, input] of blocked) {
  test(`blocks: ${name}`, () => assert.ok(evaluate(input, env), 'expected a denial reason'));
}
for (const [name, input] of allowed) {
  test(`allows: ${name}`, () => assert.equal(evaluate(input, env), null));
}

test('blocks a custom terms file path from the environment', () => {
  const custom = { ...env, termsFile: 'D:\\secrets\\words.txt' };
  assert.ok(evaluate(bash('type D:\\secrets\\words.txt'), custom));
});

test('every denial tells the agent what to do instead', () => {
  for (const [, input] of blocked) assert.match(evaluate(input, env), /tell the user/);
});

const script = fileURLToPath(new URL('./guard-git-hooks.mjs', import.meta.url));
const run = stdin => spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8' });

test('process: denies with a PreToolUse decision', () => {
  const out = JSON.parse(run(JSON.stringify(bash('git commit -n'))).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('process: allows silently', () => {
  const r = run(JSON.stringify(bash('git status')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('process: fails closed on bad input', () => {
  const out = JSON.parse(run('not json').stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});
