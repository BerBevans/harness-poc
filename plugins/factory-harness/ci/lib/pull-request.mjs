// What every CI check on a pull request shares: reading the PR from the Actions event,
// deciding who is exempt, listing the changed files from the API, and reporting.
//
// Checks run on pull_request_target, which uses the workflow from the target branch, so a PR
// can't edit a check out of its own run. That event runs with the repo's token, so checks never
// check out or run the PR's code: they read what they need from the API.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Dependabot bumps action and package versions. New packages are caught by the package check.
export const DEPENDABOT_USER_ID = 49699333;

const PAGE_SIZE = 100;
// The pull request files API returns at most 3,000 files.
const MAX_PAGES = 30;

/** Parses a comma- or space-separated list of numeric GitHub user IDs. */
export function parseUserIds(text, name = 'EXEMPT_USER_IDS') {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error(`${name} is empty. Name at least the repo owner.`);
  const bad = parts.find(part => !/^\d+$/.test(part));
  if (bad) throw new Error(`${name} must hold numeric user IDs, not logins: "${bad}".`);
  return parts.map(Number);
}

export function isExempt(author, exemptUserIds) {
  return exemptUserIds.includes(author.id) || (author.type === 'Bot' && author.id === DEPENDABOT_USER_ID);
}

export const exemptResult = (author, checkName) =>
  ({ passed: true, lines: [`${author.login} is exempt from the ${checkName}.`] });

/** A failing result when the API listed fewer files than the PR changed, otherwise null. */
export function incompleteListing(files, changedFileCount) {
  if (files.length === changedFileCount) return null;
  return {
    passed: false,
    lines: [`Listed ${files.length} of the ${changedFileCount} changed files, so the PR can't be checked. ` +
      'Split it into smaller PRs.'],
  };
}

/** Reads JSON from the GitHub API. Throws on any error status. */
export async function getJson(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}.`);
  return response.json();
}

export async function fetchChangedFiles({ apiUrl, repository, number, token, fetchImpl = fetch }) {
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiUrl}/repos/${repository}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`;
    const batch = await getJson(url, token, fetchImpl);
    files.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return files;
}

/**
 * Reads the PR and its changed files from the Actions environment, then hands them to `evaluate`.
 * Throws if the check can't decide.
 */
export async function runOnPullRequest({
  checkName, evaluate, env, readEvent = path => JSON.parse(readFileSync(path, 'utf8')), fetchImpl,
}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    throw new Error(`The ${checkName} must run on pull_request_target, not ${env.GITHUB_EVENT_NAME}. ` +
      'On pull_request, a PR could change the workflow that runs the check.');
  }
  const exemptUserIds = parseUserIds(env.EXEMPT_USER_IDS);
  const pr = readEvent(env.GITHUB_EVENT_PATH).pull_request;
  const files = await fetchChangedFiles({
    apiUrl: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY,
    number: pr.number,
    token: env.GITHUB_TOKEN,
    fetchImpl,
  });
  return evaluate({ author: pr.user, files, changedFileCount: pr.changed_files, exemptUserIds });
}

/** Formats a GitHub Actions error annotation, so it shows against the file (and line) in the PR. */
export function annotation(path, message, line) {
  const escapeProperty = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
    .replace(/:/g, '%3A').replace(/,/g, '%2C');
  const location = line === undefined ? '' : `,line=${line}`;
  return `::error file=${escapeProperty(path)}${location}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`;
}

/** Runs `check` when `moduleUrl` is the script node was started with. Fails closed on any error. */
export async function runIfMain(moduleUrl, check) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  try {
    const result = await check(process.env);
    for (const line of result.lines) console.log(line);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    // A check that can't decide must not pass.
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
