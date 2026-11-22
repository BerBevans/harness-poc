// Step 4b: in a factory run the hooks run dotnet only in the build container, never on the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINER_BUDGET_SECONDS, dotnetRunner } from '../lib/dotnet.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArguments, CHECKS_SCRIPT, splitChecks, testArguments, unchangedFromBase } from '../lib/stop-dependencies.mjs';
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

test('the Stop hook can run several steps in one container through another entrypoint', () => {
  const { calls, runContainer } = fakeContainer();
  dotnetRunner(ENV, { runContainer, image: () => 'img', now: () => 0 })('/repo', ['-c', 'script'], 60, { entrypoint: 'bash' });
  assert.equal(calls[0].entrypoint, 'bash');
  assert.deepEqual(calls[0].args, ['-c', 'script']);
});

test('the checks container\'s output splits at its status lines; a step without one failed', () => {
  const projects = ['A.UnitTests.csproj', 'B.ArchitectureTests.csproj'];
  assert.deepEqual(splitChecks('built\n@@factory 0\nA passed\n@@factory 0\nB failed\n@@factory 1\n', projects), {
    build: { ok: true, output: 'built\n' },
    tests: [{ ok: true, output: '\nA passed\n' }, { ok: false, output: '\nB failed\n' }],
  });
  assert.deepEqual(splitChecks('error CS1002\n@@factory 1\n', projects), { build: { ok: false, output: 'error CS1002\n' }, tests: [] });
  const timedOut = splitChecks('built\n@@factory 0\nA hung', projects);
  assert.equal(timedOut.tests.length, 1, 'steps after the unfinished one never ran');
  assert.equal(timedOut.tests[0].ok, false);
  assert.match(timedOut.tests[0].output, /A hung\nThis step didn't finish\./);
  assert.equal(splitChecks('dotnet ran for over 540 seconds', projects).build.ok, false);
  const removedRepo = 'built\n@@factory 0\nA\n@@factory 0\nB\n@@factory 0\nThe run created git repositories inside the repo (x/.git)';
  assert.deepEqual(splitChecks(removedRepo, projects, false), { build: { ok: false, output: removedRepo }, tests: [] }, 'a failure after the last step still fails');
  assert.equal(splitChecks(removedRepo, projects, true).build.ok, true);
});

test('the checks script runs the build, then each test project, with their own output', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-script-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'calls');
  // A dotnet that records its arguments, writes to stderr and fails when its command line matches FAIL.
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/sh\nprintf '%s\\037' "$@" >> '${log}'; echo >> '${log}'\necho "ran $2" >&2\ncase "$*" in *"$FAIL"*) exit 1;; esac\n`, { mode: 0o755 });
  const projects = ['tests/A b/A.UnitTests.csproj', 'B.ArchitectureTests.csproj', 'C.UnitTests.csproj'];
  const checks = fail => {
    fs.rmSync(log, { force: true });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAIL: fail };
    const result = spawnSync('sh', ['-c', CHECKS_SCRIPT, 'checks', 'App.slnx', ...projects], { env, encoding: 'utf8' });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\x1f').slice(0, -1)) : [];
    return { calls, ...splitChecks(result.stdout + result.stderr, projects) };
  };

  const green = checks('no-such-argument');
  assert.deepEqual(green.calls, [buildArguments('./App.slnx'), ...projects.map(p => testArguments(`./${p}`))]);
  assert.deepEqual(green.build, { ok: true, output: 'ran ./App.slnx\n' }, 'stderr stays with its step');
  assert.deepEqual(green.tests.map(test => test.ok), [true, true, true]);
  assert.match(green.tests[0].output, /ran \.\/tests\/A b\/A\.UnitTests\.csproj/);

  const red = checks('build');
  assert.equal(red.calls.length, 1, 'no tests run after a failed build');
  assert.equal(red.build.ok, false);

  const middle = checks('B.Architecture');
  assert.deepEqual(middle.tests.map(test => test.ok), [true, false, true], 'a failing project does not stop the rest');
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
  const calls = [];
  const git = (head, status, statusOk = true) => args => {
    calls.push(args);
    return args[0] === 'rev-parse' ? { ok: true, stdout: `${head}\n` } : { ok: statusOk, stdout: status.join('\n') };
  };
  assert.equal(unchangedFromBase('/repo', base, git(base, ['?? .factory/run/output.md'])), true);
  assert.equal(unchangedFromBase('/repo', base, git(base, ['?? src/New.cs'])), false);
  assert.equal(unchangedFromBase('/repo', base, git('c'.repeat(40), [])), false);
  assert.equal(unchangedFromBase('/repo', undefined, git(base, [])), false);
  assert.equal(unchangedFromBase('/repo', base, git(base, [], false)), false, 'a failed status counts as changed');
  assert.ok(calls.some(args => args.includes('--no-renames')), 'a move out of .factory/ must show where it landed');
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
