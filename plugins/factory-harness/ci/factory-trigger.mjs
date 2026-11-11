// Decides whether an issue event starts a factory agent run, and builds the agent's input.
//
// Only the owner starts a run: by applying the role's label, or, for a role that takes replies, by
// commenting on an issue that has the label. The input comes from the API at run time, not from the
// event payload, and holds only text the owner or the role's App wrote, so nobody else's words reach
// the agent. The issue must have been opened by the owner, since its author can edit its body.
//
// Usage: node factory-trigger.mjs <role> <input file>
// Environment: OWNER_USER_IDS, APP_LOGIN (such as berbevans-factory-spec[bot]), GITHUB_EVENT_NAME,
// GITHUB_EVENT_PATH, GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN (issues read), GITHUB_OUTPUT.
// Writes run=true and issue=<number> to GITHUB_OUTPUT when the run should start, else run=false.

import fs from 'node:fs';
import path from 'node:path';
import { getJson, parseUserIds, runIfMain } from './lib/pull-request.mjs';

export const ROLES = {
  spec: { label: 'needs-spec', takesComments: true },
  implement: { label: 'ready', takesComments: false },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

const hasLabel = (issue, label) => (issue.labels ?? []).some(l => (l.name ?? l).toLowerCase() === label.toLowerCase());
const skip = reason => ({ run: false, reason });

/** Decides from the event alone whether it could start the role's run. Returns { run, reason }. */
export function decideTrigger({ role, eventName, event, ownerUserIds }) {
  const { label, takesComments } = ROLES[role] ?? {};
  if (!label) throw new Error(`Unknown role "${role}". Known roles: ${Object.keys(ROLES).join(', ')}.`);
  const issue = event.issue;
  if (!issue) return skip(`A ${eventName} event has no issue.`);
  if (issue.pull_request) return skip(`#${issue.number} is a pull request, not an issue.`);

  if (eventName === 'issues' && event.action === 'labeled') {
    if (event.label?.name?.toLowerCase() !== label) return skip(`The ${event.label?.name} label doesn't start the ${role} run.`);
    if (!ownerUserIds.includes(event.sender?.id)) return skip(`${event.sender?.login} applied ${label}, and only the owner can start a run.`);
    return { run: true, reason: `The owner applied ${label} to #${issue.number}.` };
  }
  if (eventName === 'issue_comment' && event.action === 'created' && takesComments) {
    if (!ownerUserIds.includes(event.comment?.user?.id)) return skip(`The comment is by ${event.comment?.user?.login}, not the owner.`);
    if (!hasLabel(issue, label)) return skip(`#${issue.number} doesn't have the ${label} label.`);
    return { run: true, reason: `The owner commented on #${issue.number}, which has ${label}.` };
  }
  return skip(`A ${eventName} ${event.action} event doesn't start the ${role} run.`);
}

/** Checks the issue as it is now. Returns a reason to skip, or null to run. */
export function issueProblem({ role, issue, ownerUserIds }) {
  if (!ownerUserIds.includes(issue.user?.id)) {
    return `#${issue.number} was opened by ${issue.user?.login}, who can edit its body. Only the owner's issues run.`;
  }
  if (issue.state !== 'open') return `#${issue.number} is ${issue.state}.`;
  if (!hasLabel(issue, ROLES[role].label)) return `#${issue.number} no longer has the ${ROLES[role].label} label.`;
  return null;
}

/** True for a comment the agent may read: the owner's, or the role's App's own. */
export const isTrusted = (comment, { ownerUserIds, appLogin }) =>
  ownerUserIds.includes(comment.user?.id) || (comment.user?.type === 'Bot' && comment.user?.login === appLogin);

/** The agent's input, as Markdown: the issue and the trusted comments, oldest first. */
export function buildInput({ issue, comments, ownerUserIds, appLogin }) {
  const trusted = comments.filter(comment => isTrusted(comment, { ownerUserIds, appLogin }));
  const left = comments.length - trusted.length;
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    '',
    issue.body?.trim() || '(The issue has no description.)',
    '',
    '## Comments',
    '',
    ...(trusted.length === 0 ? ['(No comments.)', ''] : trusted.flatMap(comment => [
      `### ${comment.user.type === 'Bot' ? 'The factory' : 'The owner'}, ${comment.created_at}`, '', comment.body.trim(), '',
    ])),
    ...(left > 0 ? [`(${left} comment${left === 1 ? '' : 's'} by other people left out.)`, ''] : []),
  ].join('\n');
}

export async function fetchComments({ apiUrl, repository, number, token, fetchImpl }) {
  const comments = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await getJson(
      `${apiUrl}/repos/${repository}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`, token, fetchImpl);
    comments.push(...batch);
    if (batch.length < PAGE_SIZE) return comments;
  }
  throw new Error(`#${number} has more than ${PAGE_SIZE * MAX_PAGES} comments, so its input can't be built.`);
}

/** Decides, then builds the input file. Resolves to { passed, lines, outputs } for the action. */
export async function run({ role, inputFile, env, fetchImpl = fetch, readEvent = file => JSON.parse(fs.readFileSync(file, 'utf8')) }) {
  const ownerUserIds = parseUserIds(env.OWNER_USER_IDS, 'OWNER_USER_IDS');
  if (!env.APP_LOGIN) throw new Error('APP_LOGIN is empty, so the App\'s own comments can\'t be recognised.');
  const decision = decideTrigger({ role, eventName: env.GITHUB_EVENT_NAME, event: readEvent(env.GITHUB_EVENT_PATH), ownerUserIds });
  if (!decision.run) return { passed: true, lines: [`Not starting: ${decision.reason}`], outputs: { run: 'false' } };

  const number = readEvent(env.GITHUB_EVENT_PATH).issue.number;
  const api = { apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, number, token: env.GITHUB_TOKEN, fetchImpl };
  const issue = await getJson(`${api.apiUrl}/repos/${api.repository}/issues/${number}`, api.token, fetchImpl);
  const problem = issueProblem({ role, issue, ownerUserIds });
  if (problem) return { passed: true, lines: [`Not starting: ${problem}`], outputs: { run: 'false' } };

  const comments = await fetchComments(api);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, buildInput({ issue, comments, ownerUserIds, appLogin: env.APP_LOGIN }));
  return { passed: true, lines: [decision.reason], outputs: { run: 'true', issue: String(number) } };
}

await runIfMain(import.meta.url, async env => {
  const [role, inputFile] = process.argv.slice(2);
  if (!role || !inputFile) throw new Error('Usage: factory-trigger.mjs <role> <input file>');
  const result = await run({ role, inputFile, env });
  const outputs = Object.entries(result.outputs).map(([key, value]) => `${key}=${value}\n`).join('');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
  return result;
});
