// Runs the real Stop hook as a process in factory mode, with fake dotnet and docker on PATH, to
// prove every dotnet call goes to the container and none runs on the host (step 4b).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stopHook = fileURLToPath(new URL('../verify-before-stop.mjs', import.meta.url));

test('in a factory run the Stop hook runs dotnet only through docker', { skip: process.platform === 'win32' && 'needs POSIX shell scripts' }, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-container-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const bin = path.join(work, 'bin');
  const marker = path.join(work, 'host-dotnet-ran');
  const dockerLog = path.join(work, 'docker.log');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);

  // A host dotnet that must never run, and a docker that logs its arguments and lists one project.
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> '${dockerLog}'\ncase "$*" in *" sln "*) echo src/A/A.csproj;; esac\n`, { mode: 0o755 });

  const git = (...args) => assert.equal(spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'App.slnx'), '<Solution />\n');
  fs.writeFileSync(path.join(repo, 'global.json'), '{ "sdk": { "version": "10.0.404" } }\n');
  fs.writeFileSync(path.join(repo, 'Dockerfile'), `FROM mcr.microsoft.com/dotnet/sdk:10.0.404-noble@sha256:${'0'.repeat(64)} AS build\n`);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'New.cs'), 'class N {}\n');

  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CI: 'true',
    FACTORY_DOTNET: 'container', FACTORY_BASE_SHA: base, CLAUDE_PLUGIN_DATA: path.join(work, 'data'),
  };
  const result = spawnSync(process.execPath, [stopHook], { input: JSON.stringify({ cwd: repo }), env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false, 'host dotnet ran');
  const calls = fs.readFileSync(dockerLog, 'utf8');
  assert.match(calls, /^run .* sln App\.slnx list$/m);
  // The build and the tests run in one container, so the tests can use the packages the build restored.
  assert.match(calls, /^run .* --entrypoint bash .* -c solution=/m);
  assert.match(calls, /^done checks App\.slnx$/m);
  assert.match(calls, /^ps --all --quiet --filter name=\^factory-dotnet-$/m, 'leftover containers are removed first');
  assert.match(calls, /^rm --force factory-dotnet-/m);
  assert.match(calls, new RegExp(`sdk:10\\.0\\.404-noble@sha256:${'0'.repeat(64)}`), 'the image comes from the base commit');
});
