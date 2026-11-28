// Text-level parsing of shell commands (bash and PowerShell). This is pattern matching,
// not a shell parser: it catches the ordinary spellings and CI catches the rest.

// Shells whose -c (or -Command) argument is itself a command line.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);
const MAX_DEPTH = 4;

// Splits on ;, |, &, &&, || and newlines that aren't inside quotes. An & next to a redirect
// (2>&1, &>file, >&2) isn't a separator. With `backslashEscapes` (bash), a backslash escapes the
// next character; without (PowerShell and cmd, where it separates path parts), it's ordinary.
function splitOutsideQuotes(command, backslashEscapes) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (backslashEscapes && quote === '"' && char === '\\') { current += char + (command[++i] ?? ''); continue; }
    if (quote) { if (char === quote) quote = null; current += char; continue; }
    if (backslashEscapes && char === '\\') { current += char + (command[++i] ?? ''); continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    const separatingAmpersand = char === '&' && !/[<>]/.test(command[i - 1] ?? '') && command[i + 1] !== '>';
    if (char === ';' || char === '|' || char === '\n' || separatingAmpersand) {
      parts.push(current);
      current = '';
      if (command[i + 1] === char) i++;
      continue;
    }
    current += char;
  }
  return [...parts, current];
}

// The bodies of $(...), <(...), >(...) and backtick substitutions, which run as commands of their own.
const substitutions = command =>
  [...command.matchAll(/[$<>]\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g)].map(match => match[1] ?? match[2]);

/**
 * Every simple command in a command line: split on separators outside quotes, with subshell and
 * group brackets stripped, substitutions lifted out, and `bash -c '...'` (and the like) followed.
 * Throws when shells nest deeper than MAX_DEPTH, so the guard fails closed.
 */
export function splitSegments(command, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`the command nests commands more than ${MAX_DEPTH} deep`);
  const segments = [];
  for (const body of substitutions(command)) segments.push(...splitSegments(body, depth + 1));
  // The hook can't tell which shell will run the line, so it splits it both ways and checks every
  // part: an extra part only ever blocks more.
  const parts = new Set([...splitOutsideQuotes(command, true), ...splitOutsideQuotes(command, false)]);
  for (const part of parts) {
    const segment = part.trim().replace(/^(?:[({]\s*)+/, '').replace(/(?:\s*[)}])+$/, '').trim();
    if (!segment) continue;
    segments.push(segment);
    const tokens = tokenise(segment);
    const shell = tokens.findIndex(t => SHELLS.has(programName(t)));
    // -c anywhere in a short-option cluster (bash -lc, sh -ec), pwsh -Command, or cmd /c. The
    // argument after every such option is followed: pwsh -NonInteractive matches too, and
    // following its neighbour as a command is harmless.
    if (shell >= 0) {
      tokens.forEach((t, i) => {
        if (i > shell && tokens[i + 1] && /^(-[a-z]*c[a-z]*|\/c)$/i.test(t)) segments.push(...splitSegments(unquote(tokens[i + 1]), depth + 1));
      });
    }
  }
  return segments;
}

// A word is quoted and unquoted parts run together, as in bash: `-c user.name='a b'` is one word.
// A quote with no closing quote counts as an ordinary character.
const QUOTED_PART = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
export const tokenise = segment => segment.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']|["'])+/g) ?? [];

// Removes the quotes from every quoted part. Inside double quotes, bash unescapes \", \\, \$ and \`.
export const unquote = token => token.replace(QUOTED_PART,
  (_, doubled, single) => doubled === undefined ? single : doubled.replace(/\\(["\\$`])/g, '$1'));

const isOption = token => /^-/.test(token);
const isEnvAssignment = token => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

// "C:/Program Files/Git/cmd/git.exe" -> "git"
export const programName = token =>
  unquote(token.replace(/^[({]+/, '')).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

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

// git's global options (git.c handle_options), kept the same as the workstation guard's lists, which
// workstation/claude/git-global-options.test.mjs checks against the real git. git matches them
// exactly and rejects any other, so an option missing here is reported as unknown rather than
// skipped: a value-taking option added in a newer git would otherwise hide the subcommand.
// Options that take their value as the next word, e.g. `git -C dir commit`:
export const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  '--super-prefix', '--attr-source', '--shallow-file']);
export const GIT_FLAG_OPTS = new Set(['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects',
  '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--no-optional-locks', '--no-lazy-fetch', '--no-advice', '--exec-path', '--html-path', '--man-path', '--info-path']);
export const GIT_ATTACHED_OPTS = ['--git-dir=', '--work-tree=', '--namespace=', '--config-env=', '--super-prefix=',
  '--attr-source=', '--exec-path=', '--list-cmds='];
// These end option parsing: git runs `git help` or `git version` with whatever follows.
export const GIT_HELP_OPTS = { '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' };

/**
 * Every git invocation: { subcommand, args, directory, configs, unknownOption }. directory is the -C
 * value, if any. configs are the -c and --config-env values (`key=value`), up to the subcommand.
 * unknownOption is a global option git may not know, after which the subcommand can't be told;
 * subcommand is then ''.
 */
export function gitInvocations(command) {
  return invocationsOf(command, 'git').map(tokens => {
    let index = 0;
    let directory = null;
    const configs = [];
    const result = (subcommand, from, unknownOption = null) =>
      ({ subcommand, args: tokens.slice(from), directory, configs, unknownOption });
    while (index < tokens.length && isOption(tokens[index])) {
      const option = tokens[index];
      if (option in GIT_HELP_OPTS) {
        return result(GIT_HELP_OPTS[option], index + 1);
      }
      if (option === '-C') directory = tokens[index + 1] ?? null;
      if (option === '-c' || option === '--config-env') configs.push(tokens[index + 1] ?? '');
      if (option.startsWith('--config-env=')) configs.push(option.slice('--config-env='.length));
      if (GIT_OPTS_WITH_VALUE.has(option)) index += 2;
      else if (GIT_FLAG_OPTS.has(option) || GIT_ATTACHED_OPTS.some(prefix => option.startsWith(prefix))) index += 1;
      else return result('', index + 1, option);
    }
    return result(tokens[index] ?? '', index + 1);
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
  // A link to a guarded file is a way to write it later, so ln's source counts too.
  'ln',
]);
const COPIES_TO_LAST_ARG = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'xcopy', 'robocopy']);
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
