// CI backstop for the guardrail-files hook rule. Fails a PR that changes a guardrail file,
// unless its author is exempt: the people named in EXEMPT_USER_IDS, and Dependabot.

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

/** Decides the check from data already fetched. Returns { passed, lines }. */
export function evaluate({ author, files, changedFileCount, exemptUserIds }) {
  if (isExempt(author, exemptUserIds)) return exemptResult(author, CHECK_NAME);
  const incomplete = incompleteListing(files, changedFileCount);
  if (incomplete) return incomplete;

  const touched = guardrailPathsTouched(files);
  if (touched.length === 0) return { passed: true, lines: ['No guardrail files changed.'] };
  return {
    passed: false,
    lines: [...touched.map(path => annotation(path, `${path} is a guardrail file.`)), FIX],
  };
}

export const run = options => runOnPullRequest({ checkName: CHECK_NAME, evaluate, ...options });

await runIfMain(import.meta.url, env => run({ env }));
