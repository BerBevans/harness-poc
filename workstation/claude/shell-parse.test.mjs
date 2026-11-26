// Run with: node --test "workstation/claude/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShell, ShellParseError } from './shell-parse.mjs';

// Each simple command as its words' values, in the order the parser found them (nested first).
const argv = src => parseShell(src).commands.map(c => c.words.map(w => w.value));
const words = src => parseShell(src).commands.flatMap(c => c.words);
const only = src => { const { commands } = parseShell(src); assert.equal(commands.length, 1); return commands[0]; };

const cases = [
  ['operators split commands', 'a 1 && b || c; d | e & f |& g', [['a', '1'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]],
  ['quotes are removed', `git commit -m "fix it" -m 'two  words'`, [['git', 'commit', '-m', 'fix it', '-m', 'two  words']]],
  ['escapes and adjacent quoting join', `a\\ b "c\\"d"'e'f`, [['a b', 'c"def']]],
  ["$'...' octal keeps the low byte, as bash does", `x $'\\516'`, [['x', 'N']]],
  ["$'...' is decoded", `x $'--no-veri\\x66y' $'\\55n' $'a\\tb'`, [['x', '--no-verify', '-n', 'a\tb']]],
  ['line continuations join', 'git \\\n  push', [['git', 'push']]],
  ['a continuation after an operator', 'a &&\\\n b', [['a'], ['b']]],
  ['comments are dropped', 'a # b c\nd#e', [['a'], ['d#e']]],
  ['substitutions are commands too', 'echo $(git -c a=b commit) "$(x)" `y`', [['git', '-c', 'a=b', 'commit'], ['x'], ['y'], ['echo', '$(git -c a=b commit)', '$(x)', '`y`']]],
  ['nested substitutions', 'a $(b $(c) `d`)', [['c'], ['d'], ['b', '$(c)', '`d`'], ['a', '$(b $(c) `d`)']]],
  ['substitutions in ${...} and arithmetic', 'echo ${x:-$(rm y)} $(( $(nproc) + 1 ))', [['rm', 'y'], ['nproc'], ['echo', '${x:-$(rm y)}', '$(( $(nproc) + 1 ))']]],
  ['process substitution', 'diff <(sort a) >(cat)', [['sort', 'a'], ['cat'], ['diff', '<(sort a)', '>(cat)']]],
  ['if, while and reserved words', 'if [[ -f a && $b < c ]]; then x; elif y; then z; else w; fi; while ! q; do r; done', [['x'], ['y'], ['z'], ['w'], ['q'], ['r']]],
  ['for lists and arithmetic for', 'for f in $(ls) b; do echo "$f"; done; for ((i=0;i<3;i++)); do :; done', [['ls'], ['echo', '$f'], [':']]],
  ['case patterns are not commands', 'case "$x" in a|b) one ;; (*) two ;; esac; three', [['one'], ['two'], ['three']]],
  ['substitutions in case words and patterns run', 'case $(w) in $(p)|x) a ;; esac', [['w'], ['p'], ['a']]],
  ['subshells and groups', '(cd sub; git push) && { a; b; } > log', [['cd', 'sub'], ['git', 'push'], ['a'], ['b'], []]],
  ['time and its -p', 'time -p git status', [['git', 'status']]],
  ['time --', 'time -- a; time -p -- b', [['a'], ['b']]],
  ['until, select, ! and coproc', 'until a; do b; done; select x in y; do c; done; ! d | e; coproc f', [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]],
  ['eval and exec keep their arguments as words', 'eval "git x"; exec git y', [['eval', 'git x'], ['exec', 'git', 'y']]],
  ['$"..." is a double-quoted string', 'echo $"a $x" $"b"', [['echo', 'a $x', 'b']]],
  ['assignments are not words', 'X=1 Y="a b" cmd arg', [['cmd', 'arg']]],
  ['array assignment', 'arr=(a $(b) c) cmd', [['b'], ['cmd']]],
  ['an empty array is not a function', 'a=(); a=(x $(b)); c', [[], ['b'], [], ['c']]],
  ['array arguments to declare and local', 'declare -a x=(a $(b)); local y=(c)', [['b'], ['declare', '-a', 'x='], ['local', 'y=']]],
];

for (const [name, src, expected] of cases) test(name, () => assert.deepEqual(argv(src), expected));

test('assignments keep their names and values', () => {
  assert.deepEqual(only('GIT_CONFIG_GLOBAL=/dev/null HOME="$x" git commit').assignments.map(a => [a.name, a.value.value]),
    [['GIT_CONFIG_GLOBAL', '/dev/null'], ['HOME', '$x']]);
});

test('word flags: dynamic, glob, tilde, quoted', () => {
  const [, plain, braces, range, at, star, tilde, quotedTilde, param] = words('echo a {a,b} x{1..3} @{u} *.cs ~/x "~/y" $HOME');
  assert.deepEqual([plain.dynamic, braces.dynamic, range.dynamic, at.dynamic, param.dynamic], [false, true, true, false, true]);
  assert.deepEqual([star.glob, plain.glob], [true, false]);
  assert.deepEqual([tilde.tilde, quotedTilde.tilde, quotedTilde.quoted], [true, false, true]);
});

test('more dynamic words: nested braces, $"..." and a tilde in an assignment', () => {
  const [, nested, locale] = words('x {-a,-b{}} $"a"');
  assert.deepEqual([nested.dynamic, locale.dynamic], [true, true]);
  assert.equal(only('P=a:~/b x').assignments[0].value.tilde, true);
});

test('redirections', () => {
  const { redirects } = only('cmd 2>&1 > out >> log < in &>> all <<< "here string" >| clobber');
  assert.deepEqual(redirects.map(r => [r.fd, r.op, r.target.value]),
    [[2, '>&', '1'], [null, '>', 'out'], [null, '>>', 'log'], [null, '<', 'in'], [null, '&>>', 'all'], [null, '<<<', 'here string'], [null, '>|', 'clobber']]);
});

test('a quoted here-document is data: its body is kept and not parsed', () => {
  // Regression: notes like this were blocked by the text guard on 2026-11-22 and 2026-11-26.
  const { commands } = parseShell("cat > notes.md <<'EOF'\ngit commit -n and --no-verify\n$(rm -rf x)\nEOF\ngit status");
  assert.deepEqual(commands.map(c => c.words.map(w => w.value)), [['cat'], ['git', 'status']]);
  assert.deepEqual(commands[0].redirects.map(r => [r.op, r.target.value, r.heredoc?.body, r.heredoc?.quoted]),
    [['>', 'notes.md', undefined, undefined], ['<<', 'EOF', 'git commit -n and --no-verify\n$(rm -rf x)\n', true]]);
});

test('any quoting in the delimiter makes the here-document data', () => {
  for (const delimiter of ['"EOF"', 'E"O"F', '\\EOF']) {
    const [cat] = parseShell(`cat <<${delimiter}\n$(id)\nEOF`).commands;
    assert.equal(cat.redirects[0].heredoc.quoted, true, delimiter);
  }
});

test('words and here-document bodies record where they sit in the source', () => {
  const sources = [
    "cat > n.md <<'EOF'\nbody\nEOF\ngit commit -m 'msg x' -q",
    'echo $(git commit -m "a b") `git log -1` "$(cat <<\'E\'\nhi\nE\n)"',
    'cat <<X\n$(git status) `id`\nX',
    'for f in a b; do echo "$f"; done; a=(x y); [[ $a == z ]]',
  ];
  for (const source of sources) {
    for (const command of parseShell(source).commands) {
      for (const word of [...command.words, ...command.assignments.map(a => a.value), ...command.redirects.map(r => r.target)]) {
        assert.equal(source.slice(word.start, word.start + word.raw.length), word.raw, `${word.raw} in ${JSON.stringify(source)}`);
      }
      for (const { heredoc } of command.redirects.filter(r => r.heredoc)) {
        assert.equal(source.slice(heredoc.start, heredoc.end), heredoc.body, JSON.stringify(source));
      }
    }
  }
  // A backtick body with escapes removed isn't a slice of the source, so its words have no position.
  const inner = parseShell('echo `echo \\$HOME`').commands.find(c => c.words[1]?.raw === '$HOME');
  assert.equal(inner.words[0].start, null);
});

test('file descriptor forms', () => {
  assert.deepEqual(only('exec 3>&- 4<&0 &> both').redirects.map(r => `${r.fd ?? ''}${r.op}${r.target.value}`), ['3>&-', '4<&0', '&>both']);
});

test('an unquoted here-document runs its substitutions', () => {
  assert.deepEqual(argv('cat <<EOF\nplain $(git commit -n) `id`\nEOF'), [['cat'], ['git', 'commit', '-n'], ['id']]);
});

test('here-documents: <<- strips tabs, two on one line, and inside a substitution', () => {
  const { commands } = parseShell('cat <<-A <<B\n\tone\n\tA\ntwo\nB\necho $(cat <<C\nthree\nC\n)');
  assert.deepEqual(commands[0].redirects.map(r => r.heredoc.body), ['one\n', 'two\n']);
  assert.equal(commands[1].redirects[0].heredoc.body, 'three\n');
});

test('pipes record where stdin comes from', () => {
  const { commands } = parseShell('cat <<EOF | sh\nx\nEOF\necho a | tee b; (c) | sh; d && e');
  const [cat, sh, echo, tee, , subshellSh, , e] = commands;
  assert.equal(sh.pipedFrom, cat);
  assert.equal(tee.pipedFrom, echo);
  assert.equal(subshellSh.pipedFrom, 'compound');
  assert.equal(e.pipedFrom, null);
});

test('function bodies are recorded by name and their commands still listed', () => {
  const { commands, functions } = parseShell('g() { git "$@"; }; function h { (cd x && make); }; g commit -n');
  assert.deepEqual([...functions.keys()], ['g', 'h']);
  assert.deepEqual(functions.get('g').map(c => c.words.map(w => w.value)), [['git', '$@']]);
  assert.deepEqual(commands.at(-1).words.map(w => w.value), ['g', 'commit', '-n']);
});

const errors = [
  ['an unterminated single quote', "echo 'abc"],
  ['an unterminated double quote', 'echo "abc'],
  ['an unterminated substitution', 'echo $(echo'],
  ['an unterminated backtick', 'echo `x'],
  ['an unterminated here-document', 'cat <<EOF\nno end'],
  ['a missing }', '{ echo'],
  ['an unexpected )', 'echo )'],
  [';; outside case', 'a ;; b'],
  ['case without esac', 'case x in a) b ;;'],
  ['[[ without ]]', '[[ -f a'],
  ['a function body that is not a group or subshell', 'f() echo hi'],
  ['a trailing backslash', 'echo \\'],
  ['a named coproc with a group body', 'coproc NAME { cat; }'],
  ['nesting past the depth limit', '$('.repeat(12) + 'x' + ')'.repeat(12)],
  ['${...} nesting past the depth limit, before the stack runs out', 'x ' + '${x:-'.repeat(6000) + '}'.repeat(6000)],
  ['a NUL byte', 'echo a\0b'],
  ["a NUL from $'...', which cuts the word short in bash", "x $'-n\\0' $'a\\x0'"],
  ["\\c in $'...'", "x $'\\cA'"],
  ["an escape past the last Unicode character (a crash, before)", "x $'\\UFFFFFFFF'"],
  ['a here-document opened inside a substitution and read outside it', "echo $(cat <<'X')\nx\nX"],
  ['a commented "(" in $(...) inside $((...))', 'echo $(( $(: # (\n) ; b ))'],
  ['a substitution inside double quotes inside $((...))', 'echo $(( "$(b)" + 1 ))'],
  ["single quotes inside ${...}, which move where it ends", "echo ${x:-'}'a}\\'"],
  ['single quotes inside arithmetic', "echo $(( '))' a ))\\'"],
  ['$[...] arithmetic', 'echo $[1<<2]\nb\n2]'],
  ['an array subscript with a blank or operator', 'a[x y]=1 b'],
  ['a line continuation joining two operators', 'a |\\\n& b'],
];

for (const [name, src] of errors) test(`refuses ${name}`, () => assert.throws(() => parseShell(src), ShellParseError));

// Checked against bash itself: bash runs the payload (a harmless printf) for every input, and the
// parser must either see that command or throw. A clean parse that misses it is a bypass. Each
// one was a bypass before the PR #101 review.
// Its marker appears only when it runs: bash's error messages quote the input (expanded and
// quote-removed), so a marker written out in full could appear without anything running.
const PAYLOAD = 'printf %s%s HID DEN >&2';
const bypasses = [
  ['a continuation inside a reserved word', `if\\\n ${PAYLOAD}; then :; fi`],
  ['a continuation inside an assignment name', `FOO\\\n_BAR=1 ${PAYLOAD}`],
  ['a continuation inside a here-document delimiter', `cat >/dev/null <<EOF\nEO\\\nF\n${PAYLOAD}\nEOF\n`],
  ['a continuation after $ in a here-document', `cat >/dev/null <<EOF\n$\\\n(${PAYLOAD})\nEOF`],
  ['a continuation after $ in double quotes', `echo "$\\\n(${PAYLOAD})" >/dev/null`],
  ['single quotes inside ${...} inside double quotes', `echo "\${x:-'$(${PAYLOAD})'}" >/dev/null`],
  ['single quotes inside arithmetic', `echo $(( '$(${PAYLOAD})' )) 2>/dev/null`],
  ['a named file descriptor', `{fd}>/dev/null ${PAYLOAD}`],
  ['an array element assignment', `a[0]=x ${PAYLOAD}`],
  ['a script name with () on the next line', './hid.sh\n() { :; }'],
  ['a here-document pending across a substitution', `cat >/dev/null <<'X' $(true\n${PAYLOAD}\nX\n)`],
  ['a process substitution inside [[', `[[ -n <(${PAYLOAD}) ]]`],
  // Second review round.
  ['single quotes inside an unquoted ${...}', `echo \${x:-'}'$(${PAYLOAD})}\\'`],
  ['single quotes inside arithmetic, moving its end', `echo $(( '))' $(${PAYLOAD}) ))\\'`],
  ['$[...] holding a here-document operator', `echo $[1<<2]\n${PAYLOAD}\n2]`],
  ['a subscript bash reads across a blank', `a[x y]=1 ${PAYLOAD}`],
  ['a subscript holding a here-document operator', `a[1<<2]=x\n${PAYLOAD}\n2]=x`],
  ['time --', `time -p -- ${PAYLOAD}`],
  ['((...)) closed as a subshell', `((${PAYLOAD}) )`],
  ['$((...)) closed as a substitution', `echo $((${PAYLOAD}) )`],
  // Third review round: bash's own paren count decides whether $((...)) is arithmetic.
  ['a case pattern inside $(( $(...) ))', `echo $(( $(case a in a) ;; esac) ; ${PAYLOAD} {fd}>/dev/null ))`],
  ['a case pattern in backticks inside $((...))', `echo $(( \`case a in a) ;; esac\` ; ${PAYLOAD} {fd}>/dev/null ))`],
  // Fourth review round: bash's count also needs to end at zero, and skips substitutions in "...".
  ['a double-quoted "(" bash does not count', `echo $(( "$(: "(")" + $(case a in a) ;; esac) ; ${PAYLOAD} ))`],
  ['a commented "(" in backticks inside $((...))', `echo $(( \`: # (\` ; ${PAYLOAD} ))`],
];

test('inputs bash runs are seen or refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-parse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'hid.sh'), `#!/bin/sh\n${PAYLOAD}\n`);
  chmodSync(join(dir, 'hid.sh'), 0o755);
  const runsPayload = command => {
    const [first, , third] = command.words.map(w => w.value);
    return (first === 'printf' && third === 'HID') || first === './hid.sh';
  };
  for (const [name, src] of bypasses) {
    await t.test(name, () => {
      const bash = spawnSync('bash', ['-c', src], { cwd: dir, encoding: 'utf8' });
      assert.match(bash.stderr, /HIDDEN/, 'bash should run the payload, or the case proves nothing');
      let commands;
      try { ({ commands } = parseShell(src)); } catch (error) { assert.ok(error instanceof ShellParseError); return; }
      assert.ok(commands.some(runsPayload), 'the parser read it cleanly but missed the command');
    });
  }
});
