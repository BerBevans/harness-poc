// Posts a spec agent round: checks the agent's files, then replaces the issue body with the spec and
// comments, using the spec App's token. The agent never holds a GitHub token, so this script is the
// only thing that writes to the issue, and it posts nothing it hasn't checked.
//
// The owner's original request is kept below the spec in a collapsed section. This script carries
// it from round to round; the agent never writes it, so a round can't rewrite what was asked.
//
// Usage: node spec-post.mjs <run folder>
// Environment: AGENT_OUTCOME (the agent step's outcome), ISSUE_NUMBER, SECRET_VALUES (one per line,
// such as the Claude token), GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN (the App's, issues write).

import fs from 'node:fs';
import path from 'node:path';
import { getJson, runIfMain } from './lib/pull-request.mjs';

export const OUTCOMES = ['questions', 'complete', 'split'];
const AGENT_FILES = ['input.md', 'spec.md', 'comment.md', 'outcome.json'];
const MAX_SPEC = 50000;
const MAX_COMMENT = 4000;
// The PR size target. A spec estimated above it can't be complete: it must be split instead.
export const MAX_COMPLETE_LINES = 250;
const START = '<!-- factory:original-request -->';
const END = '<!-- /factory:original-request -->';

// Shapes of common credentials, for secrets whose values this step doesn't know.
const SECRET_SHAPES = [
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,})/],
  ['an Anthropic key or token', /\bsk-ant-[\w-]{20,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
];

/** What in the text looks like a secret: a known value, or a credential's shape. */
export function findSecrets(text, secretValues) {
  const found = secretValues.filter(value => value.length >= 8 && text.includes(value)).map(() => 'a secret value');
  return [...found, ...SECRET_SHAPES.filter(([, shape]) => shape.test(text)).map(([name]) => name)];
}

/** Reads and checks the agent's files. Returns { problem } or { outcome, estimatedLines, spec, comment }. */
export function readOutputs(dir, secretValues) {
  const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const extra = present.filter(name => !AGENT_FILES.includes(name));
  if (extra.length > 0) return { problem: `it wrote files it shouldn't have (${extra.join(', ')})` };
  const missing = AGENT_FILES.slice(1).filter(name => !present.includes(name));
  if (missing.length > 0) return { problem: `it didn't write ${missing.join(', ')}` };

  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(read('outcome.json'));
  } catch {
    return { problem: 'outcome.json isn\'t valid JSON' };
  }
  if (!OUTCOMES.includes(parsed?.outcome)) return { problem: `the outcome "${parsed?.outcome}" isn't one of ${OUTCOMES.join(', ')}` };
  if (!Number.isInteger(parsed.estimatedLines) || parsed.estimatedLines < 0) return { problem: 'the size estimate isn\'t a whole number' };
  if (parsed.outcome === 'complete' && parsed.estimatedLines > MAX_COMPLETE_LINES) {
    return { problem: `it marked the spec complete at about ${parsed.estimatedLines} lines, over the ${MAX_COMPLETE_LINES}-line target, so the outcome must be split` };
  }

  const spec = read('spec.md').trim();
  const comment = read('comment.md').trim();
  if (!spec || spec.length > MAX_SPEC) return { problem: `the spec is empty or over ${MAX_SPEC} characters` };
  if (!comment || comment.length > MAX_COMMENT) return { problem: `the comment is empty or over ${MAX_COMMENT} characters` };
  if (spec.includes(START) || spec.includes(END)) return { problem: 'the spec contains the original request markers' };

  const secrets = findSecrets(`${spec}\n${comment}\n${read('outcome.json')}`, secretValues);
  if (secrets.length > 0) return { problem: `its output looked like it held ${[...new Set(secrets)].join(' and ')}, so nothing was posted` };
  return { outcome: parsed.outcome, estimatedLines: parsed.estimatedLines, spec, comment };
}

/** The original request: the marked section of the current body, or the whole body on the first round. */
export function originalRequest(currentBody) {
  const body = currentBody ?? '';
  const start = body.indexOf(START);
  const end = body.indexOf(END, start);
  if (start >= 0 && end > start) return body.slice(start + START.length, end).trim();
  return body.trim();
}

export function composeBody(spec, currentBody) {
  const original = originalRequest(currentBody) || '(The issue had no description.)';
  return `${spec}\n\n<details>\n<summary>Original request</summary>\n\n${START}\n${original}\n${END}\n</details>\n`;
}

export const failureComment = problem =>
  `The spec agent's round didn't finish: ${problem}. The issue body is unchanged. ` +
  'Comment again to start another round, or check the workflow run.';

async function send(method, url, token, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${method} ${url}.`);
}

/** Checks and posts the round. Resolves to { passed, lines }. */
export async function run({ dir, env, fetchImpl = fetch }) {
  if (!/^\d+$/.test(env.ISSUE_NUMBER ?? '')) throw new Error(`ISSUE_NUMBER must be an issue number, not "${env.ISSUE_NUMBER}".`);
  const issueUrl = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/issues/${env.ISSUE_NUMBER}`;
  const secretValues = String(env.SECRET_VALUES ?? '').split('\n').map(value => value.trim()).filter(Boolean);
  const result = env.AGENT_OUTCOME === 'success'
    ? readOutputs(dir, secretValues)
    : { problem: 'the agent run failed or reached its turn cap' };

  if (result.problem) {
    await send('POST', `${issueUrl}/comments`, env.GITHUB_TOKEN, { body: failureComment(result.problem) }, fetchImpl);
    return { passed: false, lines: [`::error::Nothing posted but a failure comment: ${result.problem}.`] };
  }

  const issue = await getJson(issueUrl, env.GITHUB_TOKEN, fetchImpl);
  await send('PATCH', issueUrl, env.GITHUB_TOKEN, { body: composeBody(result.spec, issue.body) }, fetchImpl);
  await send('POST', `${issueUrl}/comments`, env.GITHUB_TOKEN, { body: result.comment }, fetchImpl);
  return { passed: true, lines: [`Posted the spec and a comment: ${result.outcome}, about ${result.estimatedLines} lines.`] };
}

await runIfMain(import.meta.url, env => {
  const [dir] = process.argv.slice(2);
  if (!dir) throw new Error('Usage: spec-post.mjs <run folder>');
  return run({ dir, env });
});
