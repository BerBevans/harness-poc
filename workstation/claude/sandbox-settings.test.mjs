// Run with: node --test "workstation/claude/*.test.mjs"
// Pins the sandbox fragment's safety settings so an edit can't loosen them unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { sandbox } = JSON.parse(readFileSync(new URL('./sandbox-settings.json', import.meta.url), 'utf8'));
const { allowWrite, denyWrite } = sandbox.filesystem;

test('the sandbox is on, required, and has no escape hatch', () => {
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.equal(sandbox.excludedCommands, undefined);
  assert.equal(sandbox.allowNestedUserNamespaces, undefined);
});

test('the git guardrails are never writable', () => {
  for (const path of ['~/.gitconfig', '~/.config/git']) assert.ok(denyWrite.includes(path), path);
  assert.ok(!allowWrite.some(p => /^~\/?$|\.config\/git|\.gitconfig|\.claude\/hooks/.test(p)));
});

test('every writable repo has its git hooks and config denied', () => {
  const repos = [...allowWrite.filter(p => p.endsWith('/twin')), '~/src/harness-journal'];
  for (const repo of repos) {
    for (const part of ['.git/hooks', '.git/config']) assert.ok(denyWrite.includes(`${repo}/${part}`), `${repo}/${part}`);
  }
});

test('the shared NuGet cache is not writable', () => {
  assert.ok(!allowWrite.some(p => p.includes('.nuget')));
});
