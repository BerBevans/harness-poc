// Spellings that reach a guarded path or command indirectly: dots in paths, symlinks, subshells,
// substitutions and nested shells (slice 2 review, findings 9 and 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, fakeContext, HOME, read, REPO, write } from './helpers.mjs';
import { evaluate } from '../guard.mjs';
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
    ['sh -c with a separator inside the quotes', bash("sh -c 'cd src; git push --force'")],
    ['pwsh -Command', bash('pwsh -Command "git reset --hard"')],
    ['a write inside bash -c', bash('bash -c "echo x > .github/workflows/ci.yml"')],
    ['substitution inside bash -c', bash('bash -c "echo $(git reset --hard)"')],
    ['linking to a guarded file', bash('ln -s ../Directory.Build.props src/settings.props')],
  ],
  allowed: [
    ['dots that stay outside guarded paths', write(`${REPO}\\src\\Tasks\\..\\Lists\\List.cs`, 'class L {}')],
    ['a separator inside a quoted message', bash('git commit -m "fix: a; b && c"')],
    ['brackets inside a quoted message', bash('git commit -m "fix (thing)"')],
    ['bash -c with a harmless command', bash('bash -c "dotnet build"')],
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
  assert.throws(() => splitSegments(command), /nests shells more than 4 deep/);
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
