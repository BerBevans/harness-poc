// Blocks the ways an agent could define a git alias or override the git settings a factory run
// sets: alias and include keys, the GIT_CONFIG variables and writes to git's config files (other
// keys set through `git config` are allowed; see docs/hooks.md for the limits). A git alias hides which
// subcommand runs from destructive-git (`git -c alias.r='reset --hard' r`), and a `!` alias runs
// any shell command. The GIT_CONFIG* variables carry the git settings run-agent sets for a factory
// run, so setting, clearing or unsetting any of them is blocked whatever the key.

import {
  bashWord, commandWriteTargets, gitInvocations, hasShortFlag, invocationsOf, splitSegments, tokenisations, unquote,
} from '../lib/command.mjs';
import { pathForms, segments } from '../lib/paths.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

// Section names are case-insensitive in git. include.path and includeIf.<condition>.path load
// another config file, which can hold aliases. `^alias\.` covers `git config --get-regexp`.
const ALIAS_KEY = /^\^?(alias|include|includeif)(\.|\\|$)/i;

// GIT_CONFIG, GIT_CONFIG_COUNT, _KEY_n, _VALUE_n, _PARAMETERS, _GLOBAL, _SYSTEM, _NOSYSTEM and any
// git adds later, in any spelling: `X=1 git`, `export`, `unset`, `env -u`, `$env:` and the rest.
// Not part of a longer name or a file name (`git_config.cs`); PowerShell's Env:\GIT_CONFIG_COUNT counts.
// A name attached to an option (env -uGIT_CONFIG_COUNT, -SGIT_CONFIG_PARAMETERS=...) counts too.
const GIT_CONFIG_VARIABLE = /(?:(?<![\w.-])|(?<=(?:^|[\s'"])-[A-Za-z]*))GIT_CONFIG\w*(?![\w.])/i;

// git's config files: the repository's (.git/config, config.worktree, and the same under
// .git/worktrees and .git/modules), ~/.gitconfig, $XDG_CONFIG_HOME/git/config and /etc/gitconfig.
function isGitConfigFile(normalisedPath) {
  const parts = segments(normalisedPath);
  const name = (parts.at(-1) ?? '').replace(/\.lock$/, '');
  return (parts.includes('.git') && /^config(\.worktree)?$/.test(name))
    || name === '.gitconfig' || name === 'gitconfig' || (parts.at(-2) === 'git' && name === 'config');
}

// env's options before the command: -i, --ignore-environment (or an abbreviation) and a bare -
// start from an empty environment.
function envClears(args) {
  for (let i = 0; i < args.length && args[i].startsWith('-'); i++) {
    const arg = args[i];
    if (arg === '-' || (arg.length >= 3 && '--ignore-environment'.startsWith(arg))) return true;
    if (!arg.startsWith('--') && hasShortFlag([arg], 'i')) return true;
    if (['-u', '-C', '-S', '--unset', '--chdir', '--split-string'].includes(arg)) i++;
  }
  return false;
}

// `git clone -c key=value` (or --config, abbreviated, or -c in a short-option cluster) writes the
// key into the new repository's config.
function cloneConfigs(args) {
  const configs = [];
  args.forEach((arg, i) => {
    const long = arg.match(/^--con(?:f(?:ig?)?)?(=.*)?$/);
    if (long) configs.push(long[1] ? long[1].slice(1) : args[i + 1] ?? '');
    const short = arg.match(/^-([a-z]*?)c(.*)$/i);
    if (short && !arg.startsWith('--') && !/[obuj]/.test(short[1])) configs.push(short[2] || (args[i + 1] ?? ''));
  });
  return configs;
}

function configKeys(git) {
  const configs = [...git.configs, ...(git.subcommand === 'clone' ? cloneConfigs(git.args) : [])];
  const keys = configs.map(config => config.split('=')[0]);
  if (git.subcommand === 'config') keys.push(...git.args.filter(arg => !arg.startsWith('-')));
  return keys;
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const repoConfig = path => `Blocked: ${path} is a git config file, which can define aliases and change ` +
    `what git runs, so agents don't change it. ${nextStep}`;

  if (change.isWrite) {
    const path = change.paths.find(isGitConfigFile);
    if (path) return repoConfig(path);
  }
  if (!change.command) return null;

  // The raw text, and every word as written and as bash reads it (GIT''_CONFIG_COUNT, G\IT_CONFIG).
  const words = splitSegments(change.command).flatMap(tokenisations).flat().flatMap(t => [unquote(t), bashWord(t)]);
  const variable = [change.command, ...words].map(text => text.match(GIT_CONFIG_VARIABLE)).find(Boolean);
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

  const target = commandWriteTargets(change.command).find(t => pathForms(t, context, change.cwd).some(isGitConfigFile));
  return target ? repoConfig(target) : null;
}
