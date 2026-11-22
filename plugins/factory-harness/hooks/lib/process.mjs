// Runs external commands (git, dotnet) without a shell, so arguments are never re-parsed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** @returns {{ok: boolean, status: number | null, stdout: string, stderr: string}} */
export function run(program, args, { cwd, timeoutSeconds = 120 } = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** git output as trimmed, non-empty lines; empty when git fails. */
export function gitLines(directory, args) {
  const result = run('git', ['-C', directory, ...args], { timeoutSeconds: 30 });
  return result.ok ? result.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [];
}

export function hashFile(filePath) {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/** The solution file at the repo root (.slnx preferred), or null. */
export function findSolution(root) {
  const names = fs.readdirSync(root).filter(n => /\.slnx?$/i.test(n)).sort((a, b) => b.localeCompare(a));
  return names[0] ?? null;
}
