import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dockerArguments, dotnetArguments, parseRequest, readAtCommit, removeLeftoverContainers, removeNestedRepos, resolveImage, runInContainer, sdkImage } from '../dotnet.mjs';

const SHA = 'c'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;
const dockerfile = tag => `# syntax=docker/dockerfile:1\nFROM mcr.microsoft.com/dotnet/sdk:${tag}@${DIGEST} AS build\nWORKDIR /src\nFROM mcr.microsoft.com/dotnet/aspnet:10.0@${DIGEST}\n`;
const globalJson = version => JSON.stringify({ sdk: { version, rollForward: 'disable' } });

test('build and test take only a project and, for test, a filter', () => {
  assert.deepEqual(parseRequest(['build']), { command: 'build', project: null, filter: null });
  assert.deepEqual(parseRequest(['test', 'tests/App.UnitTests', '--filter', 'Category=Fast']),
    { command: 'test', project: 'tests/App.UnitTests', filter: 'Category=Fast' });
  assert.deepEqual(dotnetArguments(parseRequest(['test', '--filter', 'Name~Sign', 'App.sln'])), ['test', 'App.sln', '--filter', 'Name~Sign']);
});

test('anything that could change what runs is refused', () => {
  for (const argv of [[], ['restore'], ['run'], ['build', '-p:RunAnalyzers=false'], ['test', '--settings', 'x.runsettings'],
    ['test', '--logger', 'trx'], ['build', '--filter', 'x'], ['test', '--filter'], ['test', '--filter', '--no-build'],
    ['build', 'a.csproj', 'b.csproj'], ['build', '/etc/x.csproj'], ['build', '../other/x.csproj'], ['build', 'src\\..\\..\\x.csproj'], ['build', '@opts.rsp'], ['test', '@opts.rsp']]) {
    assert.throws(() => parseRequest(argv), /Usage|isn't allowed/, argv.join(' '));
  }
});

test('the image is the build stage pinned by digest to the global.json SDK', () => {
  assert.equal(sdkImage(dockerfile('10.0.404-noble'), globalJson('10.0.404')), `mcr.microsoft.com/dotnet/sdk:10.0.404-noble@${DIGEST}`);
  assert.equal(sdkImage(dockerfile('10.0.404'), globalJson('10.0.404')), `mcr.microsoft.com/dotnet/sdk:10.0.404@${DIGEST}`);
  assert.throws(() => sdkImage(dockerfile('10.0.405-noble'), globalJson('10.0.404')), /10\.0\.405-noble, but global\.json asks for 10\.0\.404/);
  assert.throws(() => sdkImage(dockerfile('10.0.4040'), globalJson('10.0.404')), /global\.json asks for/);
  assert.throws(() => sdkImage('FROM mcr.microsoft.com/dotnet/sdk:10.0.404 AS build', globalJson('10.0.404')), /no "FROM/);
  assert.throws(() => sdkImage(dockerfile('10.0.404').replace('AS build', 'AS compile'), globalJson('10.0.404')), /no "FROM/);
});

test('in CI the image comes from the base commit, never the worktree', () => {
  const reads = [];
  const read = (repo, sha, file) => { reads.push(`${sha}:${file}`); return file === 'Dockerfile' ? dockerfile('10.0.404') : globalJson('10.0.404'); };
  assert.match(resolveImage({ CI: 'true', FACTORY_BASE_SHA: SHA }, '/repo', read), /sdk:10\.0\.404@/);
  assert.deepEqual(reads, [`${SHA}:Dockerfile`, `${SHA}:global.json`]);
  assert.throws(() => resolveImage({ CI: 'true' }, '/repo', read), /FACTORY_BASE_SHA is empty/);
});

test('a committed file is read with plumbing and no global or system git config', () => {
  let call;
  const run = (program, args, options) => { call = { program, args, env: options.env }; return { status: 0, stdout: 'x', stderr: '' }; };
  assert.equal(readAtCommit('/repo', SHA, 'Dockerfile', run), 'x');
  assert.deepEqual(call.args, ['-C', '/repo', 'cat-file', 'blob', `${SHA}:Dockerfile`]);
  assert.equal(call.env.GIT_NO_REPLACE_OBJECTS, '1');
  for (const sha of ['HEAD', 'main', '-p', 'abc123']) assert.throws(() => readAtCommit('/repo', sha, 'Dockerfile', run), /full commit SHA/, sha);
  assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('the container gets no host environment, a read-only .git and the caller\'s user', () => {
  const args = dockerArguments({ image: 'img', repo: '/repo', uid: 1001, gid: 118, name: 'factory-dotnet-1', args: ['build'] });
  const joined = args.join(' ');
  assert.match(joined, /--user 1001:118 /);
  assert.match(joined, /^run --rm --name factory-dotnet-1 /);
  assert.match(joined, /--mount type=bind,src=\/repo,dst=\/src --mount type=bind,src=\/repo\/\.git,dst=\/src\/\.git,readonly /);
  assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges /);
  assert.match(joined, / --read-only --tmpfs \/tmp:exec,size=4g /);
  assert.deepEqual(args.slice(-4), ['--entrypoint', 'dotnet', 'img', 'build']);
  assert.ok(!args.some(arg => /^--(env-file|pid|privileged|network|ipc|uts)(=|$)|docker\.sock/.test(arg)));
  const passed = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1].split('=')[0]] : []));
  assert.deepEqual(passed, ['HOME', 'DOTNET_CLI_HOME', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE', 'NUGET_PACKAGES']);
});

test('a run that times out is stopped, reported as a failure, and its container removed', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-wrapper-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.git'));
  const calls = [];
  const run = (program, args, options) => {
    calls.push(args);
    return args[0] === 'run' ? { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) } : { status: 0 };
  };
  const result = runInContainer({ image: 'img', repo, args: ['test'], run, timeout: 60000 });
  assert.deepEqual(result, { passed: false, lines: ['dotnet ran for over 60 seconds, so it was stopped.'], output: '' });
  const name = calls[0][calls[0].indexOf('--name') + 1];
  assert.match(name, /^factory-dotnet-/);
  assert.deepEqual(calls[1], ['rm', '--force', name]);
});

// In CI a missing Docker must fail the isolation test, never skip it, or the proof silently goes away.
export const dockerVerdict = ({ ci, available }) => (available ? 'run' : ci ? 'fail' : 'skip');

test('the isolation test fails without Docker in CI and skips only locally', () => {
  assert.equal(dockerVerdict({ ci: 'true', available: false }), 'fail');
  assert.equal(dockerVerdict({ ci: undefined, available: false }), 'skip');
  assert.equal(dockerVerdict({ ci: 'true', available: true }), 'run');
});

// Multi-arch index, so it runs on arm64 locally and x86_64 in CI.
const BUSYBOX = 'busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec';

test('code in the container can\'t see the host environment or write to .git', t => {
  const verdict = dockerVerdict({ ci: process.env.CI, available: spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 });
  if (verdict === 'fail') assert.fail('Docker is required in CI: the isolation test must run.');
  if (verdict === 'skip') return t.skip('Docker isn\'t running. Start Docker Desktop to run the isolation test.');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-wrapper-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const canary = `CANARY${process.pid}${Date.now()}`;
  process.env.FACTORY_CANARY = canary;
  t.after(() => delete process.env.FACTORY_CANARY);

  const script = [
    'env > /src/env.txt',
    'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" > /src/proc.txt',
    'ls -d /proc/[0-9]* | wc -l > /src/processes.txt',
    'id -u > /src/uid.txt',
    'if touch /src/.git/planted 2>/dev/null; then echo writable; else echo read-only; fi > /src/git.txt',
    'if touch /planted 2>/dev/null; then echo writable; else echo read-only; fi > /src/root.txt',
  ].join('; ');
  const result = runInContainer({ image: BUSYBOX, repo, entrypoint: 'sh', args: ['-c', script] });
  assert.equal(result.passed, true, result.lines.join('\n'));

  const read = name => fs.readFileSync(path.join(repo, name), 'utf8');
  assert.ok(!read('env.txt').includes(canary) && !read('proc.txt').includes(canary), 'the host canary reached the container');
  assert.match(read('env.txt'), /^HOME=\/tmp$/m, 'positive control: a value the wrapper passes must be visible');
  assert.ok(Number(read('processes.txt')) < 10, 'host processes are visible');
  assert.equal(read('uid.txt').trim(), String(process.getuid()));
  assert.equal(fs.statSync(path.join(repo, 'uid.txt')).uid, process.getuid(), 'files the container writes must belong to the caller');
  assert.equal(read('git.txt').trim(), 'read-only');
  assert.equal(read('root.txt').trim(), 'read-only', 'the image itself must not be writable');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'planted')));
});

test('with capture, the output is collected and Docker gets only the environment given', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-capture-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const calls = [];
  const run = (program, args, options) => {
    calls.push({ args, options });
    return args[0] === 'run' ? { status: 1, stdout: 'Build FAILED.\n', stderr: 'error CS1002' } : { status: 0 };
  };
  const result = runInContainer({ image: 'img', repo, args: ['build'], run, capture: true, timeout: 5000, env: { PATH: '/bin' } });
  assert.deepEqual(result, { passed: false, lines: ['dotnet exited with 1.'], output: 'Build FAILED.\nerror CS1002' });
  assert.deepEqual(calls[0].options, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL', env: { PATH: '/bin' } });
  assert.equal(calls[1].args[0], 'rm');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('every .git in the repo but its own is removed, and links are never followed', t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const outside = path.join(work, 'outside');
  for (const folder of ['.git/hooks', 'src/x/.git/hooks', 'b/c', 'bin/Debug', outside + '/.git']) fs.mkdirSync(path.isAbsolute(folder) ? folder : path.join(repo, folder), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/x/.git/config'), '[core]\n\tfsmonitor = ./evil.sh\n');
  fs.writeFileSync(path.join(repo, 'b/c/.git'), 'gitdir: ../../bin/Debug\n');
  fs.writeFileSync(path.join(repo, 'bin/Debug/.GIT'), '');
  fs.symlinkSync(outside, path.join(repo, 'linked'));
  fs.symlinkSync(path.join(outside, '.git'), path.join(repo, 'b/.git'));
  assert.deepEqual(removeNestedRepos(repo), { removed: ['b/.git', 'b/c/.git', 'bin/Debug/.GIT', 'src/x/.git'], unchecked: [] });
  assert.ok(fs.existsSync(path.join(repo, '.git/hooks')), 'the repo\'s own .git stays');
  assert.ok(fs.existsSync(path.join(outside, '.git')), 'a link is removed, never followed');
  assert.ok(fs.existsSync(path.join(repo, 'src/x')));
  assert.deepEqual(removeNestedRepos(repo), { removed: [], unchecked: [] });
});

test('a folder made unreadable is searched anyway, and so is everything after it', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a non-root user' }, t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-locked-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const folder of ['.git', 'aaa/.git', 'zzz/.git']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
  fs.chmodSync(path.join(repo, 'aaa'), 0);
  fs.chmodSync(path.join(repo, 'zzz/.git'), 0);
  assert.deepEqual(removeNestedRepos(repo), { removed: ['aaa/.git', 'zzz/.git'], unchecked: [] });
});

test('a run that creates a git repo in the repo fails, keeping its output, and the repo is removed', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-run-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.git'));
  const run = (program, args) => {
    if (args[0] === 'run') fs.mkdirSync(path.join(repo, 'x/.git'), { recursive: true });
    return { status: 0, stdout: 'Build succeeded.\n', stderr: '' };
  };
  const result = runInContainer({ image: 'img', repo, args: ['build'], run, capture: true });
  assert.equal(result.passed, false);
  assert.equal(result.output, 'Build succeeded.\n');
  assert.match(result.lines.at(-1), /created git repositories inside the repo \(x\/\.git\)/);
  assert.equal(fs.existsSync(path.join(repo, 'x/.git')), false);
});

test('a run that ends in an error, such as output past the capture limit, still removes nested repos', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-error-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.git'));
  const run = (program, args) => {
    if (args[0] === 'run') fs.mkdirSync(path.join(repo, 'x/.git'), { recursive: true });
    return args[0] === 'run' ? { status: null, error: Object.assign(new Error('spawnSync docker ENOBUFS'), { code: 'ENOBUFS' }) } : { status: 0 };
  };
  assert.throws(() => runInContainer({ image: 'img', repo, args: ['build'], run, capture: true }), /ENOBUFS/);
  assert.equal(fs.existsSync(path.join(repo, 'x/.git')), false);
});

test('leftover factory containers are removed, and nothing is run when there are none', () => {
  const calls = [];
  const run = ps => (program, args) => { calls.push(args); return { stdout: args[0] === 'ps' ? ps : '' }; };
  removeLeftoverContainers({ run: run('abc\ndef\n') });
  assert.deepEqual(calls, [['ps', '--all', '--quiet', '--filter', 'name=^factory-dotnet-'], ['rm', '--force', 'abc', 'def']]);
  calls.length = 0;
  removeLeftoverContainers({ run: run('') });
  assert.equal(calls.length, 1);
});
