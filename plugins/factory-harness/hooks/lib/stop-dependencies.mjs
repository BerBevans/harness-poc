// The real git, dotnet and file-system operations behind the Stop hook. Kept apart from
// the decision logic so that logic can be tested quickly with fakes.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRESS_NOTE_PATH } from './next-step.mjs';
import { removeLeftoverContainers } from '../../ci/dotnet.mjs';
import { dockerEnvironment, dotnetRunner, inContainer } from './dotnet.mjs';
import { findSolution, gitLines, hashFile, run } from './process.mjs';

const FAST_TEST_PROJECT = /\.(UnitTests|ArchitectureTests)\.csproj$/i;
const SKIPPED_FOLDERS = new Set(['.git', 'bin', 'obj', 'node_modules', 'TestResults']);
const MAX_SEARCH_DEPTH = 6;
const BUILD_SECONDS = 300;
const TEST_SECONDS = 120;

const buildArguments = solution => ['build', solution, '-warnaserror', '-nologo', '-v:q', '-clp:NoSummary'];
// Quiet verbosity hides assertion messages; the console logger at normal brings them back.
const testArguments = project => ['test', project, '--no-build', '-nologo', '-v:q', '--logger', 'console;verbosity=normal'];

// In a container, the build and every test project run in one container: the packages the build
// restores live only in that container's /tmp, so a second container's `dotnet test --no-build`
// finds none, skips the project and exits 0. A status line follows each step. Code in the container
// could print a fake one, but it could as easily make its own tests pass: CI is the gate. The
// arguments match buildArguments and testArguments.
const CHECKS_SCRIPT = `solution="$1"; shift
dotnet build "$solution" -warnaserror -nologo -v:q -clp:NoSummary
status=$?; echo "@@factory $status"; [ "$status" -eq 0 ] || exit 0
for project in "$@"; do
  dotnet test "$project" --no-build -nologo -v:q --logger 'console;verbosity=normal'
  echo "@@factory $?"
done`;

/**
 * Splits the checks container's output at its status lines into the build's result and each test
 * project's. A step with no status line (the container timed out or died) failed.
 */
export function splitChecks(output, projects) {
  const parts = output.split(/^@@factory (\d+)\r?$/m);
  const steps = [];
  for (let i = 0; i + 1 < parts.length; i += 2) steps.push({ ok: parts[i + 1] === '0', output: parts[i] });
  const unfinished = { ok: false, output: `${parts.at(-1)}\nThis step didn't finish.`.trim() };
  const build = steps[0] ?? unfinished;
  if (!build.ok) return { build, tests: [] };
  return { build, tests: projects.map((_, i) => steps[i + 1] ?? unfinished) };
}

export function findTestProjects(root) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > MAX_SEARCH_DEPTH) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) visit(fullPath, depth + 1);
      else if (entry.isFile() && FAST_TEST_PROJECT.test(entry.name)) found.push(path.relative(root, fullPath));
    }
  };
  visit(root, 0);
  return found.sort();
}

/** Identifies the exact state of the working tree: commit, uncommitted diff and untracked files. */
export function fingerprint(root) {
  const hash = createHash('sha256');
  hash.update(run('git', ['-C', root, 'rev-parse', 'HEAD']).stdout);
  hash.update(run('git', ['-C', root, 'diff', 'HEAD', '--binary']).stdout);
  for (const file of gitLines(root, ['ls-files', '--others', '--exclude-standard'])) {
    hash.update(`${file}:${hashFile(path.join(root, file))}\n`);
  }
  return hash.digest('hex');
}

function lastGreenFile(root, env) {
  const folder = env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'factory-harness');
  const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(folder, `last-green-${key}`);
}

const readTextOrNull = filePath => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

/**
 * True when the worktree is the trusted base commit, apart from the factory's own working files:
 * nothing the agent wrote to check (a spec round, say). False without a base commit.
 */
export function unchangedFromBase(root, baseSha, git = (args => run('git', ['-C', root, ...args], { timeoutSeconds: 30 }))) {
  if (!baseSha) return false;
  const head = git(['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== baseSha) return false;
  // --no-renames, so a file moved out of .factory/ shows as added where it landed. A failed status
  // counts as changed.
  const status = git(['status', '--porcelain', '--untracked-files=all', '--no-renames']);
  return status.ok && status.stdout.split('\n').filter(Boolean).every(line => line.slice(3).startsWith('.factory/'));
}

export function createStopDependencies(env) {
  const dotnet = dotnetRunner(env);
  return {
    env,
    unchangedFromBase: root => unchangedFromBase(root, env.FACTORY_BASE_SHA),
    repoRoot: directory => (directory ? gitLines(directory, ['rev-parse', '--show-toplevel'])[0] ?? null : null),
    findSolution,
    fingerprint,
    lastGreen: root => readTextOrNull(lastGreenFile(root, env))?.trim() ?? null,
    saveGreen: (root, value) => {
      const file = lastGreenFile(root, env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    },
    runBuildAndTests: (root, solution, projects) => {
      if (inContainer(env)) {
        removeLeftoverContainers({ env: dockerEnvironment(env) });
        const result = dotnet(root, ['-c', CHECKS_SCRIPT, 'checks', solution, ...projects], BUILD_SECONDS + TEST_SECONDS * projects.length, { entrypoint: 'bash' });
        return splitChecks(result.output, projects);
      }
      const build = dotnet(root, buildArguments(solution), BUILD_SECONDS);
      return { build, tests: build.ok ? projects.map(project => dotnet(root, testArguments(project), TEST_SECONDS)) : [] };
    },
    // Unknown counts as having projects, so the build runs and reports the real problem.
    solutionHasProjects: (root, solution) => {
      const result = dotnet(root, ['sln', solution, 'list'], 60);
      return !result.ok || result.output.split(/\r?\n/).some(line => /\.\w+proj\s*$/i.test(line));
    },
    findTestProjects,
    readProgressNote: root => readTextOrNull(path.join(root, PROGRESS_NOTE_PATH)),
    hasUncommittedChanges: root => gitLines(root, ['status', '--porcelain']).length > 0,
  };
}
