#!/usr/bin/env node
// Claude Code PreToolUse hook. Stops the agent getting round the global git hooks
// in ~/.config/git/hooks, tampering with them, or reading the blocked-terms list
// (reading it would send the employer's name to the model).
//
// Bash commands are parsed (shell-parse.mjs), so the rules judge what a command does, not
// what its text mentions: a note written through a quoted here-document is data. Code the
// guard can't see (a command name or eval string known only when it runs, a shell reading
// stdin from something it can't follow) is denied, and so is bash it can't parse. Under that,
// the old text rules run as a floor (floorReason), so the guard is never weaker than the
// pattern-matching one it replaced. PowerShell gets the text rules alone. Script files run by
// an interpreter are not checked; pre-push and CI are the backstops.
//
// Allows by printing nothing; denies by printing a PreToolUse permission decision.
// Fails closed: unreadable input, or any error in the hook, is denied.

import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseShell, ShellParseError } from './shell-parse.mjs';

const NEXT_STEP =
  'Do not look for another way round this. Stop and tell the user what you were trying to do and why; ' +
  'if the change is needed, they will make it themselves.';
const REWRITE_STEP =
  'Write the command out plainly, with literal names and arguments, so it can be checked. ' +
  'If it can\'t be written that way, stop and tell the user what you were trying to do.';

const REASON = {
  noVerify: `Blocked: --no-verify / -n skips the global git hooks that keep the employer's name out of public repos. ` +
    `If a hook rejected your commit, fix the content it flagged instead. ${NEXT_STEP}`,
  hooksPath: `Blocked: core.hooksPath controls the global git hooks, so agents may not override or change it. ${NEXT_STEP}`,
  terms: `Blocked: the blocked-terms list must never be read, changed or substituted by an agent - ` +
    `its contents must not reach the model. ${NEXT_STEP}`,
  guarded: `Blocked: ~/.config/git and ~/.claude/hooks hold human-owned guardrails. ${NEXT_STEP}`,
  config: key => `Blocked: git config key "${key}" is not on the guard's list of harmless keys ` +
    `(it checks -c, --config-env, GIT_CONFIG_* and git config writes, since some keys change which hooks run). ${NEXT_STEP}`,
  env: name => `Blocked: changing ${name} can change which git config, hooks or start-up code apply. ${NEXT_STEP}`,
  alias: `Blocked: aliases can hide what a command runs, so the guard doesn't allow defining or enabling them. ${NEXT_STEP}`,
  gitDir: `Blocked: writing a repository's .git/config by hand, or working inside a .git folder, can disable its hooks. ${NEXT_STEP}`,
  arithmeticData: `Blocked: a quoted string holding "[" and a substitution runs that substitution if bash ever ` +
    `evaluates it as arithmetic or an array subscript. ${NEXT_STEP}`,
  unparsed: detail => `Blocked: the guard couldn't parse this command (${detail}), so it failed closed. ${REWRITE_STEP}`,
  unseen: what => `Blocked: this runs code the guard can't see (${what}). ${REWRITE_STEP}`,
};

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_NESTING = 4;

// git global options that take a separate value, e.g. `git -C dir commit`.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
// `git commit` short options that consume the rest of a cluster as their value, e.g. `-mfix`.
const COMMIT_VALUE_FLAGS = new Set(['m', 'F', 'c', 'C', 't', 'S', 'u']);
// Options whose value is a separate word, per subcommand that can skip hooks.
const VALUE_OPTS = {
  commit: ['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--author', '--date', '--reuse-message',
    '--reedit-message', '--fixup', '--squash', '--template', '--cleanup', '--trailer', '--pathspec-from-file'],
  merge: ['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option'],
  push: ['-o', '--push-option', '--repo', '--receive-pack'],
  pull: ['-s', '-X', '--strategy', '--strategy-option'],
  am: [], rebase: ['-x', '--exec', '-s', '-X', '--onto', '--strategy', '--strategy-option'],
  revert: ['-m', '--mainline'], 'cherry-pick': ['-m', '--mainline'],
};

// The -c / --config-env / GIT_CONFIG_* / git config write allowlist. Anything else is denied,
// so a key that changes which hooks run fails loudly even if nobody listed it.
// Not core.editor, core.pager or pager.*: their values are commands git runs.
const HARMLESS_KEYS = new Set(['user.name', 'user.email', 'user.signingkey', 'core.quotepath',
  'core.autocrlf', 'core.safecrlf', 'core.excludesfile', 'core.longpaths', 'core.filemode', 'core.ignorecase',
  'init.defaultbranch', 'commit.gpgsign', 'tag.gpgsign', 'push.default', 'push.autosetupremote', 'pull.rebase',
  'pull.ff', 'merge.conflictstyle', 'fetch.prune', 'diff.noprefix', 'log.showsignature', 'safe.directory',
  'gc.auto', 'maintenance.auto', 'protocol.version']);
const HARMLESS_SECTIONS = ['color.', 'advice.'];
const harmlessKey = key => HARMLESS_KEYS.has(key.toLowerCase()) || HARMLESS_SECTIONS.some(s => key.toLowerCase().startsWith(s));

// Variables that change which git config, hooks or start-up code apply.
const GUARDED_ENV = /^(GIT_CONFIG\w*|HOME|XDG_CONFIG_HOME|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_DIR|GIT_COMMON_DIR|BASH_ENV|ENV|GIT_BLOCKED_TERMS_FILE)$/;

// Variables whose value is a command git runs: allowed only as a plain program name (GIT_EDITOR=true).
const COMMAND_ENV = /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_SSH_COMMAND|EDITOR|VISUAL|PAGER)$/;

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
// Interpreters and the options that pass them code inline. Their script files are not checked.
const INTERPRETERS = {
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'], python: ['-c'], python3: ['-c'], python2: ['-c'], py: ['-c'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'],
};
// Commands that run the command after their options. `values`: options taking a separate value;
// `skip`: positional words before the command (timeout's duration, flock's lock file).
const WRAPPERS = {
  command: { values: [] }, builtin: { values: [] }, exec: { values: ['-a'] }, nohup: { values: [] },
  nice: { values: ['-n', '--adjustment'] }, timeout: { values: ['-s', '--signal', '-k', '--kill-after'], skip: 1 },
  stdbuf: { values: ['-i', '-o', '-e'] }, setsid: { values: [] }, env: { values: ['-u', '--unset', '-C', '--chdir'] },
  sudo: { values: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'] }, doas: { values: ['-u', '-C'] },
  xargs: { values: ['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs'] },
  flock: { values: ['-w', '--timeout', '-E', '--conflict-exit-code'], skip: 1 },
};
// What xargs may run: its arguments arrive on stdin, so anything that could reach git is denied.
const XARGS_UNSAFE = new Set(['git', ...SHELLS, ...POWERSHELLS, ...Object.keys(INTERPRETERS), 'eval', 'env', 'sudo', 'doas', 'xargs', 'command', 'exec', 'nice', 'nohup', 'timeout', 'flock', 'setsid', 'stdbuf']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '<>', '&>', '&>>']);
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'wc', 'diff', 'ls', 'stat', 'file', 'git', 'echo', 'printf']);

const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
const commandName = word => norm(word.value).split('/').pop().replace(/\.exe$/, '');
// git-commit, git-config and the rest in git's exec path are git subcommands run directly.
const isGit = name => name === 'git' || /^git-[a-z]/.test(name);
const isUnsafe = name => XARGS_UNSAFE.has(name) || isGit(name);
// A $ expansion outside double quotes, which bash splits into words.
function hasUnquotedExpansion(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"') quote = quote ? null : '"';
    else if (c === "'" && !quote) quote = "'";
    else if (!quote && (c === '$' || c === '`')) return true;
  }
  return false;
}
const isGitConfigPath = p => /(^|\/)\.git\/config$/.test(norm(p).replace(/\/(\.\/)+/g, '/').replace(/\/{2,}/g, '/'));
// A .git folder as the target of cp, mv, install or ln, which would write files into it.
const isGitDirPath = p => /(^|\/)\.git\/*$/.test(norm(p).replace(/\/(\.\/)+/g, '/'));

// Every way a command might spell the home directory: C:/Users/x, /c/Users/x, ~, $HOME...
function homeForms(home) {
  const forms = new Set([home, '~', '$home', '${home}', '%userprofile%', '$env:userprofile']);
  const drive = /^([a-z]):\/(.*)$/.exec(home);
  if (drive) forms.add(`/${drive[1]}/${drive[2]}`);
  return [...forms];
}

function expandHome(p, home) {
  const n = norm(p);
  return n === '~' || n.startsWith('~/') ? home + n.slice(1) : n;
}

function makeContext(env) {
  const home = norm(env.home);
  const termsFile = env.termsFile ? norm(env.termsFile) : null;
  const mentionsTerms = s => /blocked[-_]terms/i.test(s) || /git_blocked_terms_file/i.test(s) ||
    (termsFile !== null && norm(s).includes(termsFile));
  const guardedDirs = homeForms(home).flatMap(f => [`${f}/.config/git`, `${f}/.claude/hooks`]);
  const termsPaths = [`${home}/.config/git/blocked-terms.txt`, `${home}/.config/git/blocked_terms.txt`, `${home}/.config/git`];
  if (termsFile) termsPaths.push(termsFile);
  return { home, termsFile, mentionsTerms, guardedDirs, termsPaths };
}

// Text rules, kept from the pattern-matching guard, for text it can't parse: PowerShell, and
// code passed inline to an interpreter.
const tokenise = s => s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
function commitUsesShortNoVerify(text) {
  // Every git in every segment: git after a quote too, as in code passed to an interpreter
  // (execSync('git commit -n')), and after "=" as in an option value (-oProxyCommand=git ...).
  const starts = [...text.split(/&&|\|\||[;|&\n]/)].flatMap(segment =>
    [...segment.matchAll(/(?<=^|[\s(`'"=])(?:[^\s"'`=]*[/\\])?git(?:\.exe)?["']?(?:\\?\s)+/gi)]
      .map(m => segment.slice(m.index + m[0].length).replace(/\\(\s)/g, '$1')));
  for (const rest of starts) {
    const tokens = tokenise(rest);
    let i = 0;
    while (i < tokens.length && tokens[i].startsWith('-')) i += GIT_OPTS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
    if (tokens[i] !== 'commit') continue;
    for (const t of tokens.slice(i + 1)) {
      if (/^["']/.test(t) || !/^-[^-]/.test(t)) continue;
      for (const ch of t.slice(1)) {
        if (ch === 'n') return true;
        if (COMMIT_VALUE_FLAGS.has(ch)) break;
      }
    }
  }
  return false;
}

function textReason(text, ctx) {
  if (/--no-verify\b/i.test(text) || commitUsesShortNoVerify(text)) return REASON.noVerify;
  if (/core\.hookspath/i.test(text)) return REASON.hooksPath;
  if (ctx.mentionsTerms(text)) return REASON.terms;
  if (ctx.guardedDirs.some(g => norm(text).includes(g))) return REASON.guarded;
  return null;
}

// --no-verify and every prefix git would accept for it (--no-v ... --no-verif), anywhere.
function isNoVerify(value) {
  const option = value.toLowerCase().split('=')[0];
  return option.length >= 6 && '--no-verify'.startsWith(option);
}

// A glob could expand to the terms file or the folder holding it.
function globReaches(value, ctx) {
  const pattern = expandHome(value, ctx.home);
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (c === '[') { const end = pattern.indexOf(']', i + 1); if (end < 0) source += '\\['; else { source += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; } }
    else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const regex = new RegExp(`^${source}$`);
  const relative = !/^(\/|[a-z]:\/)/.test(pattern);
  return ctx.termsPaths.some(path => {
    if (!relative) return regex.test(path);
    // A relative glob is checked against the last two or more segments of each guarded path.
    const parts = path.split('/');
    return parts.slice(0, -1).some((_, i) => i < parts.length - 2 && regex.test(parts.slice(i + 1).join('/')));
  });
}

// A "[" followed by $(, ` or ${ that bash didn't run here (quoted or escaped): if the string is
// later evaluated as arithmetic or a subscript, the substitution runs.
function hidesArithmeticCode(raw) {
  const substitution = i => raw[i] === '`' || (raw[i] === '$' && '({'.includes(raw[i + 1] ?? ''));
  let bracket = false, quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else if (c === '[') bracket = true;
      else if (bracket && substitution(i)) return true;
      continue;
    }
    if (c === '\\') { if (bracket && substitution(i + 1)) return true; i++; continue; }
    // A substitution bash runs here is code the parser already reports, not data; skip it.
    if (c === '$' && raw[i + 1] === '(') {
      let depth = 0;
      for (; i < raw.length; i++) { if (raw[i] === '(') depth++; else if (raw[i] === ')' && --depth === 0) break; }
      continue;
    }
    if (c === '"') quote = quote ? null : '"';
    else if (c === "'" && !quote) quote = "'";
    else if (c === '[') bracket = true;
  }
  return false;
}

function wordReason(word, ctx) {
  if (isNoVerify(word.value)) return REASON.noVerify;
  for (const text of [word.value, word.raw]) {
    if (ctx.mentionsTerms(text)) return REASON.terms;
    const expanded = expandHome(text, ctx.home);
    if (ctx.guardedDirs.some(g => norm(text).includes(g) || expanded.includes(g))) return REASON.guarded;
  }
  if (word.glob && globReaches(word.value, ctx)) return REASON.terms;
  return null;
}

// The floor that keeps the guard no weaker than the text rules it replaced. They run over the
// code as the parser read it (words, assignments, redirect targets and here-document bodies)
// minus what it proves is data: literal commit messages and gh bodies, quoted here-document
// bodies when every command is a plain file or git command (DATA_COMMANDS), and hooksPath in
// git config reads. The terms
// and guarded-folder rules run over the whole source, data included.
const DATA_COMMANDS = new Set(['cat', 'tee', 'git', 'gh', 'mkdir', 'cd', 'ls', 'echo', 'printf', 'rm', 'mv', 'cp',
  'true', 'wc', 'head', 'tail', 'sort', 'diff', 'touch', 'test', '[', 'pwd']);
// The git subcommand and its index, skipping global options as gitReason does.
function gitSubcommand(name, words) {
  if (name !== 'git') return { name: name.slice(4), index: 0 };
  for (let i = 1; i < words.length; i++) {
    if (!words[i].value.startsWith('-')) return { name: words[i].value, index: i };
    if (GIT_OPTS_WITH_VALUE.has(words[i].value)) i++;
  }
  return null;
}
const MESSAGE_OPTS = { git: ['-m', '--message'], gh: ['-b', '--body', '-t', '--title'] };
function floorReason(source, parsed, ctx) {
  if (ctx.mentionsTerms(source)) return REASON.terms;
  if (ctx.guardedDirs.some(g => norm(source).includes(g) || expandHome(source, ctx.home).includes(g))) return REASON.guarded;
  // Quoted here-documents are data only when every command is one of these (awk, make or npm
  // could run what a here-document writes or pipes on).
  const dataOnly = parsed.commands.every(c => !c.words.length || (!c.words[0].dynamic && DATA_COMMANDS.has(commandName(c.words[0]))));
  const lines = [];
  for (const command of parsed.commands) {
    const words = command.words;
    const name = words[0] ? commandName(words[0]) : '';
    const sub = isGit(name) ? gitSubcommand(name, words) : null;
    const isConfigRead = sub?.name === 'config' && configReason(words.slice(sub.index + 1)) === null;
    const kept = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (isConfigRead && i > sub.index && /hookspath/i.test(w.value)) continue;
      // -m is a message only for these; elsewhere (fetch -m, rebase -m) it takes no value.
      const opts = MESSAGE_OPTS[isGit(name) ? (['commit', 'merge', 'tag'].includes(sub?.name) ? 'git' : '') : name] ?? [];
      if (opts.includes(w.value) && words[i + 1] && !words[i + 1].dynamic) { i++; continue; }
      if (opts.some(o => o.length === 2 && w.value.startsWith(o) && w.value.length > 2) && !w.dynamic) continue;
      if (opts.some(o => o.startsWith('--') && w.value.startsWith(`${o}=`)) && !w.dynamic) continue;
      kept.push(w.raw);
    }
    for (const a of command.assignments) kept.push(a.value.raw);
    for (const r of command.redirects) {
      kept.push(r.target.raw);
      if (r.heredoc && !(r.heredoc.quoted && dataOnly)) lines.push(...r.heredoc.body.split('\n'));
    }
    lines.push(kept.join(' '));
  }
  return textReason(lines.join('\n'), ctx);
}

// Variables assigned once, to a value the guard can work out, are substituted in later words,
// so S=/tmp/x; bash -c "ls $S" is checked as what it runs. A name assigned more than once, or
// in a way the parser doesn't show (for, read, arithmetic), stays unknown, and so does every
// name when the command sources a file or evals.
function variableFacts(source, commands, functions) {
  const counts = new Map();
  const bump = (name, n = 1) => counts.set(name, (counts.get(name) ?? 0) + n);
  // ${X:=v} assigns too, and unset makes a name unknown rather than empty.
  for (const m of source.matchAll(/(?<![\w$])([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*(?::?[-+*/%&|^]?=|\+\+|--)/g)) bump(m[1]);
  for (const m of source.matchAll(/\bunset\b([^;&|\n]*)/g)) for (const name of m[1].match(/[A-Za-z_]\w*/g) ?? []) bump(name, 2);
  for (const m of source.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)/g)) bump(m[1], 2);
  for (const m of source.matchAll(/\b(?:read|mapfile|readarray|getopts|printf\s+-v)\b([^;&|\n]*)/g)) {
    for (const name of m[1].match(/[A-Za-z_]\w*/g) ?? []) bump(name, 2);
  }
  // IFS changes how bash splits words, so a value with no blanks can still split into a flag.
  const disabled = /\bIFS\b/.test(source) || commands.some(c => c.words[0] && ['source', '.', 'eval'].includes(c.words[0].value));
  // Functions that run their arguments as a command (t() { ...; "$@"; }): each call's
  // arguments are checked as that command.
  const forwarders = new Set([...functions].filter(([, body]) => body.some(isForward)).map(([name]) => name));
  // Every assignment's raw value by name, for judging a variable used as a command name.
  const all = new Map();
  for (const c of commands) {
    const pairs = c.assignments.map(a => [a.name, a.value.raw.slice(a.value.raw.indexOf('=') + 1)]);
    if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(c.words[0]?.value)) {
      for (const w of c.words.slice(1)) { const m = /^([A-Za-z_]\w*)\+?=/.exec(w.raw); if (m) pairs.push([m[1], w.raw.slice(m[0].length)]); }
    }
    for (const [name, raw] of pairs) all.set(name, [...(all.get(name) ?? []), raw]);
  }
  return { counts, disabled, all, forwarders, values: new Map() };
}
const FORWARD = /^"?\$(\{?[@*]\}?|\{?[1-9]\}?)"?$/;
// "$@" as the whole command; with words after it, the caller's command gets arguments the
// call doesn't show, so that is denied as an unknown command name.
const isForward = c => c.words.length === 1 && FORWARD.test(c.words[0].raw);
const NO_FACTS = { counts: new Map(), disabled: true, all: new Map(), forwarders: new Set(), values: new Map() };

function recordAssignments(command, facts) {
  if (facts.disabled || command.words.length) return;
  for (const { name, value } of command.assignments) {
    if (facts.counts.get(name) !== 1) continue;
    const known = evaluateRaw(value.raw.slice(value.raw.indexOf('=') + 1), facts.values);
    if (known !== null) facts.values.set(name, known);
  }
}

// The value of a word built from literals, quotes and known variables, or null.
function evaluateRaw(raw, values) {
  let out = '', quote = null;
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (quote === "'") { if (c === "'") quote = null; else out += c; i++; continue; }
    if (c === '\\') {
      if (quote === '"' && !'$`"\\'.includes(raw[i + 1])) out += '\\';
      out += raw[i + 1] ?? ''; i += 2; continue;
    }
    if (c === '"') { quote = quote ? null : '"'; i++; continue; }
    if (c === "'") { quote = "'"; i++; continue; }
    if (c === '`' || (!quote && c === '{')) return null;
    if (c === '$') {
      const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(raw.slice(i));
      const name = m?.[1] ?? m?.[2];
      if (!name || !values.has(name)) return null;
      const value = values.get(name);
      // Unquoted, a value with blanks or glob characters would split or expand.
      if (!quote && /[\s*?[\]{}]/.test(value)) return null;
      out += value; i += m[0].length; continue;
    }
    out += c; i++;
  }
  return quote ? null : out;
}

function resolveWord(word, facts) {
  if (!word.dynamic || facts.disabled) return word;
  const value = evaluateRaw(word.raw, facts.values);
  return value === null ? word : { ...word, value, dynamic: false };
}

// A variable used as a command name is allowed when every assignment to it ends in a literal
// program name that isn't git, a shell, an interpreter or a wrapper (te="$dir/bin/te"; "$te").
// The same holds for a path that ends in a literal program name ("$S/run.sh").
function harmlessCommandVariable(word, facts) {
  const harmless = raw => {
    const name = raw.replace(/["']/g, '').split('/').pop().toLowerCase().replace(/\.exe$/, '');
    return /^[\w.+-]+$/.test(name) && !isUnsafe(name) && !['source', '.', 'alias'].includes(name);
  };
  // Quoted, so a variable holding blanks can't split it into another command.
  if (/\/[\w.+-]+["']?$/.test(word.raw)) return !hasUnquotedExpansion(word.raw) && harmless(word.raw);
  const m = /^"?\$\{?([A-Za-z_]\w*)\}?"?$/.exec(word.raw);
  const raws = m && facts.all.get(m[1]);
  if (!raws || raws.length !== facts.counts.get(m[1])) return false;
  return raws.every(harmless);
}

function envReason(name, value) {
  if (GUARDED_ENV.test(name)) return REASON.env(name);
  if (COMMAND_ENV.test(name)) {
    // A literal program and its options (GIT_EDITOR=true, EDITOR="code --wait"), nothing that
    // runs another command: no words other than options, for ssh no config file, and no -o
    // key that runs a command (ProxyCommand, LocalCommand, Match exec).
    const text = value.raw.replace(/^(["'])(.*)\1$/s, '$2');
    const tokens = text.split(/\s+/).filter(Boolean);
    const program = (tokens[0] ?? '').split('/').pop().toLowerCase();
    const ssh = program === 'ssh';
    let ok = !/[$`;&|<>()\\\n'"]/.test(text) && /^[\w.+-]+$/.test(program) && !isUnsafe(program);
    for (let i = 1; ok && i < tokens.length; i++) {
      if (ssh && ['-i', '-p', '-l', '-o'].includes(tokens[i])) { i++; continue; }
      // -F names a config file, which can hold a ProxyCommand.
      ok = tokens[i].startsWith('-') && !(ssh && /^-[^-]*F/.test(tokens[i]));
    }
    if (!ok || (ssh && /command|match/i.test(text))) return REASON.env(name);
  }
  // A PATH that puts a folder before the existing one can shadow git with another program.
  if (name === 'PATH' && !/^["']?\$\{?PATH\}?(:|["']?$)/.test(value.raw)) return REASON.env('PATH (other than appending to it)');
  return null;
}

/** Returns a denial reason, or null to allow. */
function bashReason(source, ctx, nesting, outer = null) {
  if (nesting > MAX_NESTING) return REASON.unseen('eval or shell strings nested too deep');
  let parsed;
  try { parsed = parseShell(source); } catch (error) {
    if (error instanceof ShellParseError) return REASON.unparsed(error.message);
    throw error;
  }
  if (nesting === 0) { const reason = floorReason(source, parsed, ctx); if (reason) return reason; }
  const facts = variableFacts(source, parsed.commands, parsed.functions);
  // Code in a string or here-document the outer shell expands sees the outer variables.
  if (outer && !outer.disabled) {
    for (const [name, count] of outer.counts) if (!facts.counts.has(name)) facts.counts.set(name, count);
    for (const [name, raws] of outer.all) if (!facts.all.has(name)) facts.all.set(name, raws);
    for (const [name, value] of outer.values) if (!facts.counts.has(name) || facts.counts.get(name) === outer.counts.get(name)) facts.values.set(name, value);
  }
  for (const command of parsed.commands) {
    const reason = commandReason(command, ctx, nesting, facts);
    if (reason) return reason;
    recordAssignments(command, facts);
  }
  return null;
}

function commandReason(original, ctx, nesting, facts) {
  const command = { ...original, words: original.words.map(w => resolveWord(w, facts)) };
  const { words, assignments, redirects } = command;
  for (const { name, value } of assignments) {
    const raw = value.raw.slice(value.raw.indexOf('=') + 1);
    const reason = envReason(name, { raw }) ?? wordReason(value, ctx) ?? (hidesArithmeticCode(raw) ? REASON.arithmeticData : null);
    if (reason) return reason;
  }
  for (const word of [...words, ...redirects.map(r => r.target)]) {
    const reason = wordReason(word, ctx);
    if (reason) return reason;
  }
  if (redirects.some(r => WRITE_REDIRECTS.has(r.op) && isGitConfigPath(r.target.value))) return REASON.gitDir;

  const start = commandStart(words);
  if (typeof start === 'string') return start;
  if (start !== null && start < words.length) {
    const reason = startReason(command, start, ctx, nesting, facts);
    if (reason) return reason;
    if (facts.forwarders.has(words[start].value)) {
      // The call's arguments, and those after one shift, are the command the function runs.
      for (const from of [start + 1, start + 2]) {
        const forwarded = { words: words.slice(from), assignments: [], redirects: [], pipedFrom: null };
        const reason = forwarded.words.length ? commandReason(forwarded, ctx, nesting + 1, NO_FACTS) : null;
        if (reason) return reason;
      }
    }
  }

  // git, shell -c strings and inline interpreter code are checked wherever they appear, so a
  // wrapper the guard doesn't know (flock f git ..., find -exec sh -c ...) can't hide them.
  for (let i = 0; i < words.length; i++) {
    const name = commandName(words[i]);
    const rest = words.slice(i + 1);
    let reason = null;
    if (name === 'git') reason = gitReason(rest, ctx, nesting);
    else if (isGit(name)) reason = gitReason([{ ...words[i], raw: name.slice(4), value: name.slice(4) }, ...rest], ctx, nesting);
    else if (SHELLS.has(name)) { const script = shellScript(rest); if (script.string) reason = stringReason(script.string, ctx, nesting, facts); }
    else if (POWERSHELLS.has(name)) reason = powershellReason(rest, ctx);
    else if (Object.hasOwn(INTERPRETERS, name)) reason = interpreterInlineReason(name, rest, ctx).reason;
    if (reason) return reason;
  }
  return null;
}

// The index of the word that runs, after wrappers like env, nice and timeout; null when nothing
// runs (command -v); or a denial reason found while reading the wrappers.
function commandStart(words) {
  let i = 0, viaXargs = false;
  while (i < words.length) {
    const name = commandName(words[i]);
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!wrapper || words[i].dynamic) break;
    if (name === 'xargs') viaXargs = true;
    i++;
    while (i < words.length) {
      const value = words[i].value;
      if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(value)) return null;
      if (name === 'env') {
        if (value === '-' || /^-[a-zA-Z]*i/.test(value) || value === '--ignore-environment') return REASON.env('the whole environment (env -i)');
        if (/^(-S|--split-string)/.test(value)) return REASON.unseen('env -S splits a string into a command');
        if ((value === '-u' || value === '--unset') && GUARDED_ENV.test(words[i + 1]?.value ?? '')) return REASON.env(words[i + 1].value);
        const assignment = /^([A-Za-z_]\w*)=/.exec(words[i].raw);
        if (assignment) { const reason = envReason(assignment[1], { raw: words[i].raw.slice(assignment[0].length) }); if (reason) return reason; i++; continue; }
      }
      if (name === 'flock' && (value === '-c' || value === '--command')) return REASON.unseen('flock -c runs a string as a command');
      if (!value.startsWith('-') || value === '-') break;
      if (value === '--') { i++; break; }
      i += wrapper.values.includes(value) ? 2 : 1;
    }
    i += wrapper.skip ?? 0;
  }
  if (viaXargs && i < words.length && (words[i].dynamic || isUnsafe(commandName(words[i])))) {
    return REASON.unseen('xargs passes arguments from stdin to a command that could reach git');
  }
  return i;
}

// Rules for the command that actually runs: builtins that change the shell, eval, and shells
// or interpreters that would read code from stdin.
function startReason(command, start, ctx, nesting, facts) {
  const words = command.words;
  if (words[start].dynamic) {
    // "$@" in a function runs what its callers pass, and each call is checked instead.
    if ((FORWARD.test(words[start].raw) && start === words.length - 1) || harmlessCommandVariable(words[start], facts)) return null;
    return REASON.unseen('a command name known only when it runs');
  }
  const name = commandName(words[start]);
  const args = words.slice(start + 1);
  const values = args.map(w => w.value);

  if (name === 'alias') return REASON.alias;
  if (name === 'shopt' && values.includes('-s') && values.includes('expand_aliases')) return REASON.alias;
  if (name === 'hash' && values.some(v => /^-[a-zA-Z]*p/.test(v))) return REASON.env('hashed command paths (hash -p)');
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(name)) {
    if (name !== 'export' && values.some(v => /^-[a-zA-Z]*n/.test(v))) return REASON.unseen('a name reference (declare -n)');
    for (const word of args) {
      const assignment = /^([A-Za-z_]\w*)\+?=/.exec(word.raw);
      if (assignment) {
        const raw = word.raw.slice(assignment[0].length);
        const reason = envReason(assignment[1], { raw }) ?? (hidesArithmeticCode(raw) ? REASON.arithmeticData : null);
        if (reason) return reason;
      } else if (word.dynamic) return REASON.unseen(`a variable name known only when it runs (${name})`);
    }
  }
  if (['unset', 'read', 'mapfile', 'readarray'].includes(name) || (name === 'printf' && values.includes('-v'))) {
    const target = values.find(v => GUARDED_ENV.test(v) || v === 'PATH');
    if (target) return REASON.env(target);
  }
  if (name === 'cd' || name === 'pushd') {
    if (values.some(v => /(^|\/)\.git(\/|$)/.test(norm(v)))) return REASON.gitDir;
  }
  if (!READERS.has(name) && values.some(isGitConfigPath)) return REASON.gitDir;
  if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(name) && values.some(isGitDirPath)) return REASON.gitDir;
  if (name === 'eval') {
    if (args.some(w => w.dynamic)) return REASON.unseen('eval of a string known only when it runs');
    return bashReason(values.join(' '), ctx, nesting + 1, facts);
  }
  if (SHELLS.has(name)) {
    const script = shellScript(args);
    if (script.stdin) return stdinReason(command, ctx, nesting, body => bashReason(body, ctx, nesting + 1, facts));
  }
  if (Object.hasOwn(INTERPRETERS, name)) {
    const inline = interpreterInlineReason(name, args, ctx);
    if (inline.stdin) return stdinReason(command, ctx, nesting, (body, expands) =>
      expands ? REASON.unseen('a here-document that expands variables, fed to an interpreter') : textReason(body, ctx));
  }
  return null;
}

// What a shell runs: a -c string, a script file, or stdin. Script files are followed in a later change.
function shellScript(args) {
  let inline = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i].value;
    if (value === '-' || value === '--') return { stdin: true };
    if (value === '--version' || value === '--help') return {};
    if (/^[-+]o$|^[-+]O$/.test(value) || value === '--rcfile' || value === '--init-file') { i++; continue; }
    if (/^-[a-zA-Z]+$/.test(value)) { if (value.includes('c')) inline = true; if (value.includes('s')) return { stdin: true }; continue; }
    if (value.startsWith('-') || value.startsWith('+')) continue;
    return inline ? { string: args[i] } : { file: args[i] };
  }
  return { stdin: !inline };
}

// A shell string is parsed as written. Variables in it stay unknown words, so the rules still
// apply to them: a string that is wholly a variable ("$script") becomes an unknown command name,
// which is denied. (A variable holding ";" and more commands is a known limit.)
function stringReason(word, ctx, nesting, outer = null) {
  return bashReason(word.value, ctx, nesting + 1, outer);
}

function powershellReason(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const option = args[i].value.toLowerCase();
    if (/^-e(c|ncodedcommand)?$/.test(option)) return REASON.unseen('an encoded PowerShell command');
    if (option === '-c' || option === '-command') {
      const rest = args.slice(i + 1);
      if (rest.some(w => w.dynamic)) return REASON.unseen('a PowerShell command known only when it runs');
      return textReason(rest.map(w => w.value).join(' '), ctx);
    }
  }
  return null;
}

// Inline code (node -e, python -c) gets the text rules. Reports whether the interpreter would
// read its program from stdin instead.
function interpreterInlineReason(name, args, ctx) {
  const options = INTERPRETERS[name];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i].value;
    const attached = options.find(o => o.startsWith('--') && value.startsWith(`${o}=`));
    const clustered = /^-[a-zA-Z]+$/.test(value) && options.some(o => o.length === 2 && value.endsWith(o[1]));
    if (options.includes(value) || attached || clustered) {
      const code = attached ? { ...args[i], value: value.slice(attached.length + 1) } : args[i + 1];
      // Inline code gets the text rules through the floor, which reads every word as written.
      return { reason: null };
    }
    if (value === '-') return { reason: null, stdin: true };
    if (!value.startsWith('-')) positional = true;
    if (value === '-m' || /^--(test|version|help|check)$/.test(value) || /^-[vVh]$/.test(value)) return { reason: null };
  }
  return { reason: null, stdin: !positional };
}

// A shell or interpreter reading its program from stdin: allowed only when that program is a
// here-document, here-string or echo/printf/cat the guard can read.
function stdinReason(command, ctx, nesting, check) {
  const input = command.redirects.find(r => (r.fd === null || r.fd === 0) && ['<<', '<<-', '<<<', '<', '<>'].includes(r.op));
  if (input) {
    if (input.heredoc) return check(input.heredoc.body, !input.heredoc.quoted && /[$`]/.test(input.heredoc.body));
    if (input.op === '<<<' && !input.target.dynamic) return check(`${input.target.value}\n`, false);
    return REASON.unseen('a program read from a file or a value known only when it runs');
  }
  const from = command.pipedFrom;
  // null means unknown, not empty: inside a piped subshell (echo x | (sh)) it is null too.
  if (from === null) return REASON.unseen('a shell or interpreter reading its program from stdin');
  if (from === 'compound') return REASON.unseen('a program piped in from a subshell, group or loop');
  const name = from.words[0] ? commandName(from.words[0]) : '';
  const args = from.words.slice(1);
  if (name === 'cat' && args.length === 0) {
    const doc = from.redirects.find(r => r.heredoc || r.op === '<<<');
    if (doc?.heredoc) return check(doc.heredoc.body, !doc.heredoc.quoted && /[$`]/.test(doc.heredoc.body));
    if (doc && !doc.target.dynamic) return check(`${doc.target.value}\n`, false);
  }
  if (name === 'echo' && args.every(w => !w.dynamic) && !args.some(w => /^-[a-zA-Z]*e/.test(w.value))) {
    return check(`${args.filter(w => !/^-[nE]+$/.test(w.value)).map(w => w.value).join(' ')}\n`, false);
  }
  if (name === 'printf' && args.length === 1 && !args[0].dynamic && !/[%\\]/.test(args[0].value)) return check(args[0].value, false);
  return REASON.unseen('a program piped in from a command whose output the guard can\'t read');
}

function gitReason(args, ctx, nesting) {
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i];
    if (word.dynamic) return REASON.unseen('git options known only when it runs');
    const value = word.value;
    if (!value.startsWith('-')) break;
    if (value === '-c' || value === '--config-env') { const reason = keyReason(args[i + 1]); if (reason) return reason; }
    if (/^-c./.test(value)) { const reason = keyReason({ value: value.slice(2) }); if (reason) return reason; }
    if (value.startsWith('--config-env=')) { const reason = keyReason({ value: value.slice(13) }); if (reason) return reason; }
    if (value.startsWith('--exec-path=')) return REASON.env('where git finds its commands (--exec-path)');
    if (value === '--git-dir' || value.startsWith('--git-dir=')) return REASON.env('the repository git uses (--git-dir)');
    if (GIT_OPTS_WITH_VALUE.has(value)) i++;
  }
  const sub = args[i];
  if (!sub) return null;
  if (sub.dynamic) return REASON.unseen('a git subcommand known only when it runs');
  const name = sub.value;
  const rest = args.slice(i + 1);
  const values = rest.map(w => w.value);

  if (name === 'config') return configReason(rest);
  if (name === 'clone' || name === 'init' || name === 'submodule') {
    for (let j = 0; j < rest.length; j++) {
      const value = rest[j].value;
      if (value === '-c' || value === '--config') { const reason = keyReason(rest[j + 1]); if (reason) return reason; }
      if (value.startsWith('--config=')) { const reason = keyReason({ value: value.slice(9) }); if (reason) return reason; }
      if (value.startsWith('--template')) return REASON.env('the repository template (--template)');
    }
  }
  if (name === 'submodule' && values.includes('foreach')) {
    const strings = rest.slice(values.indexOf('foreach') + 1).filter(w => !w.value.startsWith('--'));
    for (const word of strings) { const reason = stringReason(word, ctx, nesting); if (reason) return reason; }
  }
  // Options whose value is a command git runs through the shell.
  const commandOpts = ['--exec', '--upload-pack', '--receive-pack', '--extcmd', '--sendmail-cmd', '--to-cmd', '--cc-cmd',
    ...(name === 'rebase' || name === 'difftool' ? ['-x'] : []),
    ...(['fetch', 'clone', 'pull', 'ls-remote'].includes(name) ? ['-u'] : [])];
  for (let j = 0; j < rest.length; j++) {
    const value = rest[j].value;
    const long = commandOpts.find(o => o.startsWith('--') && value.startsWith(`${o}=`));
    const code = commandOpts.includes(value) ? rest[j + 1]
      : long ? { ...rest[j], value: value.slice(long.length + 1), raw: rest[j].raw.slice(long.length + 1) }
      : name === 'grep' && /^-O.|^--open-files-in-pager=/.test(value) ? { ...rest[j], value: value.replace(/^-O|^--open-files-in-pager=/, ''), raw: rest[j].raw.replace(/^-O|^--open-files-in-pager=/, '') }
      : null;
    if (code) { const reason = stringReason(code, ctx, nesting); if (reason) return reason; }
  }
  if (name === 'bisect' && values[0] === 'run') {
    return commandReason({ words: rest.slice(1), assignments: [], redirects: [], pipedFrom: null }, ctx, nesting + 1, NO_FACTS);
  }
  if (name === 'filter-branch') return REASON.unseen('git filter-branch runs shell strings');
  if (Object.hasOwn(VALUE_OPTS, name)) return hookSkippingReason(name, rest);
  return null;
}

function keyReason(word) {
  if (!word) return null;
  if (word.dynamic) return REASON.unseen('a git config key known only when it runs');
  const key = word.value.split('=')[0];
  if (/hookspath/i.test(key)) return REASON.hooksPath;
  return harmlessKey(key) ? null : REASON.config(key);
}

// git config: reads are allowed (the hooksPath value included); writes go through the allowlist.
function configReason(args) {
  const values = args.map(w => w.value);
  if (values.some(v => v === '-e' || v === '--edit' || v === 'edit')) return REASON.unseen('git config --edit opens the file in an editor');
  const reads = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', 'get', 'list', '--show-origin', '--show-scope'];
  // Only the key decides; a value or file name known only when it runs is fine.
  const positional = [], positionalWords = [];
  for (let i = 0; i < args.length; i++) {
    const value = values[i];
    if (['--file', '-f', '--blob', '--type', '--default', '--comment'].includes(value)) { i++; continue; }
    if (args[i].dynamic || !value.startsWith('-')) { positional.push(value); positionalWords.push(args[i]); }
  }
  const verbIndex = ['set', 'unset', 'rename-section', 'remove-section', 'get', 'list'].includes(positional[0]) ? 1 : 0;
  if (positionalWords[0]?.dynamic || positionalWords[verbIndex]?.dynamic) return REASON.unseen('a git config key known only when it runs');
  const writeVerbs = ['set', 'unset', 'rename-section', 'remove-section'];
  const keys = [...writeVerbs, 'get', 'list'].includes(positional[0]) ? positional.slice(1) : positional;
  const writeOption = values.some(v => /^--(unset|add|replace-all|rename-section|remove-section)/.test(v));
  const writeVerb = writeVerbs.includes(positional[0]);
  if (!writeOption && !writeVerb && (values.some(v => reads.includes(v)) || keys.length <= 1)) return null;
  // Section operations name sections, not keys, so both names are checked.
  const sections = values.some(v => /section$/.test(v));
  for (const key of sections ? keys : keys.slice(0, 1)) {
    const reason = keyReason({ value: key, dynamic: false });
    if (reason) return reason;
  }
  return null;
}

// Subcommands that can skip hooks: commit -n, and arguments whose value isn't visible (a variable
// or glob could expand to the skip flag).
function hookSkippingReason(name, args) {
  const valueOpts = VALUE_OPTS[name];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word.value === '--' && !word.quoted) return null;
    // An option's value is skipped, unless an unquoted variable could split it into more words.
    if (valueOpts.includes(word.value)) {
      if (args[i + 1]?.dynamic && hasUnquotedExpansion(args[i + 1].raw)) return REASON.unseen(`an unquoted git ${name} ${word.value} value known only when it runs (it could split into a flag that skips hooks)`);
      i++; continue;
    }
    if (word.dynamic || word.glob) {
      const attachedValue = /^--?[A-Za-z][\w-]*=/.test(word.raw) || (name === 'commit' && /^-[mFCct]/.test(word.raw));
      if (attachedValue && !hasUnquotedExpansion(word.raw)) continue;
      // It can't be a flag when it starts with a literal other than "-" (refs/$x), and git
      // rejects any option holding a ":" before acting, so a refspec ("$sha:refs/x") is safe.
      if (/^["']?[^-$`"'{*?[\\]/.test(word.raw) || /:/.test(word.raw.replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`/g, ''))) continue;
      return REASON.unseen(`a git ${name} argument known only when it runs (it could be a flag that skips hooks)`);
    }
    if (name === 'commit' && /^-[^-]/.test(word.value)) {
      for (const ch of word.value.slice(1)) {
        if (ch === 'n') return REASON.noVerify;
        if (COMMIT_VALUE_FLAGS.has(ch)) break;
      }
    }
  }
  return null;
}

/**
 * Returns a denial reason, or null to allow.
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>}} input
 * @param {{home: string, termsFile?: string}} env
 */
export function evaluate(input, env) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  const ctx = makeContext(env);

  if (typeof args.command === 'string') {
    const reason = tool === 'PowerShell' ? textReason(args.command, ctx) : bashReason(args.command, ctx, 0);
    if (reason) return reason;
  }

  const paths = [args.file_path, args.notebook_path, args.path, args.pattern]
    .filter(p => typeof p === 'string')
    .map(p => expandHome(p, ctx.home));

  for (const p of paths) {
    if (ctx.mentionsTerms(p) || p.startsWith(`${ctx.home}/.config/git`)) {
      return `Blocked: ~/.config/git holds the git guardrails and the blocked-terms list, which agents may not open or change. ${NEXT_STEP}`;
    }
    if (WRITE_TOOLS.has(tool) &&
        (p.startsWith(`${ctx.home}/.claude/hooks/`) || p === `${ctx.home}/.gitconfig`)) {
      return `Blocked: ${p} is a human-owned guardrail file. ${NEXT_STEP}`;
    }
    if (WRITE_TOOLS.has(tool) && isGitConfigPath(p)) return REASON.gitDir;
  }

  return null;
}

/** evaluate, failing closed: any error in the hook is a denial. */
export function decide(input, env) {
  try {
    return evaluate(input, env);
  } catch (error) {
    return `Blocked: the guard-git-hooks hook failed (${error?.message ?? error}), so it failed closed. ${NEXT_STEP}`;
  }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny(`Blocked: the guard-git-hooks hook could not parse its input, so it failed closed. ${NEXT_STEP}`);
    return;
  }

  const reason = decide(input, { home: os.homedir(), termsFile: process.env.GIT_BLOCKED_TERMS_FILE });
  if (reason) deny(reason);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
