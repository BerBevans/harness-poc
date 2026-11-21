import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_CODE_VERSION, CONTENT_SWITCHES, agentArguments, deniedTools, initProblem, installClaudeCode, parseAllowedTools, parseMaxTurns, resourceAttributes, runAgent, telemetryEnvironment,
} from '../run-agent.mjs';

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

const fence = { maxTurns: 20, allowedTools: ['Read(./**)', 'Bash(git status *)'], deny: ['Read(//proc/**)'] };

test('the arguments load the plugin, stream JSON, fence the tools and never use --bare', () => {
  const args = agentArguments({ prompt: 'Do it', pluginDir, ...fence });
  assert.deepEqual(args, [
    '-p', 'Do it', '--plugin-dir', pluginDir, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--max-turns', '20',
    '--allowedTools', 'Read(./**)', 'Bash(git status *)', '--disallowedTools', 'Read(//proc/**)',
  ]);
  assert.deepEqual(agentArguments({ prompt: 'p', pluginDir, model: 'haiku', ...fence }).slice(-2), ['--model', 'haiku']);
});

test('allow rules are read one per line, so a command rule keeps its spaces', () => {
  assert.deepEqual(parseAllowedTools('Read(./**)\n  Bash(dotnet test *)\r\n\n'), ['Read(./**)', 'Bash(dotnet test *)']);
});

test('an allow rule that grants a file tool or Bash everywhere is rejected', () => {
  for (const rule of ['Read', 'Bash', 'Write', 'Grep', 'Glob', 'Edit', 'Read(*)', 'Edit(**)', 'Read(//**)', 'Read(~/**)', 'Bash( * )']) {
    assert.throws(() => parseAllowedTools(`Read(./**)\n${rule}`), /allows the tool everywhere/, rule);
  }
  assert.throws(() => parseAllowedTools(' \n'), /AGENT_ALLOWED_TOOLS is empty/);
});

test('the turn cap must be a positive whole number', () => {
  assert.equal(parseMaxTurns('60'), 60);
  for (const bad of ['', '0', '-3', '2.5', '20 turns', undefined]) assert.throws(() => parseMaxTurns(bad), /AGENT_MAX_TURNS/);
});

test('the deny list fences reads and edits away from secrets, the runner temp folder and the plugin', () => {
  const deny = deniedTools({ runnerTemp: '/home/runner/work/_temp', pluginDir: '/a/plugins/factory-harness' });
  for (const place of ['//proc/**', '//etc/**', '~/.ssh/**', '~/.gitconfig', '~/.claude/**',
    '//home/runner/work/_temp/**', '//a/plugins/factory-harness/**']) {
    assert.ok(deny.includes(`Read(${place})`), `Read(${place})`);
    assert.ok(deny.includes(`Edit(${place})`), `Edit(${place})`);
  }
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

test('a rejected token fails with its reason, though Claude Code calls the result a success', async t => {
  // The shape Claude Code 2.1.310 gives for an invalid CLAUDE_CODE_OAUTH_TOKEN.
  const rejected = { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' };
  const run = await runFake(t, [init(), rejected], { exit: 1 });
  assert.equal(run.passed, false);
  assert.match(run.lines.join('\n'), /API status 401\. Failed to authenticate/);
});

test('a command that does not exist fails', async t => {
  const run = await runAgent({ command: path.join(tempDir(t), 'no-claude'), args: [], pluginDir, transcriptFile: path.join(tempDir(t), 't.jsonl') });
  assert.equal(run.passed, false);
  assert.match(run.lines.join('\n'), /didn't start/);
});

const ENDPOINT = 'https://otlp.example.net/otlp';

test('telemetry is off without an endpoint, and the caller\'s telemetry settings are dropped', () => {
  const { env, summary } = telemetryEnvironment({ PATH: '/bin', OTEL_LOG_USER_PROMPTS: '1', OTEL_METRICS_EXPORTER: 'console' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_ENABLE_TELEMETRY: '0' });
  assert.match(summary, /off/);
});

test('headers without an endpoint are refused, since telemetry would silently stay off', () => {
  assert.throws(() => telemetryEnvironment({ AGENT_OTEL_HEADERS: 'Authorization=Basic x' }), /without AGENT_OTEL_ENDPOINT/);
});

test('an endpoint that is not a URL is refused, without echoing it', () => {
  assert.throws(() => telemetryEnvironment({ AGENT_OTEL_ENDPOINT: 'not a url secret' }), error => !error.message.includes('secret'));
});

test('with an endpoint, metrics and events go out over OTLP, with traces and every content switch off', () => {
  const { env, summary } = telemetryEnvironment({ AGENT_OTEL_ENDPOINT: ENDPOINT, AGENT_OTEL_HEADERS: 'Authorization=Basic abc' });
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_TRACES_EXPORTER, 'none');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, ENDPOINT);
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Basic abc');
  for (const name of CONTENT_SWITCHES) assert.equal(env[name], '0', name);
  assert.equal(env.AGENT_OTEL_HEADERS, undefined, 'the input copy of the headers is not passed on');
  assert.equal(summary, 'Telemetry: metrics and events to otlp.example.net, content off.');
  assert.doesNotMatch(summary, /abc/);
});

test('a caller can\'t switch content logging or traces on through the job environment', () => {
  const caller = { AGENT_OTEL_ENDPOINT: ENDPOINT, OTEL_TRACES_EXPORTER: 'otlp', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' };
  for (const name of CONTENT_SWITCHES) caller[name] = '1';
  const { env } = telemetryEnvironment(caller);
  for (const name of CONTENT_SWITCHES) assert.equal(env[name], '0', name);
  assert.equal(env.OTEL_TRACES_EXPORTER, 'none');
  assert.equal(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, undefined);
});

test('resource attributes name the role, model, issue and run, encoded, and skip what is unset', () => {
  assert.equal(
    resourceAttributes({ AGENT_ROLE: 'spec', AGENT_MODEL: 'sonnet', FACTORY_ISSUE: '35', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' }),
    'factory.role=spec,factory.model=sonnet,factory.issue=35,github.repository=o%2Fr,github.run_id=9');
  assert.equal(resourceAttributes({}), 'factory.model=default');
});
