import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIssueEvents, labelAppliedBy, overridden } from '../lib/override-label.mjs';

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

test("an approved label passes the check, keeping its errors as warnings", () => {
  assert.deepEqual(overridden(failing, { label: LABEL, appliedBy: OWNER, allowedUserIds: [1001] }), {
    passed: true,
    lines: ['::warning::Line coverage fell by 1.00 percentage points.', 'Add tests.', 'Accepted, because owner applied coverage-override.'],
  });
});

test('a label someone else applied still fails, and says so', () => {
  const result = overridden(failing, { label: LABEL, appliedBy: AGENT, allowedUserIds: [1001] });
  assert.equal(result.passed, false);
  assert.match(result.lines.at(-1), /factory-agent\[bot\] applied coverage-override, but only the repo owner's override counts/);
});

test('no label, or a passing check, is left as it is', () => {
  assert.equal(overridden(failing, { label: LABEL, appliedBy: null, allowedUserIds: [1001] }), failing);
  const passing = { passed: true, lines: ['Coverage held.'] };
  assert.equal(overridden(passing, { label: LABEL, appliedBy: AGENT, allowedUserIds: [1001] }), passing);
});

// A fake API serving `events` in pages of 100, newest first, to show the order doesn't matter.
function fakeEventsApi(events, { status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: status === 200, status, json: async () => events.slice((page - 1) * 100, page * 100) };
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
