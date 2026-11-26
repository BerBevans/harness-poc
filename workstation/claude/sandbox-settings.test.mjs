// Run with: node --test "workstation/claude/*.test.mjs"
// Pins the sandbox fragment exactly, so any loosening has to change this test too and shows in review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('./sandbox-settings.json', import.meta.url), 'utf8'));
const { sandbox } = settings;
const { filesystem, network } = sandbox;
const twinWindows = '/mnt/c/Users/<windows-user>/.claude/twin';
const sorted = list => [...list].sort();

test('the sandbox is on, required, and has no escape hatch or weakening switch', () => {
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  for (const key of ['excludedCommands', 'allowNestedUserNamespaces', 'enableWeakerNestedSandbox', 'enableWeakerNetworkIsolation', 'ignoreViolations']) {
    assert.equal(sandbox[key], undefined, key);
  }
  assert.equal(filesystem.disabled, undefined);
});

test('writable paths are exactly the agreed ones', () => {
  assert.deepEqual(sorted(filesystem.allowWrite), sorted(['~/.npm', '~/.cache/agent-nuget', '~/.claude/twin', twinWindows]));
  assert.deepEqual(settings.permissions.additionalDirectories, ['~/src/harness-journal']);
});

test('the git guardrails and every writable repo\'s git hooks and config are denied', () => {
  const repos = ['~/.claude/twin', twinWindows, ...settings.permissions.additionalDirectories];
  const expected = ['~/.gitconfig', '~/.config/git', ...repos.flatMap(r => [`${r}/.git/hooks`, `${r}/.git/config`])];
  assert.deepEqual(sorted(filesystem.denyWrite), sorted(expected));
});

test('credentials the agent does not need are unreadable', () => {
  assert.deepEqual(sorted(filesystem.denyRead), sorted(['~/.ssh', '~/.aws', '~/.azure', '~/.claude/.credentials.json']));
});

test('the network allows exactly GitHub, NuGet and npm, and no local sockets', () => {
  assert.deepEqual(sorted(network.allowedDomains), sorted(['github.com', 'api.github.com', '*.githubusercontent.com', 'api.nuget.org', 'registry.npmjs.org']));
  for (const key of ['allowUnixSockets', 'allowAllUnixSockets', 'allowLocalBinding']) assert.equal(network[key], undefined, key);
});

test('NuGet uses the agent-only cache', () => {
  for (const name of ['NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH']) {
    assert.match(settings.env[name], /^\/home\/<user>\/\.cache\/agent-nuget\//, name);
  }
});
