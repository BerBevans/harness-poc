// Guardrail files are human-owned: agents may read them but not change them.
// User-level Claude configuration under ~/.claude is handled by the claude-config rule.

import { expandHome, isUnder, normalisePath, segments } from '../lib/paths.mjs';
import { commandWriteTargets, invocationsOf } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

const GUARDRAIL_FILE_NAMES = new Set([
  '.editorconfig',
  'directory.build.props',
  'directory.build.targets',
  'directory.packages.props',
  'nuget.config',
  'global.json',
]);
const GUARDRAIL_FOLDERS = new Set(['.github', '.claude']);

// `dotnet new` templates that create guardrail files.
const GUARDRAIL_TEMPLATES = new Set([
  'editorconfig', 'globaljson', 'nugetconfig', 'buildprops', 'buildtargets', 'packagesprops', 'tool-manifest',
]);

// `home` is optional: CI checks repo-relative paths, where there is no home folder.
// `allowArchitectureTests` is for the hook only; CI always counts architecture tests as guardrails.
export function isGuardrailPath(normalisedPath, home, { allowArchitectureTests = false } = {}) {
  if (home && isUnder(normalisedPath, `${normalisePath(home)}/.claude`)) return false;

  const parts = segments(normalisedPath);
  const name = parts.at(-1) ?? '';
  return GUARDRAIL_FILE_NAMES.has(name)
    || name.endsWith('.globalconfig')
    || name.endsWith('.runsettings')
    || /^stryker-config\.(json|ya?ml)$/.test(name)
    || normalisedPath.endsWith('.config/dotnet-tools.json')
    || parts.some(part => GUARDRAIL_FOLDERS.has(part))
    || (!allowArchitectureTests && parts.some(part => part.endsWith('.architecturetests')));
}

// The owner sets FACTORY_ARCHITECTURE_SESSION=1 when starting an architecture session, which writes the
// architecture tests. An agent can't change its own hook's environment, and a factory run (FACTORY_ISSUE)
// never gets the exemption. CI still fails any agent PR that touches these paths.
function architectureSession(env) {
  return env.FACTORY_ARCHITECTURE_SESSION === '1' && !env.FACTORY_ISSUE?.trim();
}

function checkDotnetCommands(command, nextStep) {
  for (const args of invocationsOf(command, 'dotnet')) {
    const [verb, noun] = args.map(a => a.toLowerCase());
    if (verb === 'new' && GUARDRAIL_TEMPLATES.has(noun)) {
      return `Blocked: \`dotnet new ${noun}\` creates a guardrail file, and guardrail files are human-owned. ${nextStep}`;
    }
    if ((verb === 'add' && args.includes('package')) || (verb === 'package' && noun === 'add')) {
      return 'Blocked: adding a package changes Directory.Packages.props, the package allowlist. ' +
        'New packages need approval: request it, giving the reason, the alternatives you considered and ' +
        `why the framework isn't enough. ${nextStep}`;
    }
    if (verb === 'tool' && ['install', 'update', 'uninstall'].includes(noun)) {
      return 'Blocked: installing or changing a .NET tool brings in a dependency outside the package gate, ' +
        `and the tool manifest is a guardrail file. ${nextStep}`;
    }
  }
  return null;
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const blockedPath = path =>
    `Blocked: ${path} is a guardrail file. Guardrail files are human-owned and change only through the ` +
    `harness repo. ${nextStep}`;

  const options = { allowArchitectureTests: architectureSession(context.env) };
  const guarded = path => isGuardrailPath(path, context.home, options);

  if (change.isWrite) {
    const path = change.paths.find(guarded);
    if (path) return blockedPath(path);
  }

  if (change.command) {
    const target = commandWriteTargets(change.command).find(t => guarded(expandHome(t, context.home)));
    if (target) return blockedPath(target);
    return checkDotnetCommands(change.command, nextStep);
  }

  return null;
}
