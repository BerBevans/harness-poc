#!/usr/bin/env node
// PreToolUse guard: runs every rule against the tool call and denies on the first match.
// Fails closed: unreadable input or an error inside a rule denies the call.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describeChange } from './lib/change.mjs';
import { denyToolUse, isEntryPoint, parseInput, readStdin, writeOutput } from './lib/hook-io.mjs';
import { nextStepAfterBlock } from './lib/next-step.mjs';
import * as claudeConfig from './rules/claude-config.mjs';
import * as guardrailFiles from './rules/guardrail-files.mjs';
import * as secrets from './rules/secrets.mjs';
import * as suppressions from './rules/suppressions.mjs';
import * as destructiveGit from './rules/destructive-git.mjs';

const RULES = [claudeConfig, guardrailFiles, secrets, suppressions, destructiveGit];

/** Returns a denial reason, or null to allow. */
export function evaluate(input, context) {
  const change = describeChange(input, context);
  for (const rule of RULES) {
    const reason = rule.check(change, context);
    if (reason) return reason;
  }
  return null;
}

/**
 * Follows symlinks in the longest part of the path that exists, dangling ones included (a link to
 * a file not yet created), so a write through the link is checked against its target. Null if no
 * part of the path exists.
 */
export function resolveLinks(filePath, hops = 0) {
  if (hops > 40) return null;
  let existing = filePath;
  let rest = '';
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
    const cut = Math.max(existing.lastIndexOf('/'), existing.lastIndexOf('\\'));
    if (cut <= 0) return null;
    rest = existing.slice(cut) + rest;
    existing = existing.slice(0, cut);
  }
  try {
    return fs.realpathSync.native(existing) + rest;
  } catch {
    // realpath fails on a dangling link: follow it by hand.
    const parent = path.dirname(existing);
    const realParent = resolveLinks(parent, hops + 1) ?? parent;
    return resolveLinks(path.resolve(realParent, fs.readlinkSync(existing)) + rest, hops + 1);
  }
}

export function createContext(env = process.env) {
  return {
    home: os.homedir(),
    env,
    realpath: filePath => resolveLinks(String(filePath)),
    readFile: filePath => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    currentBranch: directory => {
      const result = spawnSync('git', ['-C', directory, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000 });
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

async function main() {
  const context = createContext();
  const input = parseInput(await readStdin());
  if (!input) {
    writeOutput(denyToolUse(`Blocked: the guard hook could not parse its input, so it failed closed. ${nextStepAfterBlock(context.env)}`));
    return;
  }

  try {
    const reason = evaluate(input, context);
    if (reason) writeOutput(denyToolUse(reason));
  } catch (error) {
    writeOutput(denyToolUse(`Blocked: the guard hook hit an error (${error.message}), so it failed closed. ${nextStepAfterBlock(context.env)}`));
  }
}

if (isEntryPoint(import.meta.url)) await main();
