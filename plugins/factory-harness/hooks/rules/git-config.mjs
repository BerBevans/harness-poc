// Blocks the ways an agent could change git's settings for itself. A git alias hides which
// subcommand runs from destructive-git (`git -c alias.r='reset --hard' r`), and a `!` alias runs
// any shell command. The GIT_CONFIG* variables carry the git settings run-agent sets for a factory
// run, so setting, clearing or unsetting any of them is blocked whatever the key.

import { commandWriteTargets, gitInvocations, hasShortFlag, invocationsOf } from '../lib/command.mjs';
import { pathForms, segments } from '../lib/paths.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

// Section names are case-insensitive in git. include.path and includeIf.<condition>.path load
// another config file, which can hold aliases. `^alias\.` covers `git config --get-regexp`.
const ALIAS_KEY = /^\^?(alias|include|includeif)(\.|\\|$)/i;

// GIT_CONFIG, GIT_CONFIG_COUNT, _KEY_n, _VALUE_n, _PARAMETERS, _GLOBAL, _SYSTEM, _NOSYSTEM and any
// git adds later, in any spelling: `X=1 git`, `export`, `unset`, `env -u`, `$env:` and the rest.
// Not part of a longer name or a file name (`git_config.cs`).
const GIT_CONFIG_VARIABLE = /(?<![\w./\\-])GIT_CONFIG\w*(?![\w.])/i;

// The repository's own config files: .git/config, config.worktree and the same under
// .git/worktrees and .git/modules.
const isRepoConfig = normalisedPath =>
  segments(normalisedPath).includes('.git') && /^config(\.worktree)?(\.lock)?$/.test(segments(normalisedPath).at(-1) ?? '');

// env's options before the command: -i, --ignore-environment and a bare - start from an empty
// environment.
function envClears(args) {
  for (let i = 0; i < args.length && args[i].startsWith('-'); i++) {
    const arg = args[i];
    if (arg === '-' || arg === '-i' || arg.startsWith('--ig') || (!arg.startsWith('--') && hasShortFlag([arg], 'i'))) return true;
    if (['-u', '-C', '-S', '--unset', '--chdir', '--split-string'].includes(arg)) i++;
  }
  return false;
}

function configKeys(git) {
  const keys = git.configs.map(config => config.split('=')[0]);
  if (git.subcommand === 'config') keys.push(...git.args.filter(arg => !arg.startsWith('-')));
  return keys;
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const repoConfig = path => `Blocked: ${path} is git's repository config, which can define aliases and change ` +
    `what git runs, so agents don't change it. ${nextStep}`;

  if (change.isWrite) {
    const path = change.paths.find(isRepoConfig);
    if (path) return repoConfig(path);
  }
  if (!change.command) return null;

  const variable = change.command.match(GIT_CONFIG_VARIABLE);
  if (variable) {
    return `Blocked: ${variable[0]} changes git's settings, and a factory run sets git's settings through the ` +
      `GIT_CONFIG variables, so agents don't set, clear or read them. ${nextStep}`;
  }
  if (invocationsOf(change.command, 'env').some(envClears)) {
    return `Blocked: \`env -i\` starts from an empty environment, which drops the git settings a factory run sets. ${nextStep}`;
  }

  for (const git of gitInvocations(change.command)) {
    const key = configKeys(git).find(k => ALIAS_KEY.test(k));
    if (key) {
      return `Blocked: "${key}" defines a git alias, or loads a config file that can, and an alias hides which git ` +
        `subcommand runs (a "!" alias runs any shell command). Run the git command itself. ${nextStep}`;
    }
    if (git.subcommand === 'config' && git.args.some(arg => ['-e', '--edit', 'edit'].includes(arg))) {
      return repoConfig('`git config --edit`');
    }
  }

  const target = commandWriteTargets(change.command).find(t => pathForms(t, context, change.cwd).some(isRepoConfig));
  return target ? repoConfig(target) : null;
}
