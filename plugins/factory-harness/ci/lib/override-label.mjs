// Override labels, shared by the checks that accept one. A label counts only when it's on the PR
// now and the person who last added it is allowed to approve overrides. Who added it comes from
// the PR's issue events, not the Actions event payload, so a rerun of an old run sees the labels
// as they are now, not as they were when it first ran.

import { getJson } from './pull-request.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

/** Every issue event on the PR, oldest first. Throws if there are too many to read. */
export async function fetchIssueEvents({ apiUrl, repository, number, token, fetchImpl }) {
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await getJson(
      `${apiUrl}/repos/${repository}/issues/${number}/events?per_page=${PAGE_SIZE}&page=${page}`, token, fetchImpl);
    events.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    }
  }
  throw new Error(`PR #${number} has more than ${PAGE_SIZE * MAX_PAGES} events, so its labels can't be checked.`);
}

/**
 * Who last added the label, if it's on the PR now, replaying every time it was added and removed.
 * Returns the actor ({ login, id, type }) or null. Label names are compared ignoring case, as
 * GitHub does.
 */
export function labelAppliedBy(events, label) {
  let appliedBy = null;
  for (const event of events) {
    if (event.label?.name?.toLowerCase() !== label.toLowerCase()) continue;
    if (event.event === 'labeled') appliedBy = event.actor;
    if (event.event === 'unlabeled') appliedBy = null;
  }
  return appliedBy;
}

/**
 * Applies an override label to a check's failing result. An approved label turns it into a pass,
 * with its errors shown as warnings; a label anyone else applied is reported as an error.
 */
export function overridden(result, { label, appliedBy, allowedUserIds }) {
  if (result.passed || !appliedBy) return result;
  if (allowedUserIds.includes(appliedBy.id)) {
    return {
      passed: true,
      lines: [...result.lines.map(line => line.replace(/^::error/, '::warning')), `Accepted, because ${appliedBy.login} applied ${label}.`],
    };
  }
  return {
    passed: false,
    lines: [...result.lines, `::error::${appliedBy.login} applied ${label}, but only the repo owner's override counts. Don't apply override labels.`],
  };
}
