import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_CODE_VERSION, agentArguments, initProblem, installClaudeCode, runAgent } from '../run-agent.mjs';

const pluginDir = path.resolve('/h/plugins/factory-harness');
const init = (overrides = {}) => ({
  type: 'system', subtype: 'init', claude_code_version: '2.1.310',
  plugins: [{ name: 'factory-harness', path: pluginDir }, { name: 'other', path: 'builtin' }],
  ...overrides,
});
const success = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 4200 };

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A fake Claude Code: writes FAKE_LINES, then exits with FAKE_EXIT, or hangs if FAKE_HANG is set.
const FAKE = `
for (const line of JSON.parse(process.env.FAKE_LINES)) process.stdout.write(line + '\\n');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.stdout.end(() => process.exit(Number(process.env.FAKE_EXIT ?? 0)));
`;

function runFake(t, lines, { exit = 0, hang = false } = {}) {
  const dir = tempDir(t);
  const fake = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(fake, FAKE);
  const transcriptFile = path.join(dir, 'transcript.jsonl');
  const env = { ...process.env, FAKE_LINES: JSON.stringify(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line))), FAKE_EXIT: String(exit), ...(hang ? { FAKE_HANG: '1' } : {}) };
  return runAgent({ command: process.execPath, args: [fake], pluginDir, transcriptFile, env })
    .then(result => ({ ...result, transcript: fs.readFileSync(transcriptFile, 'utf8') }));
}

test('the arguments load the plugin, stream JSON and never use --bare', () => {
  const args = agentArguments({ prompt: 'Do it', pluginDir });
  assert.deepEqual(args, ['-p', 'Do it', '--plugin-dir', pluginDir, '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(agentArguments({ prompt: 'p', pluginDir, model: 'haiku' }).slice(-2), ['--model', 'haiku']);
});

test('Claude Code is installed at the pinned version, once', t => {
  const toolDir = tempDir(t);
  const calls = [];
  const fakeNpm = args => {
    calls.push(args);
    fs.mkdirSync(path.join(toolDir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(toolDir, 'node_modules', '.bin', 'claude'), '');
    return { status: 0 };
  };
  assert.equal(installClaudeCode(toolDir, fakeNpm), path.join(toolDir, 'node_modules', '.bin', 'claude'));
  installClaudeCode(toolDir, fakeNpm);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`));
  assert.throws(() => installClaudeCode(tempDir(t), () => ({ status: 1, stderr: 'E404' })), /Installing Claude Code .* failed: E404/);
});

test('the init check needs the plugin loaded from the given folder, with no plugin errors', () => {
  assert.equal(initProblem(init(), pluginDir), null);
  assert.match(initProblem(init({ plugins: [{ name: 'other', path: 'builtin' }] }), pluginDir), /didn't load/);
  assert.match(initProblem(init({ plugins: undefined }), pluginDir), /didn't load/);
  assert.match(initProblem(init({ plugins: [{ name: 'factory-harness', path: '/repo/.claude/fake' }] }), pluginDir), /loaded from \/repo\/\.claude\/fake/);
  assert.match(initProblem(init({ plugin_errors: [{ message: 'Path not found: /x' }] }), pluginDir), /plugin errors: Path not found: \/x/);
});

test('a run that loads the plugin and succeeds passes, and the log gets a summary only', async t => {
  const run = await runFake(t, [init(), { type: 'assistant', message: 'secret plan' }, success]);
  assert.equal(run.passed, true);
  assert.match(run.lines.join('\n'), /loaded factory-harness/);
  assert.match(run.lines.join('\n'), /success after 3 turns in 4s/);
  assert.doesNotMatch(run.lines.join('\n'), /secret plan/);
  assert.match(run.transcript, /secret plan/);
});

test('a run without the plugin is killed at init, before the agent can act', async t => {
  const run = await runFake(t, [init({ plugins: [] })], { hang: true });
  assert.equal(run.passed, false);
  assert.match(run.lines.join('\n'), /::error::The factory-harness plugin didn't load/);
});

test('a stream that ends early, or starts with anything but init, fails', async t => {
  assert.match((await runFake(t, [])).lines.join('\n'), /ended before system\/init/);
  assert.match((await runFake(t, [success], { hang: true })).lines.join('\n'), /first event wasn't system\/init/);
  assert.match((await runFake(t, ['not json'], { hang: true })).lines.join('\n'), /isn't JSON/);
});

test('an error result, a missing result or a non-zero exit fails', async t => {
  const errorResult = { ...success, subtype: 'error_max_turns', is_error: true };
  assert.match((await runFake(t, [init(), errorResult])).lines.join('\n'), /::error::The agent run failed: error_max_turns/);
  assert.match((await runFake(t, [init()], { exit: 1 })).lines.join('\n'), /exited with code 1 and no result/);
  const nonZero = await runFake(t, [init(), success], { exit: 2 });
  assert.equal(nonZero.passed, false);
  assert.match(nonZero.lines.join('\n'), /exit code 2/);
});

test('a command that does not exist fails', async t => {
  const run = await runAgent({ command: path.join(tempDir(t), 'no-claude'), args: [], pluginDir, transcriptFile: path.join(tempDir(t), 't.jsonl') });
  assert.equal(run.passed, false);
  assert.match(run.lines.join('\n'), /didn't start/);
});
