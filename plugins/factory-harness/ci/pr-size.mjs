// The PR size check. Counts changed lines, added plus removed, and fails a PR above the hard
// limit unless someone in OVERRIDE_USER_IDS applied the size-override label. Its author is exempt
// if named in EXEMPT_USER_IDS, or Dependabot.
//
// Whitespace doesn't count: blank lines are skipped, and within each hunk a removed line and an
// added line that match once whitespace is stripped cancel out, so reindenting a block is free.
// Generated files that a .NET repo commits are left out by name; nothing else is.

import { fetchIssueEvents, labelAppliedBy, overridden } from './lib/override-label.mjs';
import {
  annotation, exemptResult, incompleteListing, isExempt, parseUserIds, runIfMain, runOnPullRequest,
} from './lib/pull-request.mjs';

const CHECK_NAME = 'PR size check';
export const OVERRIDE_LABEL = 'size-override';
export const TARGET = 200;
export const ACCEPTABLE = 250;
export const LIMIT = 300;

const LARGEST_FILES_SHOWN = 10;

const FIX =
  'Split it into smaller PRs that each make sense on their own, rather than chopping one change into pieces ' +
  "to pass. If it can't be split and is still easy to review, comment on the issue to explain why. " +
  `Don't apply ${OVERRIDE_LABEL} yourself.`;

// Case-sensitive on purpose: NuGet and EF Core write these exact names, and any other spelling
// isn't generated, so it counts.
export function isGenerated(filename) {
  const parts = filename.split('/');
  const name = parts.at(-1);
  if (name === 'packages.lock.json') return true;
  const inMigrations = parts.slice(0, -1).includes('Migrations');
  return inMigrations && (name.endsWith('.Designer.cs') || name.endsWith('ModelSnapshot.cs'));
}

const stripWhitespace = line => line.replace(/\s+/g, '');

// The length of the longest common subsequence of two lists of lines.
function commonLength(a, b) {
  let previous = new Array(b.length + 1).fill(0);
  for (const lineA of a) {
    const current = [0];
    for (let j = 0; j < b.length; j++) {
      current.push(lineA === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Changed lines in one file's patch, ignoring whitespace. */
export function countPatch(patch) {
  const hunks = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      hunks.push({ added: [], removed: [] });
    } else if (hunks.length > 0 && (line.startsWith('+') || line.startsWith('-'))) {
      const text = stripWhitespace(line.slice(1));
      if (text !== '') (line.startsWith('+') ? hunks.at(-1).added : hunks.at(-1).removed).push(text);
    }
  }
  return hunks.reduce((total, { added, removed }) =>
    total + added.length + removed.length - 2 * commonLength(removed, added), 0);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Decides the check, before any override label. Returns { passed, lines }. */
export function evaluate({ author, files, changedFileCount, exemptUserIds }) {
  if (isExempt(author, exemptUserIds)) return exemptResult(author, CHECK_NAME);
  const incomplete = incompleteListing(files, changedFileCount);
  if (incomplete) return incomplete;

  const counted = files.filter(file => !isGenerated(file.filename));
  const generatedCount = files.length - counted.length;

  // A binary file has no patch and no line counts. A text file without a patch is one GitHub
  // considered too large to show, so it can't be counted.
  const unreadable = counted.filter(file => typeof file.patch !== 'string' && file.additions + file.deletions > 0);
  if (unreadable.length > 0) {
    return {
      passed: false,
      lines: [
        ...unreadable.map(file => annotation(file.filename, "GitHub didn't return this file's diff, so its lines can't be counted.")),
        `GitHub leaves out the diff for very large changes. ${FIX}`,
      ],
    };
  }

  const sizes = counted
    .map(file => ({ filename: file.filename, lines: typeof file.patch === 'string' ? countPatch(file.patch) : 0 }))
    .filter(size => size.lines > 0)
    .sort((a, b) => b.lines - a.lines || a.filename.localeCompare(b.filename));
  const total = sizes.reduce((sum, size) => sum + size.lines, 0);

  const excluded = generatedCount > 0 ? `, leaving out ${plural(generatedCount, 'generated file')}` : '';
  const summary = `${plural(total, 'changed line')}, not counting whitespace${excluded}. ` +
    `The target is ${TARGET}, ${ACCEPTABLE} is acceptable and ${LIMIT} is the limit.`;

  if (total <= ACCEPTABLE) return { passed: true, lines: [summary] };
  if (total <= LIMIT) return { passed: true, lines: [`::warning::${summary}`] };

  const largest = sizes.slice(0, LARGEST_FILES_SHOWN).map(size => `  ${size.lines}  ${size.filename}`);
  return { passed: false, lines: [`::error::${summary}`, 'Largest changes:', ...largest, FIX] };
}

export async function run({ env, fetchImpl, ...options }) {
  // Checked first, so a misconfigured workflow fails even on a small PR.
  const allowedUserIds = parseUserIds(env.OVERRIDE_USER_IDS, 'OVERRIDE_USER_IDS');
  return runOnPullRequest({
    checkName: CHECK_NAME,
    env,
    fetchImpl,
    ...options,
    evaluate: async ({ number, ...pullRequest }) => {
      const result = evaluate(pullRequest);
      if (result.passed) return result;
      const events = await fetchIssueEvents({
        apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, number, token: env.GITHUB_TOKEN, fetchImpl,
      });
      return overridden(result, { label: OVERRIDE_LABEL, appliedBy: labelAppliedBy(events, OVERRIDE_LABEL), allowedUserIds });
    },
  });
}

await runIfMain(import.meta.url, env => run({ env }));
