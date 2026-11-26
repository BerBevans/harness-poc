// Run with: node --test "workstation/claude/*.test.mjs"
// The parser-based guard must never be weaker than the pattern-matching one it replaced:
// whatever the old guard denies, the new one denies too. fixtures/guard-git-hooks.v1.mjs is
// the old guard, frozen as it was on main (ba4c8c8). Every case, and each case wrapped in the
// ways bash can run or hide a command, goes through both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './guard-git-hooks.mjs';
import { evaluate as evaluateOld } from './fixtures/guard-git-hooks.v1.mjs';
import { blocked, allowed } from './guard-git-hooks.cases.mjs';

const env = { home: '/home/dev', termsFile: undefined };
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const quote = s => `'${s.split("'").join("'\\''")}'`;

// Places a command can sit. direct: the shell runs it as written (in a function, subshell or
// substitution); the rest pass it through another shell or keep it as data the parser reads past.
const WRAPPERS = [
  { direct: true, wrap: s => s },
  { direct: true, wrap: s => `f() {\n${s}\n}; f` },
  { direct: true, wrap: s => `true && (${s})` },
  { direct: true, wrap: s => `x=$(${s})` },
  { wrap: s => `bash -c ${quote(s)}` },
  { wrap: s => `eval ${quote(s)}` },
  { wrap: s => `bash <<'ZZ'\n${s}\nZZ` },
  { wrap: s => `cat <<'ZZ' | sh\n${s}\nZZ` },
  { wrap: s => `echo ${quote(s)} | sh` },
  { wrap: s => `trap ${quote(s)} EXIT` },
  { wrap: s => `watch ${quote(s)}` },
  { wrap: s => `a=(${quote(s)})` },
  { wrap: s => `for x in ${quote(s)}; do :; done` },
  { wrap: s => `[[ ${quote(s)} == x ]]` },
  { wrap: s => `# ${s}\ntrue` },
];

// Old-guard denials the new guard is meant to drop: the allowed cases, run directly, where the
// parser proves the flag or setting is data (a commit message, a quoted note, a config read).
// Passed through another shell or hidden in data, the same text is still denied.
const INTENDED = new Set(allowed.map(([, command]) => command));

const commands = [...blocked, ...allowed].map(([, command]) => command);

test('the new guard denies everything the old guard denies', () => {
  const weaker = [];
  for (const command of commands) {
    for (const { direct, wrap } of WRAPPERS) {
      if (direct && INTENDED.has(command)) continue;
      const wrapped = wrap(command);
      if (evaluateOld(bash(wrapped), env) && !evaluate(bash(wrapped), env)) weaker.push(wrapped);
    }
  }
  assert.deepEqual(weaker, [], 'the old guard denies these and the new one allows them');
});

test('the comparison has teeth: the old guard denies a quarter or more of the wrapped blocked cases', () => {
  const wrapped = blocked.flatMap(([, c]) => WRAPPERS.map(({ wrap }) => wrap(c)));
  const denied = wrapped.filter(c => evaluateOld(bash(c), env));
  assert.ok(denied.length >= wrapped.length / 4, `the old guard denied only ${denied.length} of ${wrapped.length} wrapped cases`);
});
