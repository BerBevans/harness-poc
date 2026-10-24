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
// Usage: node run-agent.mjs <tool folder> <transcript file>
// Environment: AGENT_PROMPT, PLUGIN_DIR, optional AGENT_MODEL, plus CLAUDE_CODE_OAUTH_TOKEN and
// FACTORY_ISSUE, which pass through to the agent.

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

/** Claude Code's arguments. No --bare: bare mode ignores CLAUDE_CODE_OAUTH_TOKEN. */
export function agentArguments({ prompt, pluginDir, model }) {
  return [
    '-p', prompt,
    '--plugin-dir', pluginDir,
    '--output-format', 'stream-json', '--verbose',
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
        return { passed: false, lines: [...lines, `::error::The agent run failed: ${describeResult(result)}, exit code ${code}.`] };
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

  const command = installClaudeCode(toolDir);
  const args = agentArguments({ prompt: env.AGENT_PROMPT, pluginDir: env.PLUGIN_DIR, model: env.AGENT_MODEL });
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  return runAgent({ command, args, pluginDir: env.PLUGIN_DIR, transcriptFile, env });
});
