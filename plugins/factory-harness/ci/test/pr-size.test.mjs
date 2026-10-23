import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPatch, evaluate, isGenerated, run } from '../pr-size.mjs';

const OWNER = { login: 'owner', id: 1001, type: 'User' };
const AGENT = { login: 'factory-implementer[bot]', id: 2002, type: 'Bot' };
const DEPENDABOT = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };

const hunk = lines => ['@@ -1,10 +1,10 @@', ...lines].join('\n');

// A changed file as the API returns it.
function diff(filename, lines) {
  return { filename, status: 'modified', additions: lines.filter(l => l.startsWith('+')).length,
    deletions: lines.filter(l => l.startsWith('-')).length, patch: hunk(lines) };
}

const addedLines = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `+var ${prefix}${i} = ${i};`);

const check = (files, author = AGENT) => evaluate({ author, files, changedFileCount: files.length, exemptUserIds: [OWNER.id] });

test('added and removed lines both count', () => {
  assert.equal(countPatch(hunk(['+var a = 1;', '-var b = 2;', ' var c = 3;'])), 2);
});

test('blank lines and whitespace-only changes do not count', () => {
  assert.equal(countPatch(hunk(['+', '+   ', '-\t'])), 0);
  assert.equal(countPatch(hunk(['-    return x;', '+        return x;', '-var y=1;', '+var y = 1;'])), 0);
});

test('wrapping a block in a new statement counts only the new lines', () => {
  const patch = hunk([
    '+if (ready)', '+{',
    '-Save();', '-Notify();',
    '+    Save();', '+    Notify();',
    '+}',
  ]);
  assert.equal(countPatch(patch), 3);
});

test('a line moved between hunks still counts, since whitespace is only matched within a hunk', () => {
  const patch = ['@@ -1,3 +1,2 @@', '-var a = 1;', '@@ -40,2 +39,3 @@', '+var a = 1;'].join('\n');
  assert.equal(countPatch(patch), 2);
});

test('the no-newline marker is not a changed line', () => {
  assert.equal(countPatch(hunk(['-}', '\\ No newline at end of file', '+}'])), 0);
});

test('only the generated files a .NET repo commits are left out', () => {
  for (const name of ['packages.lock.json', 'src/Tasks/packages.lock.json',
    'src/Tasks/Migrations/20261023_Initial.Designer.cs', 'src/Tasks/Migrations/TasksContextModelSnapshot.cs']) {
    assert.equal(isGenerated(name), true, name);
  }
  for (const name of ['src/Tasks/Generated.g.cs', 'src/Tasks/Form.Designer.cs', 'src/Tasks/obj/Debug/x.cs',
    'src/Tasks/migrations/Initial.Designer.cs', 'src/Tasks/Migrations/20261023_Initial.cs', 'Packages.lock.json',
    'docs/specs/42-add-task.md']) {
    assert.equal(isGenerated(name), false, name);
  }
});

test('a PR within 250 lines passes with its count', () => {
  const result = check([diff('src/A.cs', addedLines(150)), diff('src/B.cs', addedLines(100))]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.lines,
    ['250 changed lines, not counting whitespace. The target is 200, 250 is acceptable and 300 is the limit.']);
});

test('a PR between 251 and 300 lines passes with a warning', () => {
  const result = check([diff('src/A.cs', addedLines(300))]);
  assert.equal(result.passed, true);
  assert.match(result.lines[0], /^::warning::300 changed lines/);
});

test('a PR over 300 lines fails, listing its largest files and what to do', () => {
  const result = check([diff('src/Small.cs', addedLines(1)), diff('src/Large.cs', addedLines(300))]);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /^::error::301 changed lines/);
  assert.deepEqual(result.lines.slice(1, 4), ['Largest changes:', '  300  src/Large.cs', '  1  src/Small.cs']);
  assert.match(result.lines.at(-1), /Split it into smaller PRs/);
  assert.match(result.lines.at(-1), /Don't apply size-override yourself/);
});

test('generated files are left out of the count, and the summary says how many', () => {
  const result = check([diff('src/A.cs', addedLines(10)), diff('src/A/packages.lock.json', addedLines(5000))]);
  assert.equal(result.passed, true);
  assert.match(result.lines[0], /^10 changed lines, not counting whitespace, leaving out 1 generated file\./);
});

test('docs count like any other file', () => {
  assert.equal(check([diff('docs/specs/42-add-task.md', addedLines(301))]).passed, false);
});

test('a binary file counts as nothing', () => {
  const image = { filename: 'docs/screen.png', status: 'added', additions: 0, deletions: 0 };
  assert.match(check([image]).lines[0], /^0 changed lines/);
});

test('a text file whose diff GitHub left out fails, since it cannot be counted', () => {
  const large = { filename: 'src/Huge.cs', status: 'modified', additions: 4000, deletions: 0 };
  const result = check([large]);
  assert.equal(result.passed, false);
  assert.equal(result.lines[0], "::error file=src/Huge.cs::GitHub didn't return this file's diff, so its lines can't be counted.");
});

test('a generated file whose diff GitHub left out is still left out', () => {
  const lock = { filename: 'packages.lock.json', status: 'modified', additions: 9000, deletions: 9000 };
  assert.equal(check([lock]).passed, true);
});

test('the owner and Dependabot are exempt', () => {
  const files = [diff('src/A.cs', addedLines(400))];
  assert.equal(check(files, OWNER).passed, true);
  assert.equal(check(files, DEPENDABOT).passed, true);
});

test('a listing with fewer files than the PR changed fails', () => {
  const result = evaluate({ author: AGENT, files: [], changedFileCount: 3, exemptUserIds: [OWNER.id] });
  assert.equal(result.passed, false);
});

// A fake GitHub API serving the PR's files and its issue events, recording the URLs asked for.
function fakeGitHub({ files, events = [] }) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const items = url.includes('/events') ? events : files;
    return { ok: true, status: 200, json: async () => items.slice((page - 1) * 100, page * 100) };
  };
  return { urls, fetchImpl };
}

const labeled = (login, id, name = 'size-override') =>
  ({ id: 1, event: 'labeled', actor: { login, id }, label: { name }, created_at: '2026-10-23T10:00:00Z' });

async function runCheck({ files, events, overrideUserIds = '1001', eventName = 'pull_request_target' }) {
  const api = fakeGitHub({ files, events });
  const env = {
    GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: 'event.json', GITHUB_API_URL: 'https://api.github.test',
    GITHUB_REPOSITORY: 'owner/product', GITHUB_TOKEN: 'token', EXEMPT_USER_IDS: '1001', OVERRIDE_USER_IDS: overrideUserIds,
  };
  const readEvent = () => ({ pull_request: { number: 7, user: AGENT, changed_files: files.length } });
  const result = await run({ env, readEvent, fetchImpl: api.fetchImpl });
  return { result, urls: api.urls };
}

const tooLarge = [diff('src/A.cs', addedLines(301))];

test("an oversized PR passes with the owner's size-override label, its errors shown as warnings", async () => {
  const { result } = await runCheck({ files: tooLarge, events: [labeled('owner', 1001)] });
  assert.equal(result.passed, true);
  assert.match(result.lines[0], /^::warning::301 changed lines/);
  assert.equal(result.lines.at(-1), 'Accepted, because owner applied size-override.');
});

test("an agent's size-override label does not count", async () => {
  const { result } = await runCheck({ files: tooLarge, events: [labeled('factory-implementer[bot]', 2002)] });
  assert.equal(result.passed, false);
  assert.match(result.lines.at(-1), /only the repo owner's override counts/);
});

test('the coverage-override label does not approve size', async () => {
  const { result } = await runCheck({ files: tooLarge, events: [labeled('owner', 1001, 'coverage-override')] });
  assert.equal(result.passed, false);
});

test('a PR within the limit is decided without reading its issue events', async () => {
  const { result, urls } = await runCheck({ files: [diff('src/A.cs', addedLines(5))] });
  assert.equal(result.passed, true);
  assert.equal(urls.some(url => url.includes('/events')), false);
});

test('missing override user IDs fail the check even on a small PR', async () => {
  await assert.rejects(runCheck({ files: [diff('src/A.cs', addedLines(5))], overrideUserIds: '' }), /OVERRIDE_USER_IDS is empty/);
});

test('the check refuses to run on pull_request', async () => {
  await assert.rejects(runCheck({ files: tooLarge, eventName: 'pull_request' }), /must run on pull_request_target/);
});
