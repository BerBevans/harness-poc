import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, edit, fakeContext, powershell, write } from './helpers.mjs';
import { evaluate } from '../guard.mjs';

decisionTable({
  blocked: [
    // Aliases on the command line.
    ['an alias with -c', bash("git -c alias.r='reset --hard' r")],
    ['a shell alias with -c', bash("git -c alias.x='!git push -f' x")],
    ['an alias with a mixed-case section', bash('git -c Alias.r=reset r --hard')],
    ['an alias with --config-env', bash('git --config-env alias.r=CMD r')],
    ['an alias with --config-env=', bash('git --config-env=alias.r=CMD r')],
    ['an alias after another global option', bash('git -C ../app -c alias.r=reset r --hard')],
    ['include.path with -c', bash('git -c include.path=/tmp/x.cfg r')],
    ['includeIf with -c', bash('git -c includeIf.gitdir:/.path=/tmp/x.cfg r')],
    ['an alias with -c in PowerShell', powershell("git -c alias.r='reset --hard' r")],
    // git config naming an alias or include key, reads included.
    ['git config alias.x', bash("git config alias.r 'reset --hard'")],
    ['git config --global alias.x', bash("git config --global alias.r 'reset --hard'")],
    ['git config set alias.x', bash("git config set alias.r 'reset --hard'")],
    ['git config --add include.path', bash('git config --add include.path /tmp/x.cfg')],
    ['git config --get alias.x', bash('git config --get alias.r')],
    ['git config --get-regexp ^alias', bash("git config --get-regexp '^alias\\.'")],
    ['git config --edit', bash('git config --edit')],
    ['git config edit', bash('git config edit --local')],
    // The GIT_CONFIG variables, whatever the key.
    ['GIT_CONFIG_COUNT=0 before git', bash('GIT_CONFIG_COUNT=0 git status')],
    ['GIT_CONFIG_PARAMETERS before git', bash("GIT_CONFIG_PARAMETERS=\"'alias.r=reset --hard'\" git r")],
    ['GIT_CONFIG_KEY_0 before git', bash('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status')],
    ['GIT_CONFIG_GLOBAL before git', bash('GIT_CONFIG_GLOBAL=/tmp/x.cfg git r')],
    ['export GIT_CONFIG_COUNT', bash('export GIT_CONFIG_COUNT=0; git status')],
    ['unset GIT_CONFIG_COUNT', bash('unset GIT_CONFIG_COUNT && git status')],
    ['env -u GIT_CONFIG_COUNT', bash('env -u GIT_CONFIG_COUNT git status')],
    ['a lower-case spelling', bash('git_config_count=0 git status')],
    ['$env:GIT_CONFIG_COUNT in PowerShell', powershell('$env:GIT_CONFIG_COUNT = 0; git status')],
    ['Remove-Item Env:GIT_CONFIG_COUNT', powershell('Remove-Item Env:GIT_CONFIG_COUNT; git status')],
    ['env -i', bash('env -i /usr/bin/git status')],
    ['env --ignore-environment', bash('env --ignore-environment PATH=/usr/bin git status')],
    ['env -', bash('env - PATH=/usr/bin git status')],
    ['env -vi cluster', bash('env -vi git status')],
    // The repository's config files.
    ['Write .git/config', write('C:\\Development\\app\\.git\\config', '[alias]\n  r = reset --hard\n')],
    ['Edit .git/config', edit('.git/config', '[core]', '[alias]\n  r = reset --hard\n[core]')],
    ['Write a worktree config', write('C:\\Development\\app\\.git\\worktrees\\x\\config.worktree')],
    ['append to .git/config', bash("printf '[alias]\\n r = reset --hard\\n' >> .git/config")],
    ['sed -i on .git/config', bash("sed -i 's/x/y/' .git/config")],
    ['copy over .git/config', bash('cp /tmp/x.cfg .git/config')],
  ],
  allowed: [
    ['-c with a harmless key', bash('git -c user.name=agent commit -m "Add task"')],
    ['--config-env with a harmless key', bash('git --config-env user.name=NAME status')],
    ['git config user.name', bash('git config user.name agent')],
    ['git config --get a harmless key', bash('git config --get remote.origin.url')],
    ['a file named git_config', bash('cat src/git_config.cs')],
    ['a longer name that contains GIT_CONFIG', bash('echo $MY_GIT_CONFIG_DIR')],
    ['env with an assignment', bash('env DOTNET_CLI_TELEMETRY_OPTOUT=1 dotnet build')],
    ['env with a command option -i', bash('env NAME=x sed -i s/a/b/ notes.txt')],
    ['read .git/config', bash('cat .git/config')],
    ['Write a file named config elsewhere', write('C:\\Development\\app\\src\\config')],
  ],
});

test('an alias denial says to run the command itself', () => {
  assert.match(evaluate(bash("git -c alias.r='reset --hard' r"), fakeContext()), /Run the git command itself/);
});

test('a GIT_CONFIG denial names the variable', () => {
  assert.match(evaluate(bash('GIT_CONFIG_COUNT=0 git status'), fakeContext()), /GIT_CONFIG_COUNT changes git's settings/);
});
