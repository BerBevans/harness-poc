// CI backstop for the guardrail-files hook rule. Fails a PR that changes a guardrail file,
// unless its author is exempt: the people named in EXEMPT_USER_IDS, and Dependabot. It also fails
// any PR, from anyone, that commits a Claude Code local settings file.

import { isGuardrailPath } from '../hooks/rules/guardrail-files.mjs';
import { normalisePath } from '../hooks/lib/paths.mjs';
import { annotation, exemptResult, incompleteListing, isExempt, runIfMain, runOnPullRequest } from './lib/pull-request.mjs';

const CHECK_NAME = 'guardrail path check';

const FIX =
  'Guardrail files are human-owned and change only through the harness repo. ' +
  'Revert these changes, then comment on the issue to explain what you needed.';

/** Every guardrail path a PR touches. A renamed file counts under its old name and its new one. */
export function guardrailPathsTouched(files) {
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  return [...new Set(paths)].filter(path => isGuardrailPath(normalisePath(path)));
}

// Claude Code's per-user settings file. Its approved and blocked commands can hold secrets in plain
// text, so nobody may commit one, exempt people included.
const LOCAL_SETTINGS = 'settings.local.json';

const LOCAL_SETTINGS_FIX =
  `A ${LOCAL_SETTINGS} file must never be committed: it can hold secrets. Remove it from the PR, ` +
  'add it to .gitignore, and rotate any secret it held. Nobody is exempt from this rule.';

/**
 * Every local settings file a PR adds, changes or renames. Deleting one passes, so a leak can be
 * cleaned up. A rename counts under its old name too, because the content moves with it.
 */
export function localSettingsCommitted(files) {
  const isLocalSettings = path => normalisePath(path).split('/').pop() === LOCAL_SETTINGS;
  const paths = files
    .filter(file => file.status !== 'removed')
    .flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  return [...new Set(paths)].filter(isLocalSettings);
}

/** Decides the check from data already fetched. Returns { passed, lines }. */
export function evaluate({ author, files, changedFileCount, exemptUserIds }) {
  // Checked before the exemption, so an unlisted file can't hide a local settings file from anyone.
  const incomplete = incompleteListing(files, changedFileCount);
  if (incomplete) return incomplete;

  const committed = localSettingsCommitted(files);
  if (committed.length > 0) {
    const found = committed.map(path => annotation(path, `${path} is Claude Code's local settings file.`));
    return { passed: false, lines: [...found, LOCAL_SETTINGS_FIX] };
  }
  if (isExempt(author, exemptUserIds)) return exemptResult(author, CHECK_NAME);

  const touched = guardrailPathsTouched(files);
  if (touched.length === 0) return { passed: true, lines: ['No guardrail files changed.'] };
  return {
    passed: false,
    lines: [...touched.map(path => annotation(path, `${path} is a guardrail file.`)), FIX],
  };
}

export const run = options => runOnPullRequest({ checkName: CHECK_NAME, evaluate, ...options });

await runIfMain(import.meta.url, env => run({ env }));
