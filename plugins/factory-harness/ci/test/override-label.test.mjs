import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverride, approves, fetchIssueEvents, fetchReviews, labelAppliedBy, overridden } from '../lib/override-label.mjs';

const OWNER = { login: 'owner', id: 1001, type: 'User' };
const AGENT = { login: 'factory-agent[bot]', id: 2002, type: 'Bot' };
const LABEL = 'coverage-override';

let clock = 0;
const event = (kind, actor, name = LABEL) =>
  ({ id: ++clock, event: kind, actor, label: { name }, created_at: new Date(Date.UTC(2026, 9, 20) + clock * 1000).toISOString() });

const failing = { passed: false, lines: ['::error::Line coverage fell by 1.00 percentage points.', 'Add tests.'] };

test('the label counts as applied by whoever last added it', () => {
  assert.deepEqual(labelAppliedBy([event('labeled', OWNER)], LABEL), OWNER);
  assert.deepEqual(labelAppliedBy([event('labeled', AGENT), event('unlabeled', OWNER), event('labeled', OWNER)], LABEL), OWNER);
});

test('a removed label is not applied, and an agent re-adding it is the one that counts', () => {
  assert.equal(labelAppliedBy([event('labeled', OWNER), event('unlabeled', AGENT)], LABEL), null);
  assert.deepEqual(labelAppliedBy([event('labeled', OWNER), event('unlabeled', AGENT), event('labeled', AGENT)], LABEL), AGENT);
});

test('other labels and other events are ignored; names match ignoring case', () => {
  const events = [event('labeled', OWNER, 'size-override'), { id: ++clock, event: 'committed', actor: AGENT }, event('labeled', OWNER, 'Coverage-Override')];
  assert.deepEqual(labelAppliedBy(events, LABEL), OWNER);
  assert.equal(labelAppliedBy([event('labeled', OWNER, 'size-override')], LABEL), null);
});

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
let reviewId = 0;
const review = (state, commit = HEAD, user = OWNER) =>
  ({ id: ++reviewId, user, state, commit_id: commit, submitted_at: new Date(Date.UTC(2026, 9, 20) + reviewId * 1000).toISOString() });

test('an approval counts only on the head commit, and only while it is the latest decisive review', () => {
  assert.equal(approves([review('APPROVED')], OWNER.id, HEAD), true);
  assert.equal(approves([review('APPROVED', OLD)], OWNER.id, HEAD), false);
  assert.equal(approves([review('APPROVED'), review('CHANGES_REQUESTED')], OWNER.id, HEAD), false);
  assert.equal(approves([review('DISMISSED')], OWNER.id, HEAD), false);
  assert.equal(approves([], OWNER.id, HEAD), false);
});

test('a comment after an approval leaves it standing, and someone else\'s approval is not the owner\'s', () => {
  assert.equal(approves([review('APPROVED'), review('COMMENTED')], OWNER.id, HEAD), true);
  assert.equal(approves([review('APPROVED', HEAD, AGENT)], OWNER.id, HEAD), false);
  assert.equal(approves([review('APPROVED', HEAD, AGENT), review('CHANGES_REQUESTED', HEAD, AGENT)], OWNER.id, HEAD), false);
});

test('order comes from submission time, not the order GitHub lists them in', () => {
  const approved = review('APPROVED');
  const changes = review('CHANGES_REQUESTED');
  assert.equal(approves([changes, approved], OWNER.id, HEAD), false);
});

test("an approved label passes the check, keeping its errors as warnings", () => {
  assert.deepEqual(overridden(failing, { label: LABEL, appliedBy: OWNER, allowedUserIds: [1001], approved: true, headSha: HEAD }), {
    passed: true,
    lines: ['::warning::Line coverage fell by 1.00 percentage points.', 'Add tests.', 'Accepted, because owner applied coverage-override.'],
  });
});

test('a label someone else applied still fails, and says so', () => {
  const result = overridden(failing, { label: LABEL, appliedBy: AGENT, allowedUserIds: [1001] });
  assert.equal(result.passed, false);
  assert.match(result.lines.at(-1), /factory-agent\[bot\] applied coverage-override, but only the repo owner's override counts/);
});

test('the owner\'s label without their approval of this commit fails, and says how to fix it', () => {
  const result = overridden(failing, { label: LABEL, appliedBy: OWNER, allowedUserIds: [1001], approved: false, headSha: HEAD });
  assert.equal(result.passed, false);
  assert.match(result.lines.at(-1), /owner applied coverage-override, but their latest review doesn't approve this commit \(aaaaaaa\)\..*approve the PR, then re-run this check/);
});

test('no label, or a passing check, is left as it is', () => {
  assert.equal(overridden(failing, { label: LABEL, appliedBy: null, allowedUserIds: [1001] }), failing);
  const passing = { passed: true, lines: ['Coverage held.'] };
  assert.equal(overridden(passing, { label: LABEL, appliedBy: AGENT, allowedUserIds: [1001] }), passing);
});

// A fake API serving `events` and `reviews` in pages of 100, events newest first, to show the order doesn't matter.
function fakeEventsApi(events, { status = 200, reviews = [] } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const items = url.includes('/reviews') ? reviews : events;
    return { ok: status === 200, status, json: async () => items.slice((page - 1) * 100, page * 100) };
  };
  return { urls, fetchImpl };
}

const fetchArgs = fetchImpl => ({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl });

test('reads every page of events and sorts them oldest first', async () => {
  const events = Array.from({ length: 150 }, () => event('labeled', AGENT)).reverse();
  const api = fakeEventsApi(events);
  const read = await fetchIssueEvents(fetchArgs(api.fetchImpl));
  assert.equal(read.length, 150);
  assert.ok(read[0].id < read[149].id);
  assert.deepEqual(api.urls, [
    'https://api/repos/o/r/issues/7/events?per_page=100&page=1',
    'https://api/repos/o/r/issues/7/events?per_page=100&page=2',
  ]);
});

test('too many events, or an API error, is an error rather than no label', async () => {
  const many = Array.from({ length: 3000 }, () => event('labeled', AGENT));
  await assert.rejects(fetchIssueEvents(fetchArgs(fakeEventsApi(many).fetchImpl)), /more than 3000 events/);
  await assert.rejects(fetchIssueEvents(fetchArgs(fakeEventsApi([], { status: 403 }).fetchImpl)), /GitHub API returned 403/);
});

test('reads every page of reviews; too many is an error rather than no approval', async () => {
  const reviews = Array.from({ length: 150 }, () => review('COMMENTED'));
  const api = fakeEventsApi([], { reviews });
  assert.equal((await fetchReviews(fetchArgs(api.fetchImpl))).length, 150);
  assert.deepEqual(api.urls, [
    'https://api/repos/o/r/pulls/7/reviews?per_page=100&page=1',
    'https://api/repos/o/r/pulls/7/reviews?per_page=100&page=2',
  ]);
  const many = Array.from({ length: 3000 }, () => review('COMMENTED'));
  await assert.rejects(fetchReviews(fetchArgs(fakeEventsApi([], { reviews: many }).fetchImpl)), /more than 3000 reviews/);
});

test('applyOverride: the owner approves the head and labels it; an approval of an older commit does not count', async () => {
  const run = (reviews, headSha = HEAD) => applyOverride(failing,
    { label: LABEL, allowedUserIds: [1001], api: fetchArgs(fakeEventsApi([event('labeled', OWNER)], { reviews }).fetchImpl), headSha });
  assert.equal((await run([review('APPROVED')])).passed, true);
  assert.equal((await run([review('APPROVED', OLD)])).passed, false);
  assert.equal((await run([review('APPROVED')], OLD)).passed, false);
});

test('applyOverride: an agent\'s label fails even with the owner\'s approval, and a passing result reads nothing', async () => {
  const api = fakeEventsApi([event('labeled', AGENT)], { reviews: [review('APPROVED')] });
  const result = await applyOverride(failing, { label: LABEL, allowedUserIds: [1001], api: fetchArgs(api.fetchImpl), headSha: HEAD });
  assert.match(result.lines.at(-1), /only the repo owner's override counts/);
  const quiet = fakeEventsApi([]);
  const passing = { passed: true, lines: ['Coverage held.'] };
  assert.equal(await applyOverride(passing, { label: LABEL, allowedUserIds: [1001], api: fetchArgs(quiet.fetchImpl), headSha: HEAD }), passing);
  assert.deepEqual(quiet.urls, []);
});
