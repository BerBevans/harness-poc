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
import { GIT_ATTACHED_OPTS, GIT_FLAG_OPTS, GIT_HELP_OPTS, GIT_OPTS_WITH_VALUE, decide } from './guard-git-hooks.mjs';
import * as plugin from '../../plugins/factory-harness/hooks/lib/command.mjs';
import { evaluate as pluginEvaluate } from '../../plugins/factory-harness/hooks/guard.mjs';

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

// `git help -a` lists the commands without opening a manual page.
test('-h and --help end option parsing: git runs help with the rest', () => {
  for (const option of ['-h', '--help']) {
    const run = git(option, '-a');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /git help <command>/, option);
  }
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

// The factory plugin keeps its own copy of the lists (it ships without this folder), so the real-git
// checks above cover it only while the copies match.
test('the plugin lists the same git global options', () => {
  assert.deepEqual([...plugin.GIT_OPTS_WITH_VALUE].sort(), [...GIT_OPTS_WITH_VALUE].sort());
  assert.deepEqual([...plugin.GIT_FLAG_OPTS].sort(), [...GIT_FLAG_OPTS].sort());
  assert.deepEqual([...plugin.GIT_ATTACHED_OPTS].sort(), [...GIT_ATTACHED_OPTS].sort());
  assert.deepEqual(Object.keys(plugin.GIT_HELP_OPTS).sort(), [...GIT_HELP_OPTS].sort());
});

// Every way to define an alias that both guards deny, checked against the real git: each defines
// `v` as an alias for `version`, so git printing its version proves git honoured the route. The
// command is the same route written as an agent would type it.
const includeFile = path.join(cwd, 'alias.cfg');
fs.writeFileSync(includeFile, '[alias]\n\tv = version\n');
const ALIAS_ROUTES = [
  { name: '-c', args: ['-c', 'alias.v=version', 'v'], command: 'git -c alias.v=version v' },
  { name: '-c with a mixed-case section', args: ['-c', 'Alias.v=version', 'v'], command: 'git -c Alias.v=version v' },
  { name: '--config-env', args: ['--config-env', 'alias.v=ALIAS_CMD', 'v'], env: { ALIAS_CMD: 'version' },
    command: 'ALIAS_CMD=version git --config-env alias.v=ALIAS_CMD v' },
  { name: 'include.path with -c', args: ['-c', `include.path=${includeFile}`, 'v'], command: 'git -c include.path=/tmp/alias.cfg v' },
  { name: 'GIT_CONFIG_PARAMETERS', args: ['v'], env: { GIT_CONFIG_PARAMETERS: "'alias.v=version'" },
    command: "GIT_CONFIG_PARAMETERS=\"'alias.v=version'\" git v" },
  { name: 'GIT_CONFIG_COUNT and KEY_0', args: ['v'], env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.v', GIT_CONFIG_VALUE_0: 'version' },
    command: 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.v GIT_CONFIG_VALUE_0=version git v' },
];
const pluginContext = { home: '/home/dev', env: {}, readFile: () => null, currentBranch: () => 'feature/x' };
for (const route of ALIAS_ROUTES) {
  test(`git honours an alias defined with ${route.name}, and both guards deny it`, () => {
    const run = spawnSync('git', route.args, { cwd, encoding: 'utf8', env: { ...process.env, ...route.env } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /git version/);
    const input = { tool_name: 'Bash', tool_input: { command: route.command }, cwd };
    assert.match(pluginEvaluate(input, pluginContext) ?? 'allowed', /alias|GIT_CONFIG/, 'the plugin\'s git-config rule didn\'t deny it');
    assert.ok(decide(input, { home: '/home/dev' }), 'the workstation guard allowed it');
  });
}
