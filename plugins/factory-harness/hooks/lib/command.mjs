// Text-level parsing of shell commands (bash and PowerShell). This is pattern matching,
// not a shell parser: it catches the ordinary spellings and CI catches the rest. The plugin is
// moving onto the bash parser in shell-parse.mjs in slices; until then the parser's reading is
// added alongside these (a union, so it can only block more), and these are frozen except for
// regressions.

import { parseShell } from './shell-parse.mjs';

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
  // A stopgap until the plugin moves onto the bash parser: the splitter doesn't know $'...', where
  // \' is a quote inside the string, so everything after one would vanish from every rule.
  if (/\$'(?:[^'\\]|\\[^'])*\\'/.test(command)) throw new Error("the command has a $'...' string with \\' in it, which the guard can't split");
  const segments = [];
  for (const body of substitutions(command)) segments.push(...splitSegments(body, depth + 1));
  // The hook can't tell which shell will run the line, so it splits it both ways and checks every
  // part: an extra part only ever blocks more.
  const parts = new Set([...splitOutsideQuotes(command, true), ...splitOutsideQuotes(command, false)]);
  for (const part of parts) {
    const segment = part.trim().replace(/^(?:[({]\s*)+/, '').replace(/(?:\s*[)}])+$/, '').trim();
    if (!segment) continue;
    segments.push(segment);
    for (const tokens of tokenisations(segment)) segments.push(...nestedShellCommands(tokens, depth));
  }
  return segments;
}

// -c anywhere in a short-option cluster (bash -lc, sh -ec), pwsh -Command, or cmd /c. The
// argument after every such option is followed: pwsh -NonInteractive matches too, and following
// its neighbour as a command is harmless.
function nestedShellCommands(tokens, depth) {
  const shell = tokens.findIndex(t => SHELLS.has(programName(t)));
  if (shell < 0) return [];
  return tokens.flatMap((t, i) => i > shell && tokens[i + 1] && /^(-[a-z]*c[a-z]*|\/c)$/i.test(t)
    ? splitSegments(unquote(tokens[i + 1]), depth + 1) : []);
}

// A word is quoted and unquoted parts run together, as in bash: `-c user.name='a b'` is one word.
// An escaped quote (\' in bash, `' in PowerShell) and a quote with no closing quote are ordinary
// characters, so they never start a quoted part.
export const tokenise = segment =>
  segment.match(/(?:\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|'[^']*'|\\["'\\]|`["'`]|[^\s"']|["'])+/g) ?? [];

// The older reading, where a quote counts only at the start of a word. An apostrophe in prose (a
// here-document body, "the docs' examples") makes the reading above swallow the words after it, a
// real command among them, so the rules check every segment both ways: an extra reading only ever
// blocks more.
const wordStartTokenise = segment => segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
export function tokenisations(segment) {
  const joined = tokenise(segment);
  const wordStart = wordStartTokenise(segment);
  return JSON.stringify(joined) === JSON.stringify(wordStart) ? [joined] : [joined, wordStart];
}

// bash's $'...' escapes: \n and the like, \xHH, \uHHHH, \UHHHHHHHH and octal \NNN.
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
const ansiC = body => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g,
  (_, e) => /^[xuU]./.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 16))
    : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ANSI_ESCAPES[e] ?? e);

const WORD_PART = /\$'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|'([^']*)'|\\([\s\S])|[\s\S]/g;
const readWord = (token, bash) => token.replace(WORD_PART, (part, ansi, doubled, single, escaped) => {
  if (ansi !== undefined) return ansiC(ansi);
  if (doubled !== undefined) return doubled.replace(/\\(["\\$`])/g, '$1');
  if (single !== undefined) return single;
  return escaped !== undefined && bash ? escaped : part;
});

// Removes the quotes from every quoted part. Inside double quotes, bash unescapes \", \\, \$ and \`.
// A backslash outside quotes stays, since in PowerShell and in Windows paths it's a character.
export const unquote = token => readWord(token, false);
// The word as bash reads it, where a backslash outside quotes escapes the next character: re\set is reset.
export const bashWord = token => readWord(token, true);

const isOption = token => /^-/.test(token);
const isEnvAssignment = token => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

// "C:/Program Files/Git/cmd/git.exe" -> "git"
export const programName = (token, read = unquote) =>
  read(token.replace(/^[({]+/, '')).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

/** Every invocation of a program in the command, as its argument lists read by `read` (unquoted by default). */
export function invocationsOf(command, program, read = unquote) {
  const found = [];
  for (const segment of splitSegments(command)) {
    for (const tokens of tokenisations(segment)) {
      const index = tokens.findIndex(t => programName(t, read) === program);
      if (index >= 0) found.push(tokens.slice(index + 1).map(read));
    }
  }
  for (const words of parsedCommandWords(command)) {
    const index = words.findIndex(w => programName(w, w => w) === program);
    if (index >= 0) found.push(words.slice(index + 1));
  }
  return found;
}

/**
 * Bash's own reading of the command: every simple command at any depth, as the words bash passes
 * (quotes removed, $'...' decoded), following `bash -c '...'` and the like as splitSegments does.
 * Nothing for a line the parser can't read (parseError says why, and the guard denies such bash);
 * nesting deeper than MAX_DEPTH throws, so the guard fails closed.
 */
export function parsedCommandWords(command, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`the command nests commands more than ${MAX_DEPTH} deep`);
  const { commands } = parse(command);
  return (commands ?? []).flatMap(c => {
    const words = c.words.map(w => w.value);
    return [words, ...nestedShellCommandLines(words).flatMap(({ line }) => parsedCommandWords(line, depth + 1))];
  });
}

/**
 * Why the bash parser can't read the command, or a bash -c line inside it, or null when it can.
 * Lines given to pwsh, powershell or cmd aren't bash, so they're left to the text rules.
 */
export function parseError(command, depth = 0) {
  if (depth > MAX_DEPTH) return `the command nests commands more than ${MAX_DEPTH} deep`;
  const { commands, error } = parse(command);
  if (error) return error;
  for (const c of commands ?? []) {
    for (const { shell, line } of nestedShellCommandLines(c.words.map(w => w.value))) {
      const nested = NOT_BASH.has(shell) ? null : parseError(line, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

// Each rule parses the same command, so the parser's result is kept for the last few commands.
const parsed = new Map();
function parse(command) {
  if (!parsed.has(command)) {
    if (parsed.size > 50) parsed.clear();
    try { parsed.set(command, { commands: parseShell(command).commands }); } catch (error) { parsed.set(command, { error: error.message }); }
  }
  return parsed.get(command);
}

const NOT_BASH = new Set(['pwsh', 'powershell', 'cmd']);

// The command line given to a shell's -c (as nestedShellCommands follows it), with the name of the
// nearest shell before it (pwsh -Command bash -c '...' gives bash the line).
function nestedShellCommandLines(words) {
  const shells = words.map(w => programName(w, w => w)).map(name => SHELLS.has(name) ? name : null);
  return words.flatMap((w, i) => {
    const shell = shells.slice(0, i).findLast(Boolean);
    return shell && words[i + 1] !== undefined && /^(-[a-z]*c[a-z]*|\/c)$/i.test(w) ? [{ shell, line: words[i + 1] }] : [];
  });
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
 * subcommand is then ''. Each invocation is read twice, as written and as bash reads it (g\it re\set),
 * since the hook can't tell which shell runs the line: an extra reading only ever blocks more.
 */
export function gitInvocations(command) {
  const readings = [...invocationsOf(command, 'git'), ...invocationsOf(command, 'git', bashWord)];
  const distinct = [...new Map(readings.map(tokens => [JSON.stringify(tokens), tokens])).values()];
  return distinct.map(gitInvocation);
}

/** One git invocation, from the words after `git`, in the shape gitInvocations returns. */
function gitInvocation(tokens) {
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

  // The target read both ways, as with tokenisations.
  const redirects = [/\d*>>?(?!&)\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&<>"'])+)/g, /\d*>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g];
  // Each target is also read as bash reads it (.git/con\fig).
  for (const match of redirects.flatMap(pattern => [...segment.matchAll(pattern)])) {
    for (const target of new Set([unquote(match[1]), bashWord(match[1])])) {
      if (!/^(\/dev\/null|\$null|nul)$/i.test(target)) targets.push(target);
    }
  }

  for (const match of segment.matchAll(/\[(?:system\.)?io\.file\]::\w+\s*\(\s*("[^"]*"|'[^']*'|[^,)\s]+)/gi)) {
    targets.push(unquote(match[1]));
  }

  for (const tokens of tokenisations(segment)) {
    targets.push(...tokenWriteTargets(tokens.map(unquote)), ...tokenWriteTargets(tokens.map(bashWord)));
  }
  return targets;
}

// The paths a simple command's words name as written, deleted or overwritten, by program.
function tokenWriteTargets(tokens) {
  const targets = [];
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
    const git = gitInvocation(args);
    if (GIT_SUBCOMMANDS_THAT_WRITE_PATHS.has(git.subcommand)) targets.push(...git.args.filter(a => !isOption(a)));
  }

  return targets;
}

// Redirections that write to a file (>&2 copies a descriptor and >&- closes one).
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const isNullDevice = target => /^(\/dev\/null|\$null|nul)$/i.test(target);

/**
 * The bash parser's reading of the write targets: every simple command at any depth, its writing
 * redirections (>| and >&file included) and its words by program, following bash -c lines.
 * Nothing for a command the parser can't read (the guard denies such bash).
 */
function parsedWriteTargets(command, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`the command nests commands more than ${MAX_DEPTH} deep`);
  return (parse(command).commands ?? []).flatMap(c => {
    const words = c.words.map(w => w.value);
    const redirected = c.redirects
      .filter(r => WRITE_REDIRECTS.has(r.op) && !(r.op === '>&' && /^(\d+|-)$/.test(r.target.value)))
      .map(r => r.target.value);
    return [...redirected, ...tokenWriteTargets(words),
      ...nestedShellCommandLines(words).flatMap(({ line }) => parsedWriteTargets(line, depth + 1))];
  }).filter(target => !isNullDevice(target));
}

/** Write targets across every segment of a command, read by the text rules and by the bash parser. */
export const commandWriteTargets = command => [...splitSegments(command).flatMap(writeTargets), ...parsedWriteTargets(command)];
