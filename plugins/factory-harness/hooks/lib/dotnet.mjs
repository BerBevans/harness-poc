// Runs dotnet for the Stop and format hooks: on the host in a local session, and in the build
// container in a factory run (FACTORY_DOTNET=container, which run-agent sets). A factory run never
// falls back to the host: the code the agent wrote would run beside its token.

import { resolveImage, runInContainer } from '../../ci/dotnet.mjs';
import { RUNNER_FILE_COMMANDS } from '../../ci/run-agent.mjs';
import { run } from './process.mjs';

export const inContainer = env => env.FACTORY_DOTNET === 'container';

// Under the Stop hook's 600-second limit, so a container is always removed before Claude Code
// kills the hook (which would skip the clean-up and leave it writing to the worktree).
export const CONTAINER_BUDGET_SECONDS = 540;

/** Docker needs the session's environment (PATH, DOCKER_HOST), but not the runner's file commands. */
export const dockerEnvironment = env => Object.fromEntries(Object.entries(env).filter(([name]) => !RUNNER_FILE_COMMANDS.includes(name)));

/**
 * Returns `(root, args, timeoutSeconds) => { ok, output }`. In a container, every call shares one
 * deadline, and any failure to run (no Docker, no base commit, a bad image pin) is a failed check.
 */
export function dotnetRunner(env, { now = Date.now, runContainer = runInContainer, image = resolveImage } = {}) {
  if (!inContainer(env)) {
    return (root, args, timeoutSeconds) => {
      const result = run('dotnet', args, { cwd: root, timeoutSeconds });
      return { ok: result.ok, output: result.stdout + result.stderr };
    };
  }
  const deadline = now() + CONTAINER_BUDGET_SECONDS * 1000;
  const dockerEnv = dockerEnvironment(env);
  return (root, args, timeoutSeconds, { entrypoint } = {}) => {
    const timeout = Math.min(timeoutSeconds * 1000, deadline - now());
    if (timeout <= 0) return { ok: false, output: 'The Stop hook ran out of time before this step.' };
    try {
      const result = runContainer({ image: image(env, root), repo: root, ...(entrypoint ? { entrypoint } : {}), args, capture: true, timeout, env: dockerEnv });
      // The repo is mounted at /src; paths read as the host's, so the Stop hook can make them relative.
      const output = [result.output, ...result.lines].filter(Boolean).join('\n').replace(/(^|[\s[('"])\/src\//gm, (match, before) => `${before}${root}/`);
      return { ok: result.passed, output };
    } catch (error) {
      return { ok: false, output: `dotnet couldn't run in its container (${error.message}). A factory run never falls back to the host.` };
    }
  };
}
