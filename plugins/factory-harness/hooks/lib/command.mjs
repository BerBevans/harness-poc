// Text-level parsing of shell commands (bash and PowerShell). This is pattern matching,
// not a shell parser: it catches the ordinary spellings and CI catches the rest.

export const splitSegments = command => command.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean);

export const tokenise = segment => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

export const unquote = token => token.replace(/^(["'])(.*)\1$/, '$2');

const isOption = token => /^-/.test(token);
const isEnvAssignment = token => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

// "C:/Program Files/Git/cmd/git.exe" -> "git"
export const programName = token =>
  unquote(token).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

/** Every invocation of a program in the command, as its unquoted argument lists. */
export function invocationsOf(command, program) {
  const found = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenise(segment);
    const index = tokens.findIndex(t => programName(t) === program);
    if (index >= 0) found.push(tokens.slice(index + 1).map(unquote));
  }
  return found;
}

// git global options that take a separate value, e.g. `git -C dir commit`.
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/** Every git invocation: { subcommand, args, directory } where directory is the -C value, if any. */
export function gitInvocations(command) {
  return invocationsOf(command, 'git').map(tokens => {
    let index = 0;
    let directory = null;
    while (index < tokens.length && isOption(tokens[index])) {
      if (tokens[index] === '-C') directory = tokens[index + 1] ?? null;
      index += GIT_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    }
    return { subcommand: tokens[index] ?? '', args: tokens.slice(index + 1), directory };
  });
}

/** Short-option clusters such as -fd contain a flag when any of their letters match. */
export const hasShortFlag = (args, letter) =>
  args.some(a => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));

const DELETES_OR_OVERWRITES_ALL_ARGS = new Set([
  'rm', 'del', 'erase', 'rmdir', 'rd', 'unlink', 'truncate', 'touch', 'shred', 'tee',
  'mv', 'move', 'ren', 'rename-item', 'move-item', 'mi',
  'remove-item', 'ri', 'clear-content', 'clc', 'set-content', 'sc', 'add-content', 'ac',
  'out-file', 'new-item', 'ni', 'tee-object',
]);
const COPIES_TO_LAST_ARG = new Set(['cp', 'copy', 'copy-item', 'cpi', 'ln', 'install', 'xcopy', 'robocopy']);
const EDITS_IN_PLACE = new Set(['sed', 'perl']);
const GIT_SUBCOMMANDS_THAT_WRITE_PATHS = new Set(['checkout', 'restore', 'rm', 'mv']);

/** The paths a command segment writes, overwrites or deletes, as written in the command. */
export function writeTargets(segment) {
  const targets = [];

  for (const match of segment.matchAll(/\d*>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g)) {
    const target = unquote(match[1]);
    if (!/^(\/dev\/null|\$null|nul)$/i.test(target)) targets.push(target);
  }

  for (const match of segment.matchAll(/\[(?:system\.)?io\.file\]::\w+\s*\(\s*("[^"]*"|'[^']*'|[^,)\s]+)/gi)) {
    targets.push(unquote(match[1]));
  }

  const tokens = tokenise(segment).map(unquote);
  const start = tokens.findIndex(t => !isEnvAssignment(t) && t !== 'sudo');
  if (start < 0) return targets;

  const program = programName(tokens[start]);
  const args = tokens.slice(start + 1);
  const plainArgs = args.filter(a => !isOption(a));

  if (DELETES_OR_OVERWRITES_ALL_ARGS.has(program)) targets.push(...plainArgs);
  if (COPIES_TO_LAST_ARG.has(program)) {
    const destination = args.findIndex(a => /^-destination$/i.test(a));
    if (destination >= 0 && args[destination + 1]) targets.push(args[destination + 1]);
    else if (plainArgs.length > 1) targets.push(plainArgs.at(-1));
  }
  if (EDITS_IN_PLACE.has(program) && args.some(a => /^(-[A-Za-z]*i|--in-place)/.test(a))) targets.push(...plainArgs);
  if (program === 'dd') targets.push(...args.filter(a => a.startsWith('of=')).map(a => a.slice(3)));
  if (program === 'git') {
    const [git] = gitInvocations(segment);
    if (git && GIT_SUBCOMMANDS_THAT_WRITE_PATHS.has(git.subcommand)) targets.push(...git.args.filter(a => !isOption(a)));
  }

  return targets;
}

/** Write targets across every segment of a command. */
export const commandWriteTargets = command => splitSegments(command).flatMap(writeTargets);
