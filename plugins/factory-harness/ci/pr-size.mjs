// The PR size check. Counts changed lines, added plus removed, and fails a PR above the hard
// limit unless someone in OVERRIDE_USER_IDS applied the size-override label. Its author is exempt
// if named in EXEMPT_USER_IDS, or Dependabot.
//
// Whitespace doesn't count: blank lines are skipped, and within each hunk a removed line and an
// added line that match once whitespace is stripped cancel out, so reindenting a block is free.
// Generated files that a .NET repo commits are left out by name. The only other file left out is
// the implementer's spec copy, and only while it matches the issue's current spec exactly, so it
// can't hold anything else.

import { fetchIssueEvents, labelAppliedBy, overridden } from './lib/override-label.mjs';
import {
  annotation, exemptResult, getJson, incompleteListing, isExempt, parseUserIds, runIfMain, runOnPullRequest,
} from './lib/pull-request.mjs';
import { normaliseSpec, specFromBody } from './lib/spec-body.mjs';

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

const FACTORY_BRANCH = /^factory\/issue-(\d+)$/;

/** The issue a factory branch in this repo works on, and its spec copy's path pattern; else null. */
export function specCopyPattern(head, repository) {
  const issue = FACTORY_BRANCH.exec(head?.ref ?? '')?.[1];
  if (!issue || head.repo?.full_name !== repository) return null;
  return { issue, pattern: new RegExp(`^docs/specs/${issue}-[a-z0-9-]+\\.md$`) };
}

// An added file's patch is one hunk holding the whole file, every line prefixed with "+".
function addedFileText(patch) {
  const lines = patch.split('\n');
  if (!lines[0].startsWith('@@') || lines.slice(1).some(line => line.startsWith('@@'))) return null;
  return lines.slice(1).filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
}

/**
 * The changed files that are the issue's spec copy, identical to the issue's current spec. The copy
 * is new in every factory PR, since it reaches the target branch only when the PR merges, so its
 * patch holds the whole file. A copy that already exists on the target branch counts.
 */
export async function findSpecCopies({ head, files, env, fetchImpl }) {
  const copy = specCopyPattern(head, env.GITHUB_REPOSITORY);
  const candidates = copy
    ? files.filter(file => copy.pattern.test(file.filename) && file.status === 'added' && typeof file.patch === 'string')
    : [];
  if (candidates.length === 0) return [];
  const issueUrl = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/issues/${copy.issue}`;
  const spec = specFromBody((await getJson(issueUrl, env.GITHUB_TOKEN, fetchImpl)).body);
  if (spec === null) return [];
  return candidates
    .filter(file => { const text = addedFileText(file.patch); return text !== null && normaliseSpec(text) === spec; })
    .map(file => file.filename);
}

const stripWhitespace = line =>line.replace(/\s+/g, '');

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
export function evaluate({ author, files, changedFileCount, exemptUserIds, specCopies = [] }) {
  if (isExempt(author, exemptUserIds)) return exemptResult(author, CHECK_NAME);
  const incomplete = incompleteListing(files, changedFileCount);
  if (incomplete) return incomplete;

  const counted = files.filter(file => !isGenerated(file.filename) && !specCopies.includes(file.filename));
  const generatedCount = files.filter(file => isGenerated(file.filename)).length;

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

  const leftOut = [
    ...(generatedCount > 0 ? [plural(generatedCount, 'generated file')] : []),
    ...(specCopies.length > 0 ? ['the spec copy, which matches the issue'] : []),
  ];
  const excluded = leftOut.length > 0 ? `, leaving out ${leftOut.join(' and ')}` : '';
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
    evaluate: async ({ number, head, action, ...pullRequest }) => {
      const specCopies = isExempt(pullRequest.author, pullRequest.exemptUserIds)
        ? [] : await findSpecCopies({ head, files: pullRequest.files, env, fetchImpl });
      const result = evaluate({ ...pullRequest, specCopies });
      if (result.passed) return result;
      const events = await fetchIssueEvents({
        apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, number, token: env.GITHUB_TOKEN, fetchImpl,
      });
      return overridden(result, { label: OVERRIDE_LABEL, appliedBy: labelAppliedBy(events, OVERRIDE_LABEL), allowedUserIds, eventAction: action });
    },
  });
}

await runIfMain(import.meta.url, env => run({ env }));
