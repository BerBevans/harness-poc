// The real git, dotnet and file-system operations behind the Stop hook. Kept apart from
// the decision logic so that logic can be tested quickly with fakes.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRESS_NOTE_PATH } from './next-step.mjs';
import { findSolution, gitLines, hashFile, run } from './process.mjs';

const FAST_TEST_PROJECT = /\.(UnitTests|ArchitectureTests)\.csproj$/i;
const SKIPPED_FOLDERS = new Set(['.git', 'bin', 'obj', 'node_modules', 'TestResults']);
const MAX_SEARCH_DEPTH = 6;

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

export function createStopDependencies(env) {
  return {
    env,
    repoRoot: directory => (directory ? gitLines(directory, ['rev-parse', '--show-toplevel'])[0] ?? null : null),
    findSolution,
    fingerprint,
    lastGreen: root => readTextOrNull(lastGreenFile(root, env))?.trim() ?? null,
    saveGreen: (root, value) => {
      const file = lastGreenFile(root, env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    },
    runBuild: (root, solution) => {
      const result = run('dotnet', ['build', solution, '-warnaserror', '-nologo', '-v:q', '-clp:NoSummary'], { cwd: root, timeoutSeconds: 300 });
      return { ok: result.ok, output: result.stdout + result.stderr };
    },
    findTestProjects,
    runTests: (root, project) => {
      // Quiet verbosity hides assertion messages; the console logger at normal brings them back.
      const args = ['test', project, '--no-build', '-nologo', '-v:q', '--logger', 'console;verbosity=normal'];
      const result = run('dotnet', args, { cwd: root, timeoutSeconds: 120 });
      return { ok: result.ok, output: result.stdout + result.stderr };
    },
    readProgressNote: root => readTextOrNull(path.join(root, PROGRESS_NOTE_PATH)),
    hasUncommittedChanges: root => gitLines(root, ['status', '--porcelain']).length > 0,
  };
}
