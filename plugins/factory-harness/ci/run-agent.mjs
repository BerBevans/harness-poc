// Runs one headless agent with the harness plugin loaded, and fails if the plugin didn't load.
//
// A headless run ignores marketplaces declared in the repository and drops a plugin without any
// error, so the agent would work without the guard hook. The first event in the stream, system/init,
// lists the loaded plugins: unless factory-harness loaded from the folder given to --plugin-dir, the
// run is killed before the agent can act. The kill races the agent in principle, but init arrives
// before the first request to the model, and the CI checks backstop every hook rule.
//
// The stream is the session transcript, so it goes to a file, never to the job log, which is public
// on a public repo. The log gets a summary only.
//
// The agent runs in dontAsk mode, so any tool call its role's list doesn't allow is refused. The list
// may not grant a file tool or Bash without a path or command, and a fixed deny list, which no
// caller can change, fences the file tools away from the places on a runner that hold secrets or
// the harness itself. Deny rules beat allow rules. Bash can still read anything, so the role lists
// keep it narrow, and the steps that post an agent's output check it for secrets.
//
// Usage: node run-agent.mjs <tool folder> <transcript file>
// Environment: AGENT_PROMPT, PLUGIN_DIR, AGENT_MAX_TURNS, AGENT_ALLOWED_TOOLS (one rule per line),
// optional AGENT_MODEL, plus CLAUDE_CODE_OAUTH_TOKEN and FACTORY_ISSUE, which pass through.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { runIfMain } from './lib/pull-request.mjs';

export const CLAUDE_CODE_VERSION = '2.1.310';
export const PLUGIN_NAME = 'factory-harness';

/** Installs the pinned Claude Code into `toolDir`, unless it's there already. Returns the command to run. */
export function installClaudeCode(toolDir, runNpm = args => spawnSync('npm', args, { encoding: 'utf8' })) {
  const command = path.join(toolDir, 'node_modules', '.bin', 'claude');
  if (fs.existsSync(command)) return command;
  const result = runNpm(['install', '--prefix', toolDir, '--no-save', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`]);
  if (result.status !== 0) throw new Error(`Installing Claude Code ${CLAUDE_CODE_VERSION} failed: ${result.stderr || result.stdout}`);
  return command;
}

// Tools that must name a path or command in an allow rule. A bare rule allows them everywhere.
const UNFENCED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit'];

/** Parses the role's allow rules, one per line. Throws on a rule that grants a tool everywhere. */
export function parseAllowedTools(text) {
  const rules = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (rules.length === 0) throw new Error('AGENT_ALLOWED_TOOLS is empty. List the tools the role needs.');
  const bare = rules.find(rule => UNFENCED_TOOLS.includes(rule) || /\(\s*(\/\/|~\/|\/)?\*{0,2}\s*\)$/.test(rule));
  if (bare) throw new Error(`"${bare}" allows the tool everywhere. Name a path, such as Read(./**), or a command.`);
  return rules;
}

/** Parses the turn cap. Throws unless it's a positive whole number. */
export function parseMaxTurns(text) {
  if (!/^[1-9]\d*$/.test(String(text ?? ''))) throw new Error(`AGENT_MAX_TURNS must be a positive whole number, not "${text}".`);
  return Number(text);
}

/**
 * The fixed deny rules. Read rules cover the tools that read files, and Edit rules cover Write.
 * An absolute path is written with a leading //. The runner's temp folder holds the event payload,
 * which has every comment on the issue, and the transcript; the plugin folder holds the guard hook.
 */
export function deniedTools({ runnerTemp, pluginDir }) {
  const absolute = folder => `/${path.resolve(folder)}/**`;
  const places = ['//proc/**', '//sys/**', '//dev/**', '//run/**', '//etc/**',
    '~/.ssh/**', '~/.config/**', '~/.gitconfig', '~/.claude/**', '~/.claude.json',
    absolute(runnerTemp), absolute(pluginDir)];
  return places.flatMap(place => [`Read(${place})`, `Edit(${place})`]);
}

/** Claude Code's arguments. No --bare: bare mode ignores CLAUDE_CODE_OAUTH_TOKEN. */
export function agentArguments({ prompt, pluginDir, model, maxTurns, allowedTools, deny }) {
  return [
    '-p', prompt,
    '--plugin-dir', pluginDir,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--max-turns', String(maxTurns),
    '--allowedTools', ...allowedTools,
    '--disallowedTools', ...deny,
    ...(model ? ['--model', model] : []),
  ];
}

/** Returns why the init event shows the plugin didn't load properly, or null if it did. */
export function initProblem(init, pluginDir) {
  const errors = init.plugin_errors ?? [];
  if (errors.length > 0) {
    return `Claude Code reported plugin errors: ${errors.map(error => error.message).join('; ')}`;
  }
  const expected = path.resolve(pluginDir);
  const loaded = (init.plugins ?? []).find(plugin => plugin.name === PLUGIN_NAME);
  if (!loaded) return `The ${PLUGIN_NAME} plugin didn't load, so the agent would run without the harness hooks.`;
  if (path.resolve(loaded.path) !== expected) {
    return `The ${PLUGIN_NAME} plugin loaded from ${loaded.path}, not from ${expected}.`;
  }
  return null;
}

const describeResult = result =>
  `${result.subtype} after ${result.num_turns ?? '?'} turns in ${Math.round((result.duration_ms ?? 0) / 1000)}s`;

// Claude Code reports some failures, such as a rejected token, with subtype success and is_error set,
// and puts the error in result. For an error, result is the reason, not the agent's work.
const errorDetail = result => {
  if (!result.is_error) return '';
  const status = result.api_error_status ? ` API status ${result.api_error_status}.` : '';
  const reason = typeof result.result === 'string' ? ` ${result.result.slice(0, 300)}` : '';
  return status + reason;
};

/**
 * Starts the agent, checks the init event and copies the stream to the transcript file.
 * Resolves to { passed, lines } for runIfMain.
 */
export function runAgent({ command, args, pluginDir, transcriptFile, env = process.env }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const transcript = fs.createWriteStream(transcriptFile);
    const lines = [];
    let init = null;
    let result = null;
    let problem = null;

    const fail = message => {
      problem ??= message;
      child.kill('SIGKILL');
    };

    readline.createInterface({ input: child.stdout }).on('line', line => {
      transcript.write(`${line}\n`);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return fail('Claude Code wrote a line that isn\'t JSON to its stream.');
      }
      if (!init) {
        if (event.type !== 'system' || event.subtype !== 'init') return fail('The first event wasn\'t system/init, so the plugin check couldn\'t run.');
        init = event;
        const initError = initProblem(event, pluginDir);
        if (initError) return fail(initError);
        lines.push(`Claude Code ${event.claude_code_version} loaded ${PLUGIN_NAME} from ${pluginDir}.`);
      } else if (event.type === 'result') {
        result = event;
      }
    });

    child.on('error', error => fail(`Claude Code didn't start: ${error.message}`));
    const outcome = code => {
      if (problem) return { passed: false, lines: [...lines, `::error::${problem}`] };
      if (!init) return { passed: false, lines: [...lines, '::error::The stream ended before system/init, so the plugin check couldn\'t run.'] };
      if (!result) return { passed: false, lines: [...lines, `::error::Claude Code exited with code ${code} and no result.`] };
      if (result.is_error || result.subtype !== 'success' || code !== 0) {
        return { passed: false, lines: [...lines, `::error::The agent run failed: ${describeResult(result)}, exit code ${code}.${errorDetail(result)}`] };
      }
      return { passed: true, lines: [...lines, `The agent finished: ${describeResult(result)}.`] };
    };

    // Resolve only once the transcript is fully written, so none of it is lost.
    child.on('close', code => transcript.end(() => resolve(outcome(code))));
  });
}

await runIfMain(import.meta.url, async env => {
  const [toolDir, transcriptFile] = process.argv.slice(2);
  if (!toolDir || !transcriptFile) throw new Error('Usage: run-agent.mjs <tool folder> <transcript file>');
  if (!env.AGENT_PROMPT) throw new Error('AGENT_PROMPT is empty.');
  if (!env.PLUGIN_DIR) throw new Error('PLUGIN_DIR is empty.');
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is empty, so the run would fall back to other credentials or fail.');
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is empty, so the deny list can\'t fence the runner\'s temp folder.');
  // The action deletes it first. The runner only rewrites it between steps, so it stays gone for the run.
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    throw new Error('The event payload file still exists, and it holds every comment on the issue. Delete it before the agent starts.');
  }

  const command = installClaudeCode(toolDir);
  const args = agentArguments({
    prompt: env.AGENT_PROMPT,
    pluginDir: env.PLUGIN_DIR,
    model: env.AGENT_MODEL,
    maxTurns: parseMaxTurns(env.AGENT_MAX_TURNS),
    allowedTools: parseAllowedTools(env.AGENT_ALLOWED_TOOLS),
    deny: deniedTools({ runnerTemp: env.RUNNER_TEMP, pluginDir: env.PLUGIN_DIR }),
  });
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  return runAgent({ command, args, pluginDir: env.PLUGIN_DIR, transcriptFile, env });
});
