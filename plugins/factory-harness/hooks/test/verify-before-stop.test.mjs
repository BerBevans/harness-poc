import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStop, isValidProgressNote, MAX_FAILURE_CHARACTERS } from '../verify-before-stop.mjs';

function fakeDependencies(overrides = {}) {
  const calls = { builds: 0, savedGreen: null };
  const deps = {
    env: {},
    repoRoot: () => '/repo',
    findSolution: () => 'App.slnx',
    fingerprint: () => 'state-2',
    lastGreen: () => 'state-1',
    saveGreen: (_, value) => { calls.savedGreen = value; },
    runBuild: () => { calls.builds += 1; return { ok: true, output: '' }; },
    findTestProjects: () => ['tests/App.UnitTests/App.UnitTests.csproj'],
    runTests: () => ({ ok: true, output: '' }),
    readProgressNote: () => null,
    hasUncommittedChanges: () => false,
    ...overrides,
  };
  return { deps, calls };
}

const failingBuild = { runBuild: () => ({ ok: false, output: 'src/A.cs(3,1): error CS1002: ; expected [src/App.csproj]' }) };
const failingTest = { runTests: () => ({ ok: false, output: '  Failed App.UnitTests.AddsTask [3 ms]\n  Error Message:\n   Expected 1\n  Stack Trace:\n   at X' }) };

test('allows when Claude is already continuing because of a stop hook', () => {
  const { deps, calls } = fakeDependencies(failingBuild);
  assert.equal(decideStop({ stop_hook_active: true }, deps), null);
  assert.equal(calls.builds, 0);
});

test('allows outside a git repo or without a solution', () => {
  assert.equal(decideStop({}, fakeDependencies({ repoRoot: () => null }).deps), null);
  assert.equal(decideStop({}, fakeDependencies({ findSolution: () => null }).deps), null);
});

test('allows without building when nothing changed since the last green run', () => {
  const { deps, calls } = fakeDependencies({ lastGreen: () => 'state-2' });
  assert.equal(decideStop({}, deps), null);
  assert.equal(calls.builds, 0);
});

test('allows and records the state when everything passes', () => {
  const { deps, calls } = fakeDependencies();
  assert.equal(decideStop({}, deps), null);
  assert.equal(calls.savedGreen, 'state-2');
});

test('warns the user when there are no fast test projects to run', () => {
  const output = decideStop({}, fakeDependencies({ findTestProjects: () => [] }).deps);
  assert.match(output.systemMessage, /no \*\.UnitTests or \*\.ArchitectureTests projects/);
});

test('blocks a red build with the compiler error and the next step', () => {
  const output = decideStop({}, fakeDependencies(failingBuild).deps);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /error CS1002/);
  assert.match(output.reason, /tell the user what is blocking you/);
});

test('blocks failing tests with the test name and message but no stack trace', () => {
  const output = decideStop({}, fakeDependencies(failingTest).deps);
  assert.match(output.reason, /App\.UnitTests\.AddsTask/);
  assert.match(output.reason, /Expected 1/);
  assert.doesNotMatch(output.reason, /at X/);
});

test('does not record a failing state as green', () => {
  const { deps, calls } = fakeDependencies(failingTest);
  decideStop({}, deps);
  assert.equal(calls.savedGreen, null);
});

test('with FACTORY_ISSUE, a block points at the issue', () => {
  const { deps } = fakeDependencies({ ...failingBuild, env: { FACTORY_ISSUE: '42' } });
  assert.match(decideStop({}, deps).reason, /comment on issue #42/);
});

test('caps the failure details', () => {
  const huge = Array.from({ length: 2000 }, (_, i) => `src/A.cs(${i},1): error CS0103: name ${i} missing`).join('\n');
  const output = decideStop({}, fakeDependencies({ runBuild: () => ({ ok: false, output: huge }) }).deps);
  assert.ok(output.reason.length < MAX_FAILURE_CHARACTERS + 1000);
  assert.match(output.reason, /truncated/);
});

test('allows a red stop when a valid progress note is committed', () => {
  const { deps } = fakeDependencies({ ...failingBuild, readProgressNote: () => 'Status: blocked: awaiting answer\nGot as far as X.' });
  assert.equal(decideStop({}, deps), null);
});

test('asks for a commit when a valid progress note exists but work is uncommitted', () => {
  const { deps } = fakeDependencies({
    ...failingBuild,
    readProgressNote: () => 'Status: paused: work in progress',
    hasUncommittedChanges: () => true,
  });
  const output = decideStop({}, deps);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Commit your work in progress/);
});

test('an invalid progress note does not excuse a red build', () => {
  const { deps } = fakeDependencies({ ...failingBuild, readProgressNote: () => 'Status: done, honest' });
  assert.equal(decideStop({}, deps).decision, 'block');
});

test('progress note statuses', () => {
  assert.ok(isValidProgressNote('# Progress\n\nStatus: blocked: awaiting answer\n'));
  assert.ok(isValidProgressNote('status: Paused: work in progress'));
  assert.ok(!isValidProgressNote('Status: finished'));
  assert.ok(!isValidProgressNote(''));
  assert.ok(!isValidProgressNote(null));
});
