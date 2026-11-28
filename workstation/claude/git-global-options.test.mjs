// Run with: node --test "workstation/claude/*.test.mjs"
// The guard denies any git global option it doesn't list, so its lists must hold only options git
// accepts, and git must reject the rest. These run the real git: harness CI's newer git checks the
// options local git is too old for, which are skipped here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_FLAG_OPTS, decide } from './guard-git-hooks.mjs';

const MIN_VERSION = { '--no-lazy-fetch': [2, 44], '--no-advice': [2, 46] };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-opts-'));
const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } });
const [major, minor] = git('version').stdout.match(/(\d+)\.(\d+)/).slice(1).map(Number);
const tooOld = ([a, b]) => major < a || (major === a && minor < b);

for (const option of GIT_FLAG_OPTS) {
  const min = MIN_VERSION[option];
  const skip = min && tooOld(min) ? `needs git ${min.join('.')}` : false;
  test(`git accepts the flag ${option}`, { skip }, () => {
    const run = git(option, 'version');
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /unknown option/);
  });
}

for (const [option, value] of [['--attr-source', 'HEAD'], ['--namespace', 'x'], ['--work-tree', '.']]) {
  test(`git takes the next word as the value of ${option}`, () => {
    const run = git(option, value, 'version');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /git version/);
  });
}

test('git rejects an option it doesn\'t know, so denying one costs nothing', () => {
  for (const option of ['--future-opt', '--no-pag', '-pP', '-Cdir', '--shallow-file=x']) {
    assert.match(git(option, 'version').stderr, /unknown option/, option);
  }
});

test('the denial names the option and says the list may need it', () => {
  const reason = decide({ tool_name: 'Bash', tool_input: { command: 'git --future-opt x status' } }, { home: '/home/dev' });
  assert.match(reason, /"--future-opt" isn't on the guard's list of git's global options/);
});

test('the text rules check every commit after an unknown option', () => {
  const reason = decide({ tool_name: 'PowerShell', tool_input: { command: 'git --future-opt x commit -n -m y' } }, { home: '/home/dev' });
  assert.ok(reason);
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: 'git --no-pager commit -m y' } }, { home: '/home/dev' }), null);
});
