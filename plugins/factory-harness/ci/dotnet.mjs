// Builds or tests the product in a container, so the code an agent writes (MSBuild targets,
// analysers, tests) never runs on the host. On the host it could read CLAUDE_CODE_OAUTH_TOKEN from
// the environment or from another process's /proc/<pid>/environ; in the container there is no
// host environment, no host /proc, and `.git` is read-only, so it can't plant a git hook or config
// that host-side git would run later with a token.
//
// The image is the product Dockerfile's `build` stage, pinned by digest, which is a guardrail file
// that Dependabot bumps together with global.json. In CI it is read from the base commit, so an
// edit in the worktree can't change it.
//
// Usage: node dotnet.mjs build|test [project] [--filter <expression>]
// Environment: FACTORY_REPO (default: the current folder), FACTORY_BASE_SHA (required when CI is set).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runIfMain } from './lib/pull-request.mjs';

const USAGE = 'Usage: dotnet.mjs build|test [project] [--filter <expression>]';
const HOME = '/tmp/home';

/** The request from the command line. Anything but a command, one project and a test filter is refused. */
export function parseRequest(argv) {
  const [command, ...rest] = argv;
  if (command !== 'build' && command !== 'test') throw new Error(USAGE);
  const request = { command, project: null, filter: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--filter' && command === 'test' && request.filter === null && rest[i + 1] && !rest[i + 1].startsWith('-')) {
      request.filter = rest[++i];
    } else if (request.project === null && isProjectPath(arg)) {
      request.project = arg;
    } else {
      throw new Error(`"${arg}" isn't allowed. ${USAGE}. Other dotnet options can change what runs, so the wrapper doesn't take them.`);
    }
  }
  return request;
}

const isProjectPath = arg =>
  !arg.startsWith('-') && !path.isAbsolute(arg) && !arg.split(/[\\/]/).includes('..');

const IMAGE = /^\s*FROM\s+(\S+\/dotnet\/sdk:(\S+?)@sha256:[0-9a-f]{64})\s+AS\s+build\s*$/im;

/** The SDK image: the Dockerfile's build stage, which must be pinned by digest to the global.json SDK. */
export function sdkImage(dockerfile, globalJson) {
  const match = IMAGE.exec(dockerfile ?? '');
  if (!match) throw new Error('The Dockerfile has no "FROM <registry>/dotnet/sdk:<tag>@sha256:<digest> AS build" stage, so there is no pinned SDK image to build in.');
  const version = JSON.parse(globalJson).sdk?.version;
  const [, image, tag] = match;
  if (!version || !(tag === version || tag.startsWith(`${version}-`))) {
    throw new Error(`The Dockerfile's SDK image is ${tag}, but global.json asks for ${version}. Bump them together.`);
  }
  return image;
}

/** Reads a file as committed at `sha`, ignoring the worktree and any config that could run a command. */
export function readAtCommit(repo, sha, file, run = spawnSync) {
  const result = run('git', ['-C', repo, 'cat-file', 'blob', `${sha}:${file}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result.status !== 0) throw new Error(`Couldn't read ${file} at ${sha}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The dotnet command line inside the container. */
export function dotnetArguments({ command, project, filter }) {
  return [command, ...(project ? [project] : []), ...(filter ? ['--filter', filter] : [])];
}

/**
 * `docker run` arguments. Nothing from the host environment is passed: only the values set here.
 * The network stays on for NuGet restore.
 */
export function dockerArguments({ image, repo, uid, gid, entrypoint = 'dotnet', args }) {
  return [
    'run', '--rm',
    '--user', `${uid}:${gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024',
    '-e', `HOME=${HOME}`,
    '-e', 'DOTNET_CLI_TELEMETRY_OPTOUT=1',
    '-e', 'DOTNET_NOLOGO=1',
    '-e', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1',
    '-e', `NUGET_PACKAGES=${HOME}/.nuget/packages`,
    '-v', `${repo}:/src`,
    '-v', `${path.join(repo, '.git')}:/src/.git:ro`,
    '-w', '/src',
    '--entrypoint', entrypoint,
    image,
    ...args,
  ];
}

/** The image to use: from the base commit in CI, from the worktree locally. */
export function resolveImage(env, repo, read = readAtCommit) {
  if (env.CI && !env.FACTORY_BASE_SHA) throw new Error('FACTORY_BASE_SHA is empty, so the SDK image would come from the worktree, which the agent can edit.');
  const load = file => (env.FACTORY_BASE_SHA ? read(repo, env.FACTORY_BASE_SHA, file) : fs.readFileSync(path.join(repo, file), 'utf8'));
  return sdkImage(load('Dockerfile'), load('global.json'));
}

/** Runs the container with the terminal attached. Resolves to { passed, lines }. */
export function runInContainer({ image, repo, entrypoint, args, run = spawnSync }) {
  if (!fs.statSync(path.join(repo, '.git'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${repo} has no .git folder to mount read-only.`);
  }
  const result = run('docker', dockerArguments({ image, repo, uid: process.getuid(), gid: process.getgid(), entrypoint, args }), { stdio: 'inherit' });
  if (result.error) throw new Error(`Docker couldn't start: ${result.error.message}`);
  return { passed: result.status === 0, lines: result.status === 0 ? [] : [`dotnet exited with ${result.status}.`] };
}

await runIfMain(import.meta.url, env => {
  const request = parseRequest(process.argv.slice(2));
  const repo = path.resolve(env.FACTORY_REPO || '.');
  return runInContainer({ image: resolveImage(env, repo), repo, args: dotnetArguments(request) });
});
