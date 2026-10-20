import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { compare, figure, findBaseline, measure, parseCobertura, rate, unmeasuredResult } from '../coverage.mjs';

// A Cobertura report shaped like the one the Microsoft collector writes, with each line listed
// under its method and again under its class.
function cobertura(packages) {
  const line = ([number, hits, branches]) => branches
    ? `<line number="${number}" hits="${hits}" branch="True" condition-coverage="50% (${branches})"><conditions><condition number="0" type="jump" coverage="50%" /></conditions></line>`
    : `<line number="${number}" hits="${hits}" branch="False" />`;
  const classes = files => Object.entries(files).map(([file, lines]) =>
    `<class name="C" filename="${file}"><methods><method name="M"><lines>${lines.map(line).join('')}</lines></method></methods>` +
    `<lines>${lines.map(line).join('')}</lines></class>`).join('');
  return `<?xml version="1.0"?><coverage line-rate="1"><packages>${Object.entries(packages).map(([name, files]) =>
    `<package name="${name}"><classes>${classes(files)}</classes></package>`).join('')}</packages></coverage>`;
}

const fig = (lines, branches = [0, 0]) =>
  ({ lines: { covered: lines[0], valid: lines[1] }, branches: { covered: branches[0], valid: branches[1] } });

test('parses each class line once, with its branches, from the named assemblies only', () => {
  const xml = cobertura({
    App: { '/r/src/App/A.cs': [[5, 1], [7, 1, '2/4'], [8, 0]] },
    'App.UnitTests': { '/r/tests/ATests.cs': [[3, 1]] },
  });
  assert.deepEqual(parseCobertura(xml, new Set(['app'])), [
    { file: '/r/src/App/A.cs', line: 5, hits: 1, branchesCovered: 0, branches: 0 },
    { file: '/r/src/App/A.cs', line: 7, hits: 1, branchesCovered: 2, branches: 4 },
    { file: '/r/src/App/A.cs', line: 8, hits: 0, branchesCovered: 0, branches: 0 },
  ]);
});

test('a line any test project covered counts as covered', () => {
  const assemblies = new Set(['app']);
  const first = parseCobertura(cobertura({ App: { 'A.cs': [[1, 1], [2, 0, '1/2']] } }), assemblies);
  const second = parseCobertura(cobertura({ App: { 'A.cs': [[1, 0], [2, 3, '2/2']] } }), assemblies);
  assert.deepEqual(figure([...first, ...second]), fig([2, 2], [2, 2]));
});

const record = (name, isTestProject = false) =>
  ({ path: path.resolve(`/r/src/${name}/${name}.csproj`), isTestProject, assemblyName: name });

test('measures the product projects across every report, and names any no report covers', t => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  t.after(() => fs.rmSync(results, { recursive: true, force: true }));
  fs.mkdirSync(path.join(results, 'a'));
  fs.writeFileSync(path.join(results, 'a', 'x.cobertura.xml'), cobertura({ App: { 'A.cs': [[1, 1], [2, 0]] }, 'App.UnitTests': { 'T.cs': [[1, 1]] } }));
  fs.writeFileSync(path.join(results, 'y.cobertura.xml'), cobertura({ App: { 'A.cs': [[2, 1]] }, 'App.ArchitectureTests': { 'T.cs': [[1, 1]] } }));
  const records = [record('App'), record('App.UnitTests', true), record('App.ArchitectureTests', true), record('Orphan')];

  const { figure: result, unmeasured } = measure({ records, results });
  assert.deepEqual(result, fig([2, 2]));
  assert.deepEqual(unmeasured.map(r => r.assemblyName), ['Orphan']);

  const failed = unmeasuredResult(unmeasured);
  assert.equal(failed.passed, false);
  assert.match(failed.lines[0], /Orphan\.csproj::Orphan has no coverage: no test loads it\./);
  assert.match(failed.lines.at(-1), /an architecture test that loads it is enough/);
  assert.equal(unmeasuredResult([]), null);
});

test('no coverage reports is an error, not a pass', () => {
  assert.throws(() => measure({ records: [record('App')], results: '/no/such/folder' }), /No coverage reports/);
});

test('code with no branches is fully branch-covered', () => {
  assert.equal(rate({ covered: 0, valid: 0 }), 100);
});

test('holds when coverage is level, higher, or within 0.1 points', () => {
  assert.equal(compare({ current: fig([80, 100], [5, 10]), baseline: fig([80, 100], [5, 10]) }).passed, true);
  assert.equal(compare({ current: fig([90, 100]), baseline: fig([80, 100]) }).passed, true);
  assert.equal(compare({ current: fig([7999, 10000]), baseline: fig([80, 100]) }).passed, true);
});

test('fails when line or branch coverage falls by more than 0.1 points', () => {
  const lines = compare({ current: fig([79, 100]), baseline: fig([80, 100]) });
  assert.equal(lines.passed, false);
  assert.equal(lines.lines[0], '::error::Line coverage fell by 1.00 percentage points.');
  assert.match(lines.lines.at(-1), /restore any test you deleted or weakened/);

  const branches = compare({ current: fig([80, 100], [4, 10]), baseline: fig([80, 100], [5, 10]) });
  assert.deepEqual(branches.lines.slice(0, 3), [
    '::error::Branch coverage fell by 10.00 percentage points.',
    'This PR: line 80.00% (80/100), branch 40.00% (4/10).',
    'Target branch: line 80.00% (80/100), branch 50.00% (5/10).',
  ]);
});

// A fake API serving the given runs and artifacts, recording the URLs it was asked for.
function fakeRunsApi({ runs, artifacts = [{ name: 'coverage-baseline', expired: false }] }) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const body = url.includes('/artifacts') ? { artifacts } : { workflow_runs: runs };
    return { ok: true, status: 200, json: async () => body };
  };
  return { urls, fetchImpl };
}

const env = {
  GITHUB_API_URL: 'https://api',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_TOKEN: 't',
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/build.yml@refs/pull/7/merge',
};
const event = { pull_request: { base: { ref: 'main' } } };
const run = (id, eventName, repo = 'o/r') => ({ id, event: eventName, head_repository: { full_name: repo }, html_url: `run/${id}` });

test("finds the latest successful push run of this workflow on the PR's target branch", async () => {
  const api = fakeRunsApi({ runs: [run(3, 'pull_request'), run(2, 'push', 'fork/r'), run(1, 'push')] });
  assert.deepEqual(await findBaseline({ env, event, fetchImpl: api.fetchImpl }), { runId: 1, url: 'run/1' });
  assert.equal(api.urls[0], 'https://api/repos/o/r/actions/workflows/build.yml/runs?branch=main&status=success&per_page=100');
  assert.equal(api.urls[1], 'https://api/repos/o/r/actions/runs/1/artifacts?name=coverage-baseline');
});

test('a run started by hand counts, so an expired baseline can be replaced', async () => {
  const api = fakeRunsApi({ runs: [run(4, 'workflow_dispatch')] });
  assert.equal((await findBaseline({ env, event, fetchImpl: api.fetchImpl })).runId, 4);
});

test('no baseline is an error, not a pass', async () => {
  await assert.rejects(findBaseline({ env, event, fetchImpl: fakeRunsApi({ runs: [run(3, 'pull_request')] }).fetchImpl }),
    /No successful push run of build\.yml on main/);
  await assert.rejects(findBaseline({ env, event, fetchImpl: fakeRunsApi({ runs: [run(1, 'push')], artifacts: [] }).fetchImpl }),
    /has no coverage-baseline artifact, or it expired/);
  await assert.rejects(findBaseline({
    env, event, fetchImpl: fakeRunsApi({ runs: [run(1, 'push')], artifacts: [{ name: 'coverage-baseline', expired: true }] }).fetchImpl,
  }), /or it expired/);
});

// Runs `coverage.mjs compare` as the action does, against a local server standing in for the
// GitHub API, which serves the PR's issue events.
async function runCompare(t, { current, baseline, events = [], overrideUserIds = '1001' }) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.includes('page=1') ? events : []));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-'));
  t.after(() => { server.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const write = (name, value) => { fs.writeFileSync(path.join(folder, name), JSON.stringify(value)); return path.join(folder, name); };

  const child = spawn(process.execPath, [new URL('../coverage.mjs', import.meta.url).pathname, 'compare',
    write('current.json', current), write('baseline.json', baseline)], {
    env: {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_PATH: write('event.json', { pull_request: { number: 7 } }),
      OVERRIDE_USER_IDS: overrideUserIds,
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const status = await new Promise(resolve => child.on('close', resolve));
  return { status, output };
}

const labeled = (login, id) => ({ id: 1, event: 'labeled', actor: { login, id }, label: { name: 'coverage-override' }, created_at: '2026-10-20T10:00:00Z' });

test('a drop passes with the owner\'s coverage-override label, and fails without it', async t => {
  const drop = { current: fig([79, 100]), baseline: fig([80, 100]) };
  const approved = await runCompare(t, { ...drop, events: [labeled('owner', 1001)] });
  assert.equal(approved.status, 0, approved.output);
  assert.match(approved.output, /::warning::Line coverage fell by 1\.00/);
  assert.match(approved.output, /Accepted, because owner applied coverage-override\./);

  const agent = await runCompare(t, { ...drop, events: [labeled('factory-agent[bot]', 2002)] });
  assert.equal(agent.status, 1, agent.output);
  assert.match(agent.output, /only the repo owner's override counts/);

  assert.equal((await runCompare(t, drop)).status, 1);
});

test('missing override user IDs fail the step even when coverage held', async t => {
  const result = await runCompare(t, { current: fig([80, 100]), baseline: fig([80, 100]), overrideUserIds: '' });
  assert.equal(result.status, 1);
  assert.match(result.output, /OVERRIDE_USER_IDS is empty/);
});
