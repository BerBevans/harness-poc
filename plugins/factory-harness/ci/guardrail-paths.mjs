// CI backstop for the guardrail-files hook rule. Fails a PR that changes a guardrail file,
// unless its author is exempt: the people named in EXEMPT_USER_IDS, and Dependabot.
//
// It must run on pull_request_target, which uses the workflow from the target branch, so a PR
// can't edit the check out of its own run. That event runs with the repo's token, so this
// script never checks out or runs the PR's code: it reads the changed files from the API.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isGuardrailPath } from '../hooks/rules/guardrail-files.mjs';
import { normalisePath } from '../hooks/lib/paths.mjs';

// Dependabot bumps action and package versions, which live in guardrail files. New packages
// are caught by the package check instead.
const DEPENDABOT_USER_ID = 49699333;

const PAGE_SIZE = 100;
// The pull request files API returns at most 3,000 files.
const MAX_PAGES = 30;

const FIX =
  'Guardrail files are human-owned and change only through the harness repo. ' +
  'Revert these changes, then comment on the issue to explain what you needed.';

/** Parses a comma- or space-separated list of numeric GitHub user IDs. */
export function parseUserIds(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('EXEMPT_USER_IDS is empty. Name at least the repo owner.');
  const bad = parts.find(part => !/^\d+$/.test(part));
  if (bad) throw new Error(`EXEMPT_USER_IDS must hold numeric user IDs, not logins: "${bad}".`);
  return parts.map(Number);
}

export function isExempt(author, exemptUserIds) {
  return exemptUserIds.includes(author.id) || (author.type === 'Bot' && author.id === DEPENDABOT_USER_ID);
}

/** Every guardrail path a PR touches. A renamed file counts under its old name and its new one. */
export function guardrailPathsTouched(files) {
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  return [...new Set(paths)].filter(path => isGuardrailPath(normalisePath(path)));
}

/** Decides the check from data already fetched. Returns { passed, lines }. */
export function evaluate({ author, files, changedFileCount, exemptUserIds }) {
  if (isExempt(author, exemptUserIds)) {
    return { passed: true, lines: [`${author.login} is exempt from the guardrail path check.`] };
  }
  if (files.length !== changedFileCount) {
    return {
      passed: false,
      lines: [`Listed ${files.length} of the ${changedFileCount} changed files, so the PR can't be checked. ` +
        'Split it into smaller PRs.'],
    };
  }

  const touched = guardrailPathsTouched(files);
  if (touched.length === 0) return { passed: true, lines: ['No guardrail files changed.'] };
  return {
    passed: false,
    lines: [...touched.map(path => annotation(path, `${path} is a guardrail file.`)), FIX],
  };
}

export async function fetchChangedFiles({ apiUrl, repository, number, token, fetchImpl = fetch }) {
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiUrl}/repos/${repository}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}.`);
    const batch = await response.json();
    files.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return files;
}

/** Runs the whole check from the Actions environment. Throws if it can't decide. */
export async function run({ env, readEvent = path => JSON.parse(readFileSync(path, 'utf8')), fetchImpl }) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    throw new Error(`The guardrail path check must run on pull_request_target, not ${env.GITHUB_EVENT_NAME}. ` +
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

// Formats a GitHub Actions error annotation, so each path shows against the file in the PR.
function annotation(path, message) {
  const escapeProperty = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
    .replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::error file=${escapeProperty(path)}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run({ env: process.env });
    for (const line of result.lines) console.log(line);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    // Fail closed: a check that can't decide must not pass.
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
