import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotation, fetchChangedFiles, parseUserIds } from '../lib/pull-request.mjs';
import { fakeApi } from './helpers.mjs';

test('user IDs parse from commas or spaces', () => {
  assert.deepEqual(parseUserIds('1001, 1002 1003'), [1001, 1002, 1003]);
});

test('an empty exempt list is an error, not an empty list', () => {
  assert.throws(() => parseUserIds(' '), /EXEMPT_USER_IDS is empty/);
  assert.throws(() => parseUserIds(undefined), /EXEMPT_USER_IDS is empty/);
});

test('logins are rejected, because a login can be renamed and reused', () => {
  assert.throws(() => parseUserIds('1001,owner'), /numeric user IDs, not logins: "owner"/);
});

const manyFiles = count => Array.from({ length: count }, (_, i) => ({ filename: `src/f${i}.cs`, status: 'added' }));

test('fetches every page until a short one', async () => {
  const api = fakeApi(manyFiles(250));
  const files = await fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl });
  assert.equal(files.length, 250);
  assert.equal(api.urls.length, 3);
  assert.equal(api.urls[0], 'https://api/repos/o/r/pulls/7/files?per_page=100&page=1');
});

test('stops at the API limit of 3,000 files', async () => {
  const api = fakeApi(manyFiles(3500));
  const files = await fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl });
  assert.equal(files.length, 3000);
});

test('an API error throws rather than passing', async () => {
  const api = fakeApi([], { status: 403 });
  await assert.rejects(
    fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl }),
    /GitHub API returned 403/);
});


test('an annotation can point at a line', () => {
  assert.equal(annotation('src/A.cs', 'Adds a suppression.', 12), '::error file=src/A.cs,line=12::Adds a suppression.');
});
