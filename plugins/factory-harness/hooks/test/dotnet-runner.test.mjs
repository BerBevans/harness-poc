// Step 4b: in a factory run the hooks run dotnet only in the build container, never on the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINER_BUDGET_SECONDS, dotnetRunner } from '../lib/dotnet.mjs';
import { unchangedFromBase } from '../lib/stop-dependencies.mjs';
import { formatBeforeCommit } from '../format-on-commit.mjs';
import { decideStop } from '../verify-before-stop.mjs';

const ENV = { FACTORY_DOTNET: 'container', FACTORY_BASE_SHA: 'a'.repeat(40), PATH: '/bin', GITHUB_ENV: '/runner/env', GITHUB_OUTPUT: '/runner/out' };

function fakeContainer(result = { passed: true, lines: [], output: 'Build succeeded.' }) {
  const calls = [];
  const runContainer = options => { calls.push(options); if (result instanceof Error) throw result; return result; };
  return { calls, runContainer };
}

test('in a factory run, dotnet runs in the container with output captured', () => {
  const { calls, runContainer } = fakeContainer();
  const dotnet = dotnetRunner(ENV, { runContainer, image: () => 'sdk@sha256:x', now: () => 0 });
  assert.deepEqual(dotnet('/repo', ['build', 'App.slnx'], 300), { ok: true, output: 'Build succeeded.' });
  assert.deepEqual({ ...calls[0], env: undefined }, { image: 'sdk@sha256:x', repo: '/repo', args: ['build', 'App.slnx'], capture: true, timeout: 300000, env: undefined });
});

test('Docker gets the session environment without the runner file commands', () => {
  const { calls, runContainer } = fakeContainer();
  dotnetRunner(ENV, { runContainer, image: () => 'img', now: () => 0 })('/repo', ['build'], 60);
  assert.equal(calls[0].env.PATH, '/bin');
  assert.equal(calls[0].env.GITHUB_ENV, undefined);
  assert.equal(calls[0].env.GITHUB_OUTPUT, undefined);
});

test('every call shares one deadline under the Stop hook\'s limit, and none starts after it', () => {
  let clock = 0;
  const { calls, runContainer } = fakeContainer();
  const dotnet = dotnetRunner(ENV, { runContainer, image: () => 'img', now: () => clock });
  clock = (CONTAINER_BUDGET_SECONDS - 100) * 1000;
  dotnet('/repo', ['test', 'A.UnitTests.csproj'], 120);
  assert.equal(calls[0].timeout, 100000);
  clock = CONTAINER_BUDGET_SECONDS * 1000;
  assert.deepEqual(dotnet('/repo', ['test', 'B.UnitTests.csproj'], 120), { ok: false, output: 'The Stop hook ran out of time before this step.' });
  assert.equal(calls.length, 1);
  assert.ok(CONTAINER_BUDGET_SECONDS < 600);
});

test('a container that can\'t run, or an image that can\'t be resolved, is a failed check with no host fallback', () => {
  const docker = dotnetRunner(ENV, { ...fakeContainer(new Error("Docker couldn't start: ENOENT")), image: () => 'img' });
  assert.match(docker('/repo', ['build'], 60).output, /couldn't run in its container \(Docker couldn't start: ENOENT\)\. A factory run never falls back/);
  const image = dotnetRunner(ENV, { ...fakeContainer(), image: () => { throw new Error('global.json pins 10.0.404'); } });
  assert.equal(image('/repo', ['build'], 60).ok, false);
});

test('the worktree is unchanged from the base only at the base commit, with nothing but factory files changed', () => {
  const base = 'b'.repeat(40);
  const git = (head, status) => (root, args) => (args[0] === 'rev-parse' ? [head] : status);
  assert.equal(unchangedFromBase('/repo', base, git(base, ['?? .factory/run/output.md'])), true);
  assert.equal(unchangedFromBase('/repo', base, git(base, ['?? src/New.cs'])), false);
  assert.equal(unchangedFromBase('/repo', base, git('c'.repeat(40), [])), false);
  assert.equal(unchangedFromBase('/repo', undefined, git(base, [])), false);
});

test('the Stop hook checks nothing when the worktree is the base commit', () => {
  let built = false;
  const deps = { env: {}, repoRoot: () => '/repo', unchangedFromBase: () => true, findSolution: () => { built = true; return 'App.slnx'; } };
  assert.equal(decideStop({}, deps), null);
  assert.equal(built, false);
});

test('the format hook skips in a factory run, so dotnet format never runs on the host', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, cwd: '/nonexistent' };
  assert.equal(formatBeforeCommit(input, { FACTORY_DOTNET: 'container' }), null);
});

test('container paths under /src read as the repo\'s, so the Stop hook can make them relative', () => {
  const output = '/src/src/App/A.cs(3,1): error CS1031 [/src/src/App/App.csproj]\nsee docs/src/notes';
  const dotnet = dotnetRunner(ENV, { ...fakeContainer({ passed: false, lines: [], output }), image: () => 'img' });
  assert.equal(dotnet('/repo', ['build'], 60).output, '/repo/src/App/A.cs(3,1): error CS1031 [/repo/src/App/App.csproj]\nsee docs/src/notes');
});
