// CI backstop for the suppressions hook rule. Fails a PR that adds suppressions to C# code or
// weakening properties to project files, unless its author is exempt: the people named in
// EXEMPT_USER_IDS, and Dependabot.
//
// It compares across the whole PR: for each rule, the added lines it matches against the removed
// lines it matches, as whole lines with whitespace normalised. Moving a method and its suppression
// to another file is therefore allowed; widening a suppression, or swapping it for another, isn't.
// A removed `#pragma warning restore` or `#nullable restore`/`enable` with no equal one added to the
// same file fails too.

import {
  CODE_SUPPRESSIONS, kindOf, lineMatcher, normaliseLine, RESTORE, suppressionRulesFor, unmatched,
} from '../hooks/rules/suppressions.mjs';
import { normalisePath } from '../hooks/lib/paths.mjs';
import { annotation, exemptResult, incompleteListing, isExempt, runIfMain, runOnPullRequest } from './lib/pull-request.mjs';

const CHECK_NAME = 'suppression scan';

const FIX =
  'Suppressions are not allowed; fix the underlying warning or test instead. Code excluded from coverage ' +
  'needs tests instead. Build settings belong in the ' +
  "shared Directory.Build.props, which is human-owned, so remove them from project files. If you believe a " +
  "suppression or setting is needed, don't add it: comment on the issue to explain why.";

// A project-file match may switch a setting on, not off, so it isn't called a suppression.
const DESCRIPTIONS = {
  'build-setting': name => `Sets ${name}, a build setting only the shared Directory.Build.props may set.`,
  'coverage-exclusion': name => `Excludes code from coverage: ${name}.`,
  'suppression': name => `Adds a suppression: ${name}.`,
};
const describeRestore = () => 'Removes a #pragma warning restore or #nullable restore, which widens a suppression to the end of the file.';
const describe = name => DESCRIPTIONS[kindOf(name)](name);

/**
 * Splits a unified diff hunk list, as the API's `patch` field gives it, into added and removed text.
 * `lineStarts` maps each added line's offset in `addedText` to its line number in the new file;
 * `addedLines` pairs each added line with its line number.
 */
export function parsePatch(patch) {
  const added = [];
  const addedLines = [];
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
      addedLines.push({ text: line.slice(1), line: newLine });
      offset += line.length; // the text without '+', plus the joining newline
      newLine++;
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1));
    } else if (!line.startsWith('\\')) {
      newLine++; // a context line
    }
  }
  return { addedText: added.join('\n'), removedText: removed.join('\n'), lineStarts, addedLines, removedLines: removed };
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

  // For each rule: the added lines it matches, with where they are, and the removed lines it matches.
  const tally = new Map();
  const restores = { added: [], removed: [] };
  for (const file of files) {
    const path = normalisePath(file.filename);
    const rules = suppressionRulesFor(path);
    if (rules.length === 0 || typeof file.patch !== 'string') continue;
    const { addedLines, removedLines } = parsePatch(file.patch);
    const added = addedLines.map(({ text, line }) => ({ text: normaliseLine(text), path: file.filename, line }));
    const removed = removedLines.map(normaliseLine);
    for (const rule of rules) {
      const counts = lineMatcher(rule, path);
      const entry = tally.get(rule.name) ?? { added: [], removed: [] };
      entry.added.push(...added.filter(a => counts(a.text)));
      entry.removed.push(...removed.filter(counts));
      tally.set(rule.name, entry);
    }
    if (rules === CODE_SUPPRESSIONS) {
      const counts = lineMatcher(RESTORE, path);
      restores.added.push(...added.filter(a => counts(a.text)).map(a => `${file.filename}\0${a.text}`));
      restores.removed.push(...removed.filter(counts).map(text => ({ text, path: file.filename })));
    }
  }

  // Each added line is paired off with an equal removed line; those left over are new.
  const text = item => item.text;
  const lines = [
    ...[...tally].flatMap(([name, entry]) => unmatched(entry.added, entry.removed, text)
      .map(({ path, line }) => annotation(path, describe(name), line))),
    ...unmatched(restores.removed, restores.added, r => `${r.path}\0${r.text}`).map(({ path }) => annotation(path, describeRestore())),
  ];
  if (lines.length === 0) return { passed: true, lines: ['No new suppressions.'] };
  return { passed: false, lines: [...lines, FIX] };
}

export const run = options => runOnPullRequest({ checkName: CHECK_NAME, evaluate, ...options });

await runIfMain(import.meta.url, env => run({ env }));
