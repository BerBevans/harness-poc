// Reading hook input from stdin and writing Claude Code hook decisions to stdout.
// Every hook exits 0 and communicates through JSON; allowing means printing nothing.

import { pathToFileURL } from 'node:url';

export async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/** Parses hook input; returns null when it isn't a JSON object. */
export function parseInput(raw) {
  try {
    const input = JSON.parse(raw);
    return input !== null && typeof input === 'object' ? input : null;
  } catch {
    return null;
  }
}

export const denyToolUse = reason => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

export const blockStop = reason => ({ decision: 'block', reason });

export const warnUser = message => ({ systemMessage: message });

export function writeOutput(output) {
  if (output) process.stdout.write(JSON.stringify(output));
}

/** True when the module is being run as a script rather than imported by a test. */
export const isEntryPoint = moduleUrl => moduleUrl === pathToFileURL(process.argv[1] ?? '').href;
