// CI backstop for the suppressions hook rule. Fails a PR that adds suppressions to C# code or
// weakening properties to project files, unless its author is exempt: the people named in
// EXEMPT_USER_IDS, and Dependabot.
//
// It counts across the whole PR: for each rule, occurrences in added lines against occurrences
// in removed lines. Moving a method and its suppression to another file is therefore allowed.

import { PROJECT_FILE_SUPPRESSIONS, suppressionRulesFor } from '../hooks/rules/suppressions.mjs';
import { normalisePath } from '../hooks/lib/paths.mjs';
import { annotation, exemptResult, incompleteListing, isExempt, runIfMain, runOnPullRequest } from './lib/pull-request.mjs';

const CHECK_NAME = 'suppression scan';

const FIX =
  'Suppressions are not allowed; fix the underlying warning or test instead. Build settings belong in the ' +
  "shared Directory.Build.props, which is human-owned, so remove them from project files. If you believe a " +
  "suppression or setting is needed, don't add it: comment on the issue to explain why.";

const BUILD_SETTINGS = new Set(PROJECT_FILE_SUPPRESSIONS.map(rule => rule.name));

// A project-file match may switch a setting on, not off, so it isn't called a suppression.
const describe = name => BUILD_SETTINGS.has(name)
  ? `Sets ${name}, a build setting only the shared Directory.Build.props may set.`
  : `Adds a suppression: ${name}.`;

/**
 * Splits a unified diff hunk list, as the API's `patch` field gives it, into added and removed text.
 * `lineStarts` maps each added line's offset in `addedText` to its line number in the new file.
 */
export function parsePatch(patch) {
  const added = [];
  const lineStarts = [];
  const removed = [];
  let newLine = 0;
  let offset = 0;

  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
    } else if (line.startsWith('+')) {
      lineStarts.push({ offset, line: newLine });
      added.push(line.slice(1));
      offset += line.length; // the text without '+', plus the joining newline
      newLine++;
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1));
    } else if (!line.startsWith('\\')) {
      newLine++; // a context line
    }
  }
  return { addedText: added.join('\n'), removedText: removed.join('\n'), lineStarts };
}

// The line number of the added line that holds the character at `index`.
function lineAt(lineStarts, index) {
  let found = lineStarts[0];
  for (const start of lineStarts) {
    if (start.offset > index) break;
    found = start;
  }
  return found.line;
}

// Files whose diff we must see: any file a suppression rule applies to that gains lines.
// A file that only loses lines can't add a suppression, so a missing diff there is harmless.
const needsDiff = file => file.additions > 0 && suppressionRulesFor(normalisePath(file.filename)).length > 0;

/** Decides the check from data already fetched. Returns { passed, lines }. */
export function evaluate({ author, files, changedFileCount, exemptUserIds }) {
  if (isExempt(author, exemptUserIds)) return exemptResult(author, CHECK_NAME);
  const incomplete = incompleteListing(files, changedFileCount);
  if (incomplete) return incomplete;

  const unreadable = files.filter(file => needsDiff(file) && typeof file.patch !== 'string');
  if (unreadable.length > 0) {
    return {
      passed: false,
      lines: [
        ...unreadable.map(file => annotation(file.filename, "GitHub didn't return this file's diff, so it can't be scanned.")),
        'GitHub leaves out the diff for very large or binary changes. Split the change into smaller PRs.',
      ],
    };
  }

  // For each rule: where it appears in added lines, and how often it appears in removed lines.
  const tally = new Map();
  for (const file of files) {
    const rules = suppressionRulesFor(normalisePath(file.filename));
    if (rules.length === 0 || typeof file.patch !== 'string') continue;
    const { addedText, removedText, lineStarts } = parsePatch(file.patch);
    for (const rule of rules) {
      const entry = tally.get(rule.name) ?? { added: [], removedCount: 0 };
      for (const match of addedText.matchAll(rule.pattern)) {
        entry.added.push({ path: file.filename, line: lineAt(lineStarts, match.index) });
      }
      entry.removedCount += (removedText.match(rule.pattern) ?? []).length;
      tally.set(rule.name, entry);
    }
  }

  const failures = [...tally].filter(([, entry]) => entry.added.length > entry.removedCount);
  if (failures.length === 0) return { passed: true, lines: ['No new suppressions.'] };

  // We can't tell which occurrence is the new one, so every added occurrence is reported.
  const lines = failures.flatMap(([name, entry]) =>
    entry.added.map(({ path, line }) => annotation(path, describe(name), line)));
  return { passed: false, lines: [...lines, FIX] };
}

export const run = options => runOnPullRequest({ checkName: CHECK_NAME, evaluate, ...options });

await runIfMain(import.meta.url, env => run({ env }));
