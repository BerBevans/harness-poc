// The "what to do instead" that ends every block. Headless runs get FACTORY_ISSUE from
// the workflow; interactive sessions don't, so they are told to explain to the user.

export const PROGRESS_NOTE_PATH = '.factory/progress.md';
export const PROGRESS_STATUSES = ['blocked: awaiting answer', 'paused: work in progress'];

const progressNoteInstruction =
  `write ${PROGRESS_NOTE_PATH} with the line "Status: ${PROGRESS_STATUSES[0]}" and where you got to, ` +
  'and commit it with your work in progress';

/** For guardrail blocks: stop, don't look for a way round. */
export function nextStepAfterBlock(env) {
  const issue = env.FACTORY_ISSUE?.trim();
  if (issue) {
    return `Do not look for another way round this. Stop, comment on issue #${issue} explaining what you were ` +
      `trying to do and why, then ${progressNoteInstruction}.`;
  }
  return 'Do not look for another way round this. Stop and tell the user what you were trying to do and why; ' +
    'if the change is needed, they will make it themselves.';
}

/** For a refused stop: fix the failures, or record why you can't. */
export function nextStepAfterFailedChecks(env) {
  const issue = env.FACTORY_ISSUE?.trim();
  const explain = issue ? `comment on issue #${issue} explaining the blocker` : 'tell the user what is blocking you';
  return `Fix the failures, then stop again. If you can't fix them, ${explain}, then ${progressNoteInstruction}.`;
}
