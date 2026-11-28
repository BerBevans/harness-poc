// Run with: node --test "workstation/claude/*.test.mjs"
// The guard denies any git global option it doesn't list, so its lists must say how the real git
// reads each option, and git must reject the rest. These run the real git. Locally, options newer
// than the installed git are skipped; on CI they fail instead, so harness CI's git must cover them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_FLAG_OPTS, GIT_OPTS_WITH_VALUE, decide } from './guard-git-hooks.mjs';

const MIN_VERSION = { '--no-lazy-fetch': [2, 44], '--no-advice': [2, 46] };
// A value each value-taking option accepts, so `git <option> <value> version` succeeds.
const SAMPLE_VALUE = {
  '-C': '.', '-c': 'user.name=x', '--git-dir': '.', '--work-tree': '.', '--namespace': 'x',
  '--config-env': 'user.name=HOME', '--super-prefix': 'x/', '--attr-source': 'HEAD', '--shallow-file': 'x',
};
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-opts-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } });
const [major, minor] = git('version').stdout.match(/(\d+)\.(\d+)/).slice(1).map(Number);
const tooOld = ([a, b]) => major < a || (major === a && minor < b);
const onCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const unknown = run => /unknown option/.test(run.stderr);

for (const option of GIT_FLAG_OPTS) {
  const min = MIN_VERSION[option];
  const skip = min && tooOld(min) && !onCi ? `needs git ${min.join('.')}, this is ${major}.${minor}` : false;
  test(`git accepts the flag ${option} without taking a value`, { skip }, () => {
    const run = git(option, 'version');
    assert.ok(!unknown(run), `git ${major}.${minor} doesn't know ${option}`);
    assert.equal(run.status, 0, run.stderr);
  });
}

test('every value-taking option has a sample value', () => {
  assert.deepEqual([...GIT_OPTS_WITH_VALUE].filter(o => !(o in SAMPLE_VALUE)), []);
});

// Either git doesn't know the option (--super-prefix, gone from newer gits), so denying is the
// worst case, or it takes the next word: with a value the command runs, and without one git
// swallows "version" and has no subcommand left. A flag listed here would hide the subcommand.
for (const option of GIT_OPTS_WITH_VALUE) {
  test(`git takes the next word as the value of ${option}`, () => {
    const bare = git(option, 'version');
    if (unknown(bare)) return;
    const withValue = git(option, SAMPLE_VALUE[option], 'version');
    assert.equal(withValue.status, 0, withValue.stderr);
    assert.match(withValue.stdout, /git version/);
    assert.doesNotMatch(bare.stdout, /git version/, `${option} didn't take "version" as its value`);
  });
}

test('-v and --version end option parsing: git runs version with the rest', () => {
  for (const option of ['-v', '--version']) assert.match(git(option, 'status').stdout, /git version/, option);
});

test('git rejects an option it doesn\'t know, so denying one costs a real git call nothing', () => {
  for (const option of ['--future-opt', '--no-pag', '-pP', '-Cdir', '--shallow-file=x']) {
    assert.ok(unknown(git(option, 'version')), option);
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
