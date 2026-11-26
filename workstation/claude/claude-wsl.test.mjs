// Run with: node --test "workstation/claude/*.test.mjs"
// The launcher must start Claude only inside a git repository under ~/src, resolving symlinks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./claude-wsl', import.meta.url));

const homes = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

// A home folder with a fake claude that echoes its arguments, and repositories under src.
// src/worktree has a .git file, as a worktree or submodule does.
function makeHome({ srcIsRepo = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-wsl-'));
  homes.push(home);
  for (const dir of ['.local/bin', 'src/repo/.git/hooks', 'src/repo/sub', 'src/plain', 'src/worktree', 'outside']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, 'src/worktree/.git'), 'gitdir: ../repo/.git\n');
  if (srcIsRepo) mkdirSync(join(home, 'src/.git'));
  symlinkSync(home, join(home, 'src/link-to-home'));
  const fake = join(home, '.local/bin/claude');
  writeFileSync(fake, '#!/bin/sh\necho "ran $*"\n');
  chmodSync(fake, 0o755);
  return home;
}

const run = (home, cwd, args = []) =>
  spawnSync(launcher, args, { cwd: join(home, cwd), env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

const home = makeHome();

for (const cwd of ['src/repo', 'src/repo/sub', 'src/worktree']) {
  test(`starts Claude with its arguments in ${cwd}`, () => {
    const result = run(home, cwd, ['--version', 'two words']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ran --version two words\n');
  });
}

const refused = [
  ['the home folder', home, '.'],
  ['src itself', home, 'src'],
  ['a folder under src that is not a repository', home, 'src/plain'],
  ['a symlink under src that resolves to home', home, 'src/link-to-home'],
  ['a .git folder inside a repository', home, 'src/repo/.git/hooks'],
  ['a folder outside src', home, 'outside'],
  ['a plain folder when src itself is a repository', makeHome({ srcIsRepo: true }), 'src/plain'],
];

for (const [name, root, cwd] of refused) {
  test(`refuses ${name}`, () => {
    const result = run(root, cwd);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '', 'Claude must not start');
    assert.match(result.stderr, /refusing to start .*claude-admin/s);
  });
}
