import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_COMPLETE_LINES, OUTCOMES, composeBody, failureComment, findSecrets, knownSecrets, originalRequest, readOutputs, run } from '../spec-post.mjs';

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz';
// Shaped like no known token, so only the derived values can catch it.
const OTLP_PASSWORD = 'plainpassword1234567890';
const OTLP_PAIR = `123456:${OTLP_PASSWORD}`;
const OTLP_BASE64 = Buffer.from(OTLP_PAIR).toString('base64');
const OTLP_HEADERS = `Authorization=Basic%20${OTLP_BASE64}`;

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
    [{ 'notes.txt': 'x' }, /wrote 1 file it shouldn't have$/],
    [{ 'outcome.json': 'not json' }, /isn't valid JSON/],
    [{ 'outcome.json': '{ "outcome": "done", "estimatedLines": 1 }' }, /the outcome isn't one of/],
    [{ 'outcome.json': '{ "outcome": "complete", "estimatedLines": "lots" }' }, /isn't a whole number/],
    [{ 'outcome.json': '{ "outcome": "complete", "estimatedLines": 251 }' }, /complete at about 251 lines, over the 250-line target, so the outcome must be split/],
    [{ 'spec.md': '  \n' }, /spec is empty/],
    [{ 'comment.md': 'x'.repeat(4001) }, /comment is empty or over 4000/],
    [{ 'spec.md': 'Spec\n<!-- /factory:original-request -->' }, /original request markers/],
  ];
  for (const [files, problem] of cases) assert.match(readOutputs(runFolder(t, files), [TOKEN]).problem, problem);
});

test('a complete spec at the size target, or questions or a split above it, is accepted', t => {
  for (const [outcome, estimatedLines] of [['complete', 250], ['questions', 330], ['split', 600]]) {
    const files = { 'outcome.json': JSON.stringify({ outcome, estimatedLines }) };
    assert.equal(readOutputs(runFolder(t, files), [TOKEN]).outcome, outcome);
  }
});

test('output holding a known secret value or a credential\'s shape is refused, without repeating it', t => {
  const leaked = readOutputs(runFolder(t, { 'comment.md': `Here: ${TOKEN}` }), [TOKEN]);
  assert.match(leaked.problem, /held a secret value and an Anthropic key or token, so nothing was posted/);
  assert.doesNotMatch(leaked.problem, /abcdefgh/);
  assert.deepEqual(findSecrets('ghs_0123456789abcdefghijklmnopqrstuvwxyz', []), ['a GitHub token']);
  assert.deepEqual(findSecrets('-----BEGIN RSA PRIVATE KEY-----', []), ['a private key']);
  assert.deepEqual(findSecrets('Use the Members table, AKIA is not a key here.', ['short']), []);
});

test('Grafana tokens and Basic auth headers are refused, and prose about them passes', () => {
  assert.deepEqual(findSecrets('glc_eyJvIjoiMTIzNDU2NyIsIm4iOiJmYWN0b3J5In0=', []), ['a Grafana Cloud token']);
  assert.deepEqual(findSecrets('Authorization=Basic%20MTIzNDU2OmdsY19hYmNkZWZnaGlqa2xtbm9w', []), ['a Basic auth header']);
  assert.deepEqual(findSecrets('Authorization: Basic MTIzNDU2OmFiY2RlZmdoaWprbG1ub3A=', []), ['a Basic auth header']);
  assert.deepEqual(findSecrets('Use Basic authentication, never Basic internationalisation, for glc_ prefixes.', []), []);
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

test('a failure comment never quotes the agent\'s file names or outcome', async t => {
  for (const files of [{ [`${TOKEN}.txt`]: 'x' }, { 'outcome.json': JSON.stringify({ outcome: TOKEN, estimatedLines: 1 }) }]) {
    const api = fakeApi();
    await run({ dir: runFolder(t, files), env: env(), fetchImpl: api.fetchImpl });
    assert.deepEqual(api.calls.map(call => call.method), ['POST']);
    assert.ok(!api.calls[0].body.includes(TOKEN));
  }
});

test('a spec that fits but takes the body over GitHub\'s limit with the original request posts only a failure comment', async t => {
  const api = fakeApi('x'.repeat(20000));
  const result = await run({ dir: runFolder(t, { 'spec.md': 'y'.repeat(49000) }), env: env(), fetchImpl: api.fetchImpl });
  assert.equal(result.passed, false);
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST']);
  assert.match(api.calls[1].body, /over GitHub's 65536-character limit/);
});

test('the OTLP headers line yields the header value, its Base64 part, the decoded pair and the password', () => {
  const values = knownSecrets(`${TOKEN}\n${OTLP_HEADERS}\n`);
  for (const value of [TOKEN, OTLP_HEADERS, `Basic ${OTLP_BASE64}`, OTLP_BASE64, OTLP_PAIR, OTLP_PASSWORD]) {
    assert.ok(values.includes(value), value);
  }
  assert.deepEqual(knownSecrets(`${TOKEN}\n\n`), [TOKEN], 'no header: the empty second line adds nothing');
  assert.deepEqual(knownSecrets('Authorization=Bearer%20not-base64-token'),
    ['Authorization=Bearer%20not-base64-token', 'Bearer not-base64-token', 'not-base64-token']);
  assert.deepEqual(knownSecrets(''), []);
});

test('a round leaking any form of the OTLP credential posts only a failure comment', async t => {
  for (const leak of [OTLP_BASE64, OTLP_PAIR, OTLP_PASSWORD, `Basic ${OTLP_BASE64}`]) {
    const api = fakeApi();
    const result = await run({
      dir: runFolder(t, { 'comment.md': `Header was ${leak}.` }),
      env: env({ SECRET_VALUES: `${TOKEN}\n${OTLP_HEADERS}\n` }), fetchImpl: api.fetchImpl,
    });
    assert.equal(result.passed, false, leak);
    assert.deepEqual(api.calls.map(call => call.method), ['POST'], leak);
    assert.match(api.calls[0].body, /a secret value/, leak);
  }
});

test('the two-line SECRET_VALUES without a header still catches the token and passes a clean round', async t => {
  const secrets = `${TOKEN}\n\n`;
  const clean = await run({ dir: runFolder(t), env: env({ SECRET_VALUES: secrets }), fetchImpl: fakeApi().fetchImpl });
  assert.equal(clean.passed, true);
  const leaked = await run({ dir: runFolder(t, { 'spec.md': `x ${TOKEN}` }), env: env({ SECRET_VALUES: secrets }), fetchImpl: fakeApi().fetchImpl });
  assert.equal(leaked.passed, false);
});

test('an issue number that isn\'t a number is an error', async t => {
  await assert.rejects(run({ dir: runFolder(t), env: env({ ISSUE_NUMBER: '4; rm' }), fetchImpl: fakeApi().fetchImpl }), /ISSUE_NUMBER/);
});

test('the spec agent\'s prompt names the files and outcomes this script reads', () => {
  const prompt = fs.readFileSync(new URL('../../prompts/spec-agent.md', import.meta.url), 'utf8');
  for (const name of ['input.md', 'spec.md', 'comment.md', 'outcome.json']) assert.ok(prompt.includes(`.factory/run/${name}`), name);
  for (const outcome of OUTCOMES) assert.ok(prompt.includes(`\`${outcome}\``), outcome);
  assert.ok(prompt.includes(`Above ${MAX_COMPLETE_LINES} lines, the outcome is \`split\``), 'the size target');
});
