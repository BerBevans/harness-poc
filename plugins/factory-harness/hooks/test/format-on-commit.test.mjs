import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCommit, formatBeforeCommit, selectFiles } from '../format-on-commit.mjs';

const fakeGit = ({ staged = [], unstaged = [], untracked = [] }) => args => {
  if (args.includes('--cached')) return staged;
  if (args[0] === 'diff') return unstaged;
  if (args[0] === 'ls-files') return untracked;
  return [];
};

test('ignores commands that are not commits', () => {
  assert.equal(findCommit('git status', '/repo'), null);
  assert.equal(findCommit('dotnet build', '/repo'), null);
  assert.equal(formatBeforeCommit({ tool_input: { command: 'git log -n 5' }, cwd: '.' }), null);
});

test('finds the commit and its directory', () => {
  const commit = findCommit('git -C src commit -m "x"', '/repo');
  assert.ok(commit.directory.replace(/\\/g, '/').endsWith('/repo/src'));
  assert.equal(commit.includesUnstaged, false);
  assert.equal(commit.stagesFirst, false);
});

test('recognises -a, -am and --all', () => {
  assert.ok(findCommit('git commit -am "x"', '/repo').includesUnstaged);
  assert.ok(findCommit('git commit --all -m "x"', '/repo').includesUnstaged);
  assert.ok(!findCommit('git commit --amend --no-edit', '/repo').includesUnstaged);
});

test('recognises git add before the commit in the same command', () => {
  assert.ok(findCommit('git add . && git commit -m "x"', '/repo').stagesFirst);
  assert.ok(!findCommit('git commit -m "x" && git add .', '/repo').stagesFirst);
});

test('selects staged C# files only, skipping generated code', () => {
  const git = fakeGit({ staged: ['src/A.cs', 'src/A.g.cs', 'README.md', 'src/obj/B.cs'], unstaged: ['src/C.cs'] });
  assert.deepEqual(selectFiles({ includesUnstaged: false, stagesFirst: false }, git), ['src/A.cs']);
});

test('includes unstaged tracked files for commit -a', () => {
  const git = fakeGit({ staged: ['src/A.cs'], unstaged: ['src/C.cs'], untracked: ['src/New.cs'] });
  assert.deepEqual(selectFiles({ includesUnstaged: true, stagesFirst: false }, git), ['src/A.cs', 'src/C.cs']);
});

test('includes untracked files when git add runs first', () => {
  const git = fakeGit({ unstaged: ['src/C.cs'], untracked: ['src/New.cs'] });
  assert.deepEqual(selectFiles({ includesUnstaged: false, stagesFirst: true }, git), ['src/C.cs', 'src/New.cs']);
});
