import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../pr-size.mjs';
import { composeBody, specFromBody } from '../lib/spec-body.mjs';

const AGENT = { login: 'factory-implementer[bot]', id: 2002, type: 'Bot' };
const REPOSITORY = 'owner/product';
const COPY = 'docs/specs/35-storage-and-the-house.md';

const specLines = Array.from({ length: 80 }, (_, i) => `- Scenario line ${i}.`);
const SPEC = `# Storage and the house\n\n${specLines.join('\n')}`;
const BODY = composeBody(SPEC, 'Store the house somewhere.');

const added = (filename, lines, status = 'added') => ({
  filename, status, additions: lines.length, deletions: 0, patch: ['@@ -0,0 +1 @@', ...lines.map(l => `+${l}`)].join('\n'),
});
const code = count => added('src/House.cs', Array.from({ length: count }, (_, i) => `var line${i} = ${i};`));
const copyOf = (text, filename = COPY, status = 'added') => added(filename, text.split('\n'), status);

// A fake GitHub API serving the PR's files, the issue and no events.
async function runCheck({ files, issueBody = BODY, ref = 'factory/issue-35', headRepository = REPOSITORY }) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const { pathname } = new URL(url);
    const json = pathname.endsWith('/files') ? files : pathname.endsWith('/issues/35') ? { body: issueBody } : [];
    return { ok: true, status: 200, json: async () => json };
  };
  const env = {
    GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: 'event.json', GITHUB_API_URL: 'https://api.github.test',
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: 'token', EXEMPT_USER_IDS: '1001', OVERRIDE_USER_IDS: '1001',
  };
  const head = { ref, sha: 'abc123', repo: { full_name: headRepository } };
  const readEvent = () => ({ pull_request: { number: 7, user: AGENT, head, changed_files: files.length } });
  return { result: await run({ env, readEvent, fetchImpl }), urls };
}

test('the spec copy is left out while it matches the issue\'s spec', async () => {
  const { result } = await runCheck({ files: [code(250), copyOf(SPEC)] });
  assert.equal(result.passed, true);
  assert.match(result.lines[0], /^250 changed lines, not counting whitespace, leaving out the spec copy, which matches the issue\./);
});

test('line endings and trailing blank lines don\'t stop a match', async () => {
  const { result } = await runCheck({ files: [code(250), copyOf(`${SPEC.replace(/\n/g, '\r\n')}\r\n\r\n`)] });
  assert.equal(result.passed, true);
});

test('a copy that differs from the spec by one line counts in full', async () => {
  const { result } = await runCheck({ files: [code(250), copyOf(`${SPEC}\nvar hidden = 1;`)] });
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /^::error::332 changed lines/);
});

test('the copy counts on any branch but the issue\'s factory branch in this repo', async () => {
  for (const options of [{ ref: 'feature/storage' }, { ref: 'factory/issue-36' }, { headRepository: 'someone/product' }]) {
    const { result, urls } = await runCheck({ files: [code(250), copyOf(SPEC)], ...options });
    assert.equal(result.passed, false, JSON.stringify(options));
    assert.equal(urls.some(url => url.includes('/issues/35')), false, 'the issue isn\'t read for a branch that can\'t hold the copy');
  }
});

test('only docs/specs/<issue>-<slug>.md can be the copy', async () => {
  for (const filename of ['docs/specs/36-storage.md', 'docs/specs/35-storage.cs', 'src/docs/specs/35-storage.md', 'docs/specs/35-Storage.md']) {
    const { result } = await runCheck({ files: [code(250), copyOf(SPEC, filename)] });
    assert.equal(result.passed, false, filename);
  }
});

test('a copy that already exists on the target branch counts', async () => {
  const { result } = await runCheck({ files: [code(250), copyOf(SPEC, COPY, 'modified')] });
  assert.equal(result.passed, false);
});

test('an issue the spec agent hasn\'t written has no spec to match', async () => {
  const { result } = await runCheck({ files: [code(250), copyOf(SPEC)], issueBody: SPEC });
  assert.equal(result.passed, false);
});

test('the spec is the body above the original request, and nothing of it', () => {
  assert.equal(specFromBody(BODY), `${SPEC}\n`);
  assert.equal(specFromBody(BODY.replace(/\n/g, '\r\n')), `${SPEC}\n`);
  assert.equal(specFromBody('Just a request.'), null);
  assert.equal(specFromBody(null), null);
  assert.equal(specFromBody(composeBody('', 'Request.')), null);
});
