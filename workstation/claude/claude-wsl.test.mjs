// Run with: node --test "workstation/claude/*.test.mjs"
// The launcher must start Claude only inside a git repository under ~/src, resolving symlinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./claude-wsl', import.meta.url));

// A home folder with a fake claude that echoes its arguments, and repositories under src.
function makeHome({ srcIsRepo = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-wsl-'));
  for (const dir of ['.local/bin', 'src/repo/.git/hooks', 'src/repo/sub', 'src/plain', 'outside']) mkdirSync(join(home, dir), { recursive: true });
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

for (const cwd of ['src/repo', 'src/repo/sub']) {
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
