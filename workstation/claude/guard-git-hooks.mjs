#!/usr/bin/env node
// Claude Code PreToolUse hook. Stops the agent getting round the global git hooks
// in ~/.config/git/hooks, tampering with them, or reading the blocked-terms list
// (reading it would send the employer's name to the model).
//
// Allows by printing nothing; denies by printing a PreToolUse permission decision.
// Fails closed: unreadable input is denied.

import os from 'node:os';
import { pathToFileURL } from 'node:url';

const NEXT_STEP =
  'Do not look for another way round this. Stop and tell the user what you were trying to do and why; ' +
  'if the change is needed, they will make it themselves.';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// git global options that take a separate value, e.g. `git -C dir commit`.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

// `git commit` short options that consume the rest of a cluster as their value, e.g. `-mfix`.
const COMMIT_VALUE_FLAGS = new Set(['m', 'F', 'c', 'C', 't', 'S', 'u']);

const norm = p => String(p).replace(/\\/g, '/').toLowerCase();

// Every way a command might spell the home directory: C:/Users/x, /c/Users/x, ~, $HOME...
function homeForms(home) {
  const h = norm(home);
  const forms = new Set([h, '~', '$home', '${home}', '%userprofile%', '$env:userprofile']);
  const drive = /^([a-z]):\/(.*)$/.exec(h);
  if (drive) forms.add(`/${drive[1]}/${drive[2]}`);
  return [...forms];
}

function expandHome(p, home) {
  const n = norm(p);
  return n === '~' || n.startsWith('~/') ? norm(home) + n.slice(1) : n;
}

const tokenise = s => s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const isQuoted = t => /^["']/.test(t);

// Finds `git [global opts] commit ... -n` (short form of --no-verify), including clusters like -anm.
function commitUsesShortNoVerify(command) {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const m = /(?:^|[\s(`])(?:[^\s"'`]*[\/\\])?git(?:\.exe)?["']?\s+(.*)$/i.exec(segment);
    if (!m) continue;

    const tokens = tokenise(m[1]);
    let i = 0;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += GIT_OPTS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] !== 'commit') continue;

    for (const t of tokens.slice(i + 1)) {
      if (isQuoted(t) || !/^-[^-]/.test(t)) continue;
      for (const ch of t.slice(1)) {
        if (ch === 'n') return true;
        if (COMMIT_VALUE_FLAGS.has(ch)) break;
      }
    }
  }
  return false;
}

/**
 * Returns a denial reason, or null to allow.
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>}} input
 * @param {{home: string, termsFile?: string}} env
 */
export function evaluate(input, env) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  const home = norm(env.home);
  const termsFile = env.termsFile ? norm(env.termsFile) : null;

  const mentionsTerms = s => /blocked[-_]terms/i.test(s) || (termsFile !== null && norm(s).includes(termsFile));

  if (typeof args.command === 'string') {
    const cmd = args.command;
    const lower = norm(cmd);

    if (/--no-verify\b/i.test(cmd) || commitUsesShortNoVerify(cmd)) {
      return `Blocked: --no-verify / -n skips the global git hooks that keep the employer's name out of public repos. ` +
        `If a hook rejected your commit, fix the content it flagged instead. ${NEXT_STEP}`;
    }
    if (/core\.hookspath/i.test(cmd)) {
      return `Blocked: core.hooksPath controls the global git hooks, so agents may not read, override or change it. ${NEXT_STEP}`;
    }
    if (mentionsTerms(cmd)) {
      return `Blocked: the blocked-terms list must never be read, changed or substituted by an agent - ` +
        `its contents must not reach the model. ${NEXT_STEP}`;
    }
    const guarded = homeForms(home).flatMap(f => [`${f}/.config/git`, `${f}/.claude/hooks`]);
    if (guarded.some(g => lower.includes(g))) {
      return `Blocked: ~/.config/git and ~/.claude/hooks hold human-owned guardrails. ${NEXT_STEP}`;
    }
  }

  const paths = [args.file_path, args.notebook_path, args.path, args.pattern]
    .filter(p => typeof p === 'string')
    .map(p => expandHome(p, home));

  for (const p of paths) {
    if (mentionsTerms(p) || p.startsWith(`${home}/.config/git`)) {
      return `Blocked: ~/.config/git holds the git guardrails and the blocked-terms list, which agents may not open or change. ${NEXT_STEP}`;
    }
    if (WRITE_TOOLS.has(tool) &&
        (p.startsWith(`${home}/.claude/hooks/`) || p === `${home}/.gitconfig`)) {
      return `Blocked: ${p} is a human-owned guardrail file. ${NEXT_STEP}`;
    }
  }

  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny(`Blocked: the guard-git-hooks hook could not parse its input, so it failed closed. ${NEXT_STEP}`);
    return;
  }

  const reason = evaluate(input, { home: os.homedir(), termsFile: process.env.GIT_BLOCKED_TERMS_FILE });
  if (reason) deny(reason);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
