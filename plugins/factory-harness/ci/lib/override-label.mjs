// Override labels, shared by the checks that accept one. A label counts only when it's on the PR
// now, the person who last added it is allowed to approve overrides, and that person's latest
// decisive review approves the commit the check ran on. Who added it comes from the PR's issue
// events, not the Actions event payload, so a rerun of an old run sees the labels as they are now.
//
// The review ties the override to a diff: GitHub records the commit each review was submitted on,
// so a push after the approval leaves it on an older commit. Timestamps can't do this. An agent can
// push X, force-push back to A, wait for the owner to approve A, then fast-forward to X: X's first
// run, and every force-push event, came before the approval.
//
// GitHub doesn't let anyone approve their own PR, so on a PR the owner opened, the owner's label
// counts without a review. That's safe because the factory-apps-own-branches ruleset keeps the Apps
// off the owner's branches: every commit there is the owner's own.

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

/** Every review on the PR. Throws if there are too many to read. */
export async function fetchReviews({ apiUrl, repository, number, token, fetchImpl }) {
  const reviews = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await getJson(
      `${apiUrl}/repos/${repository}/pulls/${number}/reviews?per_page=${PAGE_SIZE}&page=${page}`, token, fetchImpl);
    reviews.push(...batch);
    if (batch.length < PAGE_SIZE) return reviews;
  }
  throw new Error(`PR #${number} has more than ${PAGE_SIZE * MAX_PAGES} reviews, so its approval can't be checked.`);
}

// A comment-only review neither approves nor withdraws an approval.
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Whether the user's latest decisive review approves `headSha`. Reviews come oldest first; ids break ties. */
export function approves(reviews, userId, headSha) {
  const latest = reviews
    .filter(review => review.user?.id === userId && DECISIVE.has(review.state))
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '') || a.id - b.id)
    .at(-1);
  return latest?.state === 'APPROVED' && latest.commit_id === headSha;
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
export function overridden(result, { label, appliedBy, allowedUserIds, approved, headSha }) {
  if (result.passed || !appliedBy) return result;
  if (allowedUserIds.includes(appliedBy.id) && !approved) {
    return {
      passed: false,
      lines: [...result.lines, `::error::${appliedBy.login} applied ${label}, but their latest review doesn't approve this commit (${headSha.slice(0, 7)}). An override counts only with an approval of the diff it covers: approve the PR, then re-run this check.`],
    };
  }
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

/**
 * Applies the PR's override label to a failing result: reads who applied it and their reviews,
 * then decides as `overridden` does. `api` is { apiUrl, repository, number, token, fetchImpl };
 * `authorId` is the user who opened the PR.
 */
export async function applyOverride(result, { label, allowedUserIds, api, headSha, authorId }) {
  if (result.passed) return result;
  const appliedBy = labelAppliedBy(await fetchIssueEvents(api), label);
  const allowed = appliedBy !== null && allowedUserIds.includes(appliedBy.id);
  const approved = allowed && (appliedBy.id === authorId || approves(await fetchReviews(api), appliedBy.id, headSha));
  return overridden(result, { label, appliedBy, allowedUserIds, approved, headSha });
}
