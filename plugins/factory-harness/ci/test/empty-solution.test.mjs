import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, emptyFigure } from '../empty-solution.mjs';
import { compare } from '../coverage.mjs';

const script = new URL('../empty-solution.mjs', import.meta.url).pathname;

test('a solution with no projects is empty on push and on a run by hand', () => {
  for (const eventName of ['push', 'workflow_dispatch']) {
    assert.equal(decide({ eventName, projects: [] }).empty, true, eventName);
  }
});

test('a solution with projects is not empty, so the build runs', () => {
  assert.equal(decide({ eventName: 'push', projects: ['/repo/src/App/App.csproj'] }).empty, false);
});

test('any other event is an error, so a PR with no projects still fails', () => {
  for (const eventName of ['pull_request', 'pull_request_target', undefined]) {
    assert.throws(() => decide({ eventName, projects: [] }), /only allowed on push or a run by hand/, String(eventName));
  }
});

test("the first PR against an empty figure has nothing to compare with, so it passes", () => {
  const current = { core: { lines: { covered: 1, valid: 10 }, branches: { covered: 0, valid: 2 } }, adapters: null };
  const result = compare({ current, baseline: emptyFigure('abc') });
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.match(result.lines.join('\n'), /Core code, target branch: none yet/);
});

function run(t, solutionXml, eventName) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-solution-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, 'App.slnx'), solutionXml);
  const output = path.join(folder, 'output');
  const figureFile = path.join(folder, 'coverage.json');
  const result = spawnSync(process.execPath, [script, path.join(folder, 'App.slnx'), figureFile], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_OUTPUT: output, GITHUB_SHA: 'abc' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
    figure: fs.existsSync(figureFile) ? JSON.parse(fs.readFileSync(figureFile, 'utf8')) : null,
  };
}

test('run on push, an empty solution writes empty=true and the empty figure', { timeout: 60_000 }, t => {
  const { status, output, figure } = run(t, '<Solution>\n</Solution>\n', 'push');
  assert.equal(status, 0);
  assert.equal(output, 'empty=true\n');
  assert.deepEqual(figure, emptyFigure('abc'));
});

test('run on push, a solution with a project writes empty=false and no figure', { timeout: 60_000 }, t => {
  const { status, output, figure } = run(t, '<Solution>\n  <Project Path="src/App/App.csproj" />\n</Solution>\n', 'push');
  assert.equal(status, 0);
  assert.equal(output, 'empty=false\n');
  assert.equal(figure, null);
});

test('run on pull_request, an empty solution fails', { timeout: 60_000 }, t => {
  const { status, stdout, output } = run(t, '<Solution>\n</Solution>\n', 'pull_request');
  assert.equal(status, 1);
  assert.match(stdout, /::error::An empty solution is only allowed on push or a run by hand, not on pull_request/);
  assert.equal(output, '');
});
