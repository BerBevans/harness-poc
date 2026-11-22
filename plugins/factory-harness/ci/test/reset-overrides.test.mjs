import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERRIDE_LABEL as COVERAGE } from '../coverage.mjs';
import { OVERRIDE_LABEL as MUTATION } from '../mutation.mjs';
import { OVERRIDE_LABEL as SIZE } from '../pr-size.mjs';
import { OVERRIDE_LABELS, run, staleOverrides } from '../reset-overrides.mjs';

const env = (overrides = {}) => ({
  GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: 'event.json', GITHUB_API_URL: 'https://api', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', ...overrides,
});
const event = (action, ...labels) => () => ({ action, pull_request: { number: 9, labels: labels.map(name => ({ name })) } });
const fakeApi = (status = 204) => {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => { calls.push(`${options.method} ${url}`); return { ok: status < 300, status }; } };
};

test('every check\'s override label is reset', () => {
  assert.deepEqual([SIZE, COVERAGE, MUTATION].filter(label => !OVERRIDE_LABELS.includes(label)), []);
});

test('a push removes every override label on the PR, in its own casing, and nothing else', async () => {
  const api = fakeApi();
  const result = await run({ env: env(), readEvent: event('synchronize', 'Size-Override', 'bug', 'mutation-override'), fetchImpl: api.fetchImpl });
  assert.equal(result.passed, true);
  assert.deepEqual(api.calls, [
    'DELETE https://api/repos/o/r/issues/9/labels/Size-Override',
    'DELETE https://api/repos/o/r/issues/9/labels/mutation-override',
  ]);
});

test('other events leave the labels alone', async () => {
  for (const action of ['opened', 'labeled', 'unlabeled', 'reopened']) {
    const api = fakeApi();
    await run({ env: env(), readEvent: event(action, 'size-override'), fetchImpl: api.fetchImpl });
    assert.deepEqual(api.calls, [], action);
  }
});

test('a label removed in the meantime is fine; any other API error fails the step', async () => {
  assert.equal((await run({ env: env(), readEvent: event('synchronize', 'size-override'), fetchImpl: fakeApi(404).fetchImpl })).passed, true);
  await assert.rejects(run({ env: env(), readEvent: event('synchronize', 'size-override'), fetchImpl: fakeApi(403).fetchImpl }), /403 removing size-override/);
});

test('it refuses pull_request, whose token can\'t remove labels', async () => {
  await assert.rejects(run({ env: env({ GITHUB_EVENT_NAME: 'pull_request' }), readEvent: event('synchronize'), fetchImpl: fakeApi().fetchImpl }), /must run on pull_request_target/);
});

test('similar names aren\'t override labels', () => {
  assert.deepEqual(staleOverrides([{ name: 'size' }, { name: 'override' }, { name: 'size-override-old' }]), []);
});
