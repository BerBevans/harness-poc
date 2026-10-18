// Cuts build and test output down to what the agent needs to act on. Raw logs would
// spend the usage allowance on noise.

const FALLBACK_TAIL_LINES = 30;

const tail = output => output.split(/\r?\n/).filter(l => l.trim()).slice(-FALLBACK_TAIL_LINES).join('\n');

/** Makes absolute paths under the repo relative, whichever slash style the tool printed. */
export function withoutRepoPath(text, root) {
  const forward = root.replace(/\\/g, '/').replace(/\/$/, '');
  const back = forward.replace(/\//g, '\\');
  return text.split(`${forward}/`).join('').split(`${back}\\`).join('');
}

export function truncate(text, maxCharacters) {
  return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters)}\n... (truncated)`;
}

/** The distinct compiler, analyser and NuGet errors, or the end of the log if none are recognisable. */
export function summariseBuildFailures(output) {
  const errors = [...new Set(output.split(/\r?\n/).map(l => l.trim()).filter(l => /:\s*error\s+[A-Z]+\d+\s*:/.test(l)))];
  return errors.length > 0 ? `Build errors:\n${errors.join('\n')}` : `Build failed:\n${tail(output)}`;
}

/** Each failing test's name and error message, without stack traces. */
export function summariseTestFailures(output) {
  const kept = [];
  let capturing = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*failed\s+\S/i.test(line)) capturing = true;
    else if (/^\s*stack trace:/i.test(line)) capturing = false;
    if (capturing && line.trim()) kept.push(line.trimEnd());
  }
  return kept.length > 0 ? `Failing tests:\n${kept.join('\n')}` : `Tests failed:\n${tail(output)}`;
}
