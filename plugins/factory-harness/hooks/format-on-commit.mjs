#!/usr/bin/env node
// PreToolUse hook on git commit: formats the C# files about to be committed. If that
// changes anything, it denies the commit so the agent can review and re-stage, like a
// pre-commit formatter. Fails open: formatting is not a guardrail, and the build's
// IDE0055 and code-style rules still stop unformatted code merging.

import path from 'node:path';
import { gitInvocations, hasShortFlag } from './lib/command.mjs';
import { denyToolUse, isEntryPoint, parseInput, readStdin, writeOutput } from './lib/hook-io.mjs';
import { isGeneratedCode, normalisePath } from './lib/paths.mjs';
import { findSolution, gitLines, hashFile, run } from './lib/process.mjs';

/** The commit in the command, if any: where it runs and which changes it will include. */
export function findCommit(command, cwd) {
  const invocations = gitInvocations(command);
  const commit = invocations.find(g => g.subcommand === 'commit');
  if (!commit) return null;

  const addIndex = invocations.findIndex(g => g.subcommand === 'add');
  return {
    directory: path.resolve(cwd ?? '.', commit.directory ?? '.'),
    includesUnstaged: commit.args.includes('--all') || hasShortFlag(commit.args, 'a'),
    // `git add . && git commit` stages files after this hook runs, so count everything changed.
    stagesFirst: addIndex >= 0 && addIndex < invocations.indexOf(commit),
  };
}

/** Repo-relative paths of the C# files the commit will include. */
export function selectFiles(commit, git) {
  const files = new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  if (commit.includesUnstaged || commit.stagesFirst) {
    for (const file of git(['diff', '--name-only', '--diff-filter=ACMR'])) files.add(file);
  }
  if (commit.stagesFirst) {
    for (const file of git(['ls-files', '--others', '--exclude-standard'])) files.add(file);
  }
  return [...files].filter(f => f.endsWith('.cs') && !isGeneratedCode(normalisePath(f))).sort();
}

export function formatFiles(root, files) {
  const solution = findSolution(root);
  const include = ['--include', ...files];
  const workspace = solution ? [solution] : [root, '--folder'];
  run('dotnet', ['format', 'whitespace', ...workspace, ...include], { cwd: root });
  if (solution) run('dotnet', ['format', 'style', solution, ...include], { cwd: root });
}

/** Returns a denial reason when formatting changed files, otherwise null. */
export function formatBeforeCommit(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;

  const commit = findCommit(command, input.cwd);
  if (!commit) return null;

  const [root] = gitLines(commit.directory, ['rev-parse', '--show-toplevel']);
  if (!root) return null;

  const files = selectFiles(commit, args => gitLines(root, args));
  if (files.length === 0) return null;

  const before = new Map(files.map(f => [f, hashFile(path.join(root, f))]));
  formatFiles(root, files);
  const changed = files.filter(f => hashFile(path.join(root, f)) !== before.get(f));
  if (changed.length === 0) return null;

  return `Not committed yet: formatting changed ${changed.length} file(s): ${changed.join(', ')}. ` +
    'Review the changes, stage them with git add, then run the commit again.';
}

async function main() {
  const input = parseInput(await readStdin());
  if (!input) return;
  try {
    const reason = formatBeforeCommit(input);
    if (reason) writeOutput(denyToolUse(reason));
  } catch {
    // Fail open; the build is the gate for formatting.
  }
}

if (isEntryPoint(import.meta.url)) await main();
