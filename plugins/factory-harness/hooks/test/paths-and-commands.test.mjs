// Spellings that reach a guarded path or command indirectly: dots in paths, symlinks, subshells,
// substitutions and nested shells (slice 2 review, findings 9 and 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, fakeContext, HOME, read, REPO, write } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, evaluate } from '../guard.mjs';
import { splitSegments } from '../lib/command.mjs';
import { collapseDots } from '../lib/paths.mjs';

decisionTable({
  blocked: [
    ['Write to ~/.claude through ..', write(`${HOME}\\.claude\\projects\\..\\settings.json`, '{}')],
    ['Write to a workflow through .. and //', write(`${REPO}\\src\\..\\.github\\\\workflows\\ci.yml`, 'on: push')],
    ['Write through ./', write(`${REPO}\\.\\Directory.Build.props`, '<Project />')],
    ['Read of a secret through ..', read(`${REPO}\\src\\..\\.env`)],
    ['shell write through ..', bash('echo x > src/../.github/workflows/ci.yml')],
    ['subshell', bash('(cd src && git reset --hard)')],
    ['brace group', bash('{ git push --force; }')],
    ['command substitution', bash('echo $(git reset --hard)')],
    ['backticks', bash('echo `git push -f`')],
    ['bash -c', bash('bash -c "git reset --hard"')],
    ['bash -lc', bash('bash -lc "git reset --hard"')],
    ['sh -ec reading a secret', bash("sh -ec 'cat .env'")],
    ['nested subshells', bash('(cd src && (git reset --hard))')],
    ['a subshell inside a group', bash('{ (git push --force); }')],
    ['a delete inside nested subshells', bash('( ( rm .github/workflows/ci.yml ) )')],
    ['a background job', bash('true & rm .github/workflows/ci.yml')],
    ['sh -c with a separator inside the quotes', bash("sh -c 'cd src; git push --force'")],
    ['pwsh -Command', bash('pwsh -Command "git reset --hard"')],
    ['pwsh -NonInteractive -Command', bash('pwsh -NonInteractive -Command "git push --force"')],
    ['pwsh -ExecutionPolicy Bypass -Command', bash('pwsh -ExecutionPolicy Bypass -Command "git reset --hard"')],
    ['an escaped quote outside quotes', bash("echo it\\'s; git push --force")],
    ['process substitution', bash('cat <(git reset --hard)')],
    ['a write inside bash -c', bash('bash -c "echo x > .github/workflows/ci.yml"')],
    ['substitution inside bash -c', bash('bash -c "echo $(git reset --hard)"')],
    ['linking to a guarded file', bash('ln -s ../Directory.Build.props src/settings.props')],
  ],
  allowed: [
    ['dots that stay outside guarded paths', write(`${REPO}\\src\\Tasks\\..\\Lists\\List.cs`, 'class L {}')],
    ['a separator inside a quoted message', bash('git commit -m "fix: a; b && c"')],
    ['brackets inside a quoted message', bash('git commit -m "fix (thing)"')],
    ['bash -c with a harmless command', bash('bash -c "dotnet build"')],
    ['redirects that use &', bash('dotnet build 2>&1 | tee build.log >&2')],
  ],
});

test('collapseDots handles leading .., drive letters and the root', () => {
  assert.equal(collapseDots('c:/a/../../b'), 'c:/b');
  assert.equal(collapseDots('../a/./b//c'), '../a/b/c');
  assert.equal(collapseDots('/a/../../b'), '/b');
});

test('shells nested too deep make the guard fail closed', () => {
  let command = 'git status';
  for (let i = 0; i < 6; i++) command = `bash -c ${JSON.stringify(command)}`;
  assert.throws(() => splitSegments(command), /nests commands more than 4 deep/);
});

// A context whose realpath follows the symlinks given, as the guard's does on disk.
const linked = links => Object.assign(fakeContext(), {
  realpath: path => {
    const key = path.replace(/\\/g, '/').toLowerCase();
    return Object.entries(links).find(([from]) => key === from.toLowerCase() || key.startsWith(`${from.toLowerCase()}/`))
      ?.reduce((from, to) => to + key.slice(from.length)) ?? path;
  },
});

test('a write through a symlink to a guarded file is blocked', () => {
  const context = linked({ 'C:/Development/app/notes.txt': 'C:/Development/app/.github/workflows/ci.yml' });
  assert.ok(evaluate(write(`${REPO}\\notes.txt`, 'on: push'), context));
  assert.ok(evaluate(bash('echo x > notes.txt'), context));
  assert.equal(evaluate(write(`${REPO}\\other.txt`, 'x'), context), null);
});

test('a symlink resolving to the real ~/.claude folder maps back to it', () => {
  // ~/.claude itself is a symlink on some machines (WSL sharing the Windows folder).
  const context = linked({ 'C:/Users/dev/.claude': 'D:/shared/claude', 'C:/Development/app/x.json': 'D:/shared/claude/settings.json' });
  assert.ok(evaluate(write(`${REPO}\\x.json`, '{}'), context));
});

test('on disk, a write through a dangling link to a guarded path is blocked', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-links-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.github'));
  try {
    fs.symlinkSync(path.join(repo, '.github', 'new.yml'), path.join(repo, 'notes.yml'));
  } catch {
    t.skip('symlinks need extra rights here');
    return;
  }
  const context = createContext({});
  const input = { tool_name: 'Write', tool_input: { file_path: path.join(repo, 'notes.yml'), content: 'on: push' }, cwd: repo };
  assert.match(evaluate(input, context), /is a guardrail file/);
  assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: 'cat notes.yml > x' }, cwd: repo }, context), null);
});
