// Keeps secrets out of the agent's context: no reading, writing or searching secret
// files, and no commands that print credentials. Applies to every tool, reads included.

import { baseName, expandHome, isUnder, normalisePath, segments } from '../lib/paths.mjs';
import { invocationsOf, splitSegments, tokenise, unquote } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

const SECRET_FILE_NAMES = new Set(['.git-credentials', '.netrc', '_netrc']);
const ENV_FILE_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_EXTENSIONS = /\.(pfx|p12|pem|key)$/;
const SSH_KEY_NAMES = /^id_(rsa|dsa|ecdsa|ed25519)/;
const HOME_SECRET_FOLDERS = ['.ssh', '.aws', '.azure', '.config/gh'];

export function isSecretPath(normalisedPath, home) {
  const name = baseName(normalisedPath);
  if (SECRET_FILE_NAMES.has(name) || SECRET_EXTENSIONS.test(name) || SSH_KEY_NAMES.test(name)) return true;
  if ((name === '.env' || name.startsWith('.env.')) && !ENV_FILE_TEMPLATES.has(name)) return true;

  const parts = segments(normalisedPath);
  if (parts.some((part, i) => part === 'microsoft' && parts[i + 1] === 'usersecrets')) return true;

  const realHome = normalisePath(home).replace(/\/$/, '');
  return HOME_SECRET_FOLDERS.some(folder => isUnder(normalisedPath, `${realHome}/${folder}`));
}

function commandPrintsCredentials(command) {
  if (invocationsOf(command, 'gh').some(args => args[0] === 'auth' && args[1] === 'token')) return '`gh auth token`';
  if (invocationsOf(command, 'dotnet').some(args => args[0] === 'user-secrets')) return '`dotnet user-secrets`';
  return null;
}

// Every token in the command that could be a path, checked against the secret paths.
// Quoted text containing spaces, such as a commit message, is prose rather than a path.
function secretPathInCommand(command, home) {
  for (const segment of splitSegments(command)) {
    for (const token of tokenise(segment).map(unquote).filter(t => !/\s/.test(t))) {
      const candidate = token.replace(/^[a-z]+=/i, '');
      if (candidate && isSecretPath(expandHome(candidate, home), home)) return candidate;
    }
  }
  return null;
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const blocked = what =>
    `Blocked: ${what} may hold secrets, and secrets must never reach the model or a public repo. ` +
    `If the task needs a secret value, it belongs in configuration the user provides. ${nextStep}`;

  const path = change.paths.find(p => isSecretPath(p, context.home));
  if (path) return blocked(path);

  if (change.command) {
    const credentialCommand = commandPrintsCredentials(change.command);
    if (credentialCommand) return blocked(credentialCommand);

    const mentioned = secretPathInCommand(change.command, context.home);
    if (mentioned) return blocked(mentioned);
  }

  return null;
}
