import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OUTCOMES, composeBody, failureComment, findSecrets, originalRequest, readOutputs, run } from '../spec-post.mjs';

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz';

const runFolder = (t, files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-post-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const all = {
    'input.md': '# Issue', 'spec.md': '## Summary\n\nSign in.\n', 'comment.md': 'First round.\n',
    'outcome.json': '{ "outcome": "questions", "estimatedLines": 240 }', ...files,
  };
  for (const [name, content] of Object.entries(all)) if (content !== null) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

test('good files are read and trimmed', t => {
  assert.deepEqual(readOutputs(runFolder(t), [TOKEN]),
    { outcome: 'questions', estimatedLines: 240, spec: '## Summary\n\nSign in.', comment: 'First round.' });
});

test('missing, extra or malformed files are a problem', t => {
  const cases = [
    [{ 'comment.md': null }, /didn't write comment\.md/],
    [{ 'notes.txt': 'x' }, /wrote files it shouldn't have \(notes\.txt\)/],
    [{ 'outcome.json': 'not json' }, /isn't valid JSON/],
    [{ 'outcome.json': '{ "outcome": "done", "estimatedLines": 1 }' }, /"done" isn't one of/],
    [{ 'outcome.json': '{ "outcome": "complete", "estimatedLines": "lots" }' }, /isn't a whole number/],
    [{ 'spec.md': '  \n' }, /spec is empty/],
    [{ 'comment.md': 'x'.repeat(4001) }, /comment is empty or over 4000/],
    [{ 'spec.md': 'Spec\n<!-- /factory:original-request -->' }, /original request markers/],
  ];
  for (const [files, problem] of cases) assert.match(readOutputs(runFolder(t, files), [TOKEN]).problem, problem);
});

test('output holding a known secret value or a credential\'s shape is refused, without repeating it', t => {
  const leaked = readOutputs(runFolder(t, { 'comment.md': `Here: ${TOKEN}` }), [TOKEN]);
  assert.match(leaked.problem, /held a secret value and an Anthropic key or token, so nothing was posted/);
  assert.doesNotMatch(leaked.problem, /abcdefgh/);
  assert.deepEqual(findSecrets('ghs_0123456789abcdefghijklmnopqrstuvwxyz', []), ['a GitHub token']);
  assert.deepEqual(findSecrets('-----BEGIN RSA PRIVATE KEY-----', []), ['a private key']);
  assert.deepEqual(findSecrets('Use the Members table, AKIA is not a key here.', ['short']), []);
});

test('the first round keeps the whole body as the original request', () => {
  const body = composeBody('## Summary', '## Outcome\n\nBoth owners can sign in.\n');
  assert.equal(body, '## Summary\n\n<details>\n<summary>Original request</summary>\n\n' +
    '<!-- factory:original-request -->\n## Outcome\n\nBoth owners can sign in.\n<!-- /factory:original-request -->\n</details>\n');
});

test('later rounds carry the original request forward unchanged, whatever the spec above it said', () => {
  const round1 = composeBody('## Summary\n\nFirst draft.', 'The original ask.');
  const round2 = composeBody('## Summary\n\nSecond draft.', round1);
  assert.equal(originalRequest(round2), 'The original ask.');
  assert.doesNotMatch(round2, /First draft/);
  assert.equal(originalRequest(null), '');
  assert.match(composeBody('Spec', ''), /\(The issue had no description\.\)/);
});

const fakeApi = (body = 'The original ask.') => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ method: options.method ?? 'GET', url, body: options.body && JSON.parse(options.body).body });
    return { ok: true, json: async () => ({ body }) };
  };
  return { calls, fetchImpl };
};
const env = (overrides = {}) => ({
  AGENT_OUTCOME: 'success', ISSUE_NUMBER: '4', SECRET_VALUES: `${TOKEN}\n`,
  GITHUB_API_URL: 'https://api.test', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'app-token', ...overrides,
});

test('a good round replaces the body, then comments', async t => {
  const api = fakeApi();
  const result = await run({ dir: runFolder(t), env: env(), fetchImpl: api.fetchImpl });
  assert.equal(result.passed, true);
  assert.deepEqual(api.calls.map(call => `${call.method} ${call.url}`), [
    'GET https://api.test/repos/o/r/issues/4',
    'PATCH https://api.test/repos/o/r/issues/4',
    'POST https://api.test/repos/o/r/issues/4/comments',
  ]);
  assert.match(api.calls[1].body, /^## Summary\n\nSign in\.\n\n<details>[\s\S]*The original ask\./);
  assert.equal(api.calls[2].body, 'First round.');
});

test('a failed agent run or a bad file leaves the body alone and posts only a failure comment', async t => {
  for (const [overrides, files, problem] of [
    [{ AGENT_OUTCOME: 'failure' }, {}, 'the agent run failed or reached its turn cap'],
    [{}, { 'spec.md': `Token: ${TOKEN}` }, 'its output looked like it held a secret value and an Anthropic key or token, so nothing was posted'],
  ]) {
    const api = fakeApi();
    const result = await run({ dir: runFolder(t, files), env: env(overrides), fetchImpl: api.fetchImpl });
    assert.equal(result.passed, false);
    assert.deepEqual(api.calls.map(call => call.method), ['POST']);
    assert.equal(api.calls[0].body, failureComment(problem));
  }
});

test('an issue number that isn\'t a number is an error', async t => {
  await assert.rejects(run({ dir: runFolder(t), env: env({ ISSUE_NUMBER: '4; rm' }), fetchImpl: fakeApi().fetchImpl }), /ISSUE_NUMBER/);
});

test('the spec agent\'s prompt names the files and outcomes this script reads', () => {
  const prompt = fs.readFileSync(new URL('../../prompts/spec-agent.md', import.meta.url), 'utf8');
  for (const name of ['input.md', 'spec.md', 'comment.md', 'outcome.json']) assert.ok(prompt.includes(`.factory/run/${name}`), name);
  for (const outcome of OUTCOMES) assert.ok(prompt.includes(`\`${outcome}\``), outcome);
});
