// Blocks git and gh commands that rewrite shared history, push to the protected branch,
// throw away uncommitted work, or merge without the reviewer. Branch protection is the
// server-side backstop; this is the fast feedback.

import path from 'node:path';
import { gitInvocations, hasShortFlag, invocationsOf } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

const PROTECTED_BRANCHES = new Set(['main', 'master']);
const isOption = arg => arg.startsWith('-');
const discardsEverything = arg => ['.', ':/', '*', ':(top)'].includes(arg);

function checkPush(args, currentBranch) {
  if (args.some(a => /^--(force|force-with-lease|force-if-includes)(=|$)/.test(a)) || hasShortFlag(args, 'f')) {
    return 'force pushing rewrites history a resumed run depends on';
  }
  if (args.includes('--mirror')) return '`git push --mirror` force-updates every ref';
  if (args.includes('--delete') || hasShortFlag(args, 'd')) return 'deleting a remote branch';

  const refspecs = args.filter(a => !isOption(a)).slice(1);
  if (refspecs.some(r => r.startsWith('+'))) return 'a `+` refspec force pushes';
  if (refspecs.some(r => r.startsWith(':'))) return 'an empty-source refspec deletes a remote branch';
  if (args.includes('--all')) return '`git push --all` pushes main as well';

  const destinations = refspecs.map(r => r.split(':').pop().replace(/^refs\/heads\//, ''));
  const pushesCurrentBranch = destinations.length === 0 || destinations.includes('HEAD');
  const pushesProtected = destinations.some(d => PROTECTED_BRANCHES.has(d))
    || (pushesCurrentBranch && PROTECTED_BRANCHES.has(currentBranch() ?? ''));
  if (pushesProtected) return 'pushing to main bypasses review; push a feature branch and open a PR';

  return null;
}

function checkLocal(subcommand, args) {
  if (subcommand === 'reset' && args.includes('--hard')) return '`git reset --hard` throws away uncommitted work';
  if (subcommand === 'clean' && (args.includes('--force') || hasShortFlag(args, 'f'))) {
    return '`git clean -f` deletes untracked files';
  }
  if (subcommand === 'checkout' && args.some(discardsEverything)) return '`git checkout .` throws away uncommitted work';
  if (subcommand === 'restore' && args.some(discardsEverything)) {
    const onlyUnstages = args.includes('--staged') && !args.includes('--worktree') && !hasShortFlag(args, 'W');
    if (!onlyUnstages) return '`git restore .` throws away uncommitted work';
  }
  if (subcommand === 'branch' && (hasShortFlag(args, 'D') || (args.includes('--delete') && args.includes('--force')))) {
    return 'force-deleting a branch can lose unmerged work';
  }
  if (subcommand === 'filter-branch' || subcommand === 'filter-repo') return 'rewriting history';
  return null;
}

export function check(change, context) {
  if (!change.command) return null;
  const nextStep = nextStepAfterBlock(context.env);
  const blocked = why => `Blocked: ${why}. ${nextStep}`;

  for (const git of gitInvocations(change.command)) {
    const directory = path.resolve(change.cwd ?? '.', git.directory ?? '.');
    const reason = git.subcommand === 'push'
      ? checkPush(git.args, () => context.currentBranch(directory))
      : checkLocal(git.subcommand, git.args);
    if (reason) return blocked(reason);
  }

  if (invocationsOf(change.command, 'gh').some(args => args[0] === 'pr' && args[1] === 'merge')) {
    return blocked('merging is the reviewer\'s decision, not the implementer\'s');
  }

  return null;
}
