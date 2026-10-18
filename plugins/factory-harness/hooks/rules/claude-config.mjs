// Protects the configuration that loads these hooks. Claude Code's file watcher applies
// settings changes mid-session, so a write here could switch the guardrails off at once.
// Session data the agent legitimately writes (memory, plans, todos) stays writable.

import { expandHome, isUnder, normalisePath, segments } from '../lib/paths.mjs';
import { commandWriteTargets, invocationsOf } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

const WRITABLE_SESSION_FOLDERS = new Set(['projects', 'plans', 'todos']);
const CONFIG_SUBCOMMANDS = new Set(['plugin', 'plugins', 'config', 'mcp']);

function claudeConfigFolders(context) {
  const folders = [`${normalisePath(context.home)}/.claude`];
  if (context.env.CLAUDE_CONFIG_DIR) folders.push(expandHome(context.env.CLAUDE_CONFIG_DIR, context.home).replace(/\/$/, ''));
  return folders;
}

export function isProtectedClaudePath(normalisedPath, context) {
  if (normalisedPath === `${normalisePath(context.home)}/.claude.json`) return true;
  return claudeConfigFolders(context).some(folder => {
    if (!isUnder(normalisedPath, folder)) return false;
    const [firstPart] = segments(normalisedPath.slice(folder.length));
    return !WRITABLE_SESSION_FOLDERS.has(firstPart);
  });
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const blocked = what => `Blocked: ${what}. Claude's configuration loads the factory's guardrails and is human-owned. ${nextStep}`;

  if (change.isWrite) {
    const path = change.paths.find(p => isProtectedClaudePath(p, context));
    if (path) return blocked(`${path} is user-level Claude configuration`);
  }

  if (/disableAllHooks/i.test(change.command ?? '') || /disableAllHooks/i.test(change.addedText)) {
    return blocked('disableAllHooks would switch off every hook');
  }

  if (change.command) {
    const target = commandWriteTargets(change.command).find(t => isProtectedClaudePath(expandHome(t, context.home), context));
    if (target) return blocked(`${target} is user-level Claude configuration`);

    const configCommand = invocationsOf(change.command, 'claude').find(args => CONFIG_SUBCOMMANDS.has(args[0]?.toLowerCase()));
    if (configCommand) return blocked(`\`claude ${configCommand[0]}\` changes which plugins, settings or servers load`);
  }

  return null;
}
