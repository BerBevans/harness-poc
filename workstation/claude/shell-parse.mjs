// A bash parser for the workstation guard, so the guard can judge what a command does rather than
// what its text mentions. It reads the subset of bash agents write: words and quoting, operators,
// redirections, here-documents, expansions and substitutions, and the compound commands. It
// returns every simple command it finds, at any depth (inside $(...), backticks, <(...),
// unquoted here-documents, subshells, groups, loops and function bodies), so a caller never has
// to walk a tree. Anything it can't read throws ShellParseError, and the guard then denies.
// Known limit: bash evaluates arithmetic and array subscripts in data, so x='a[$(cmd)]' then
// $((x)), [[ $x -eq 0 ]] and the like run cmd from a quoted string or a file. That is invisible
// to any parser; the guard has to judge such words (and server-side CI is the backstop).

export class ShellParseError extends Error {}

// bash reads these as matched pairs, across blanks and operators. Each is either read the way
// bash reads it or refused; a review should check any change against this list.
//   '...' "..." $'...' $"..."    readWord, readDouble, readAnsiC
//   `...` $(...) <(...) >(...)  readBacktick, substitution
//   $((...)) ((...))             readArithmetic (quotes and backslashes inside are refused);
//                                $((...)) that bash would run as commands is refused
//   ${...}                       readBraces (single quotes and backslashes inside are refused)
//   $[...]                       refused
//   name=(...)                   parseCommand, wordsUntil
//   name[...]=                   readWord (a subscript holding a blank or operator is refused)
//   extglob @(...) and the like  refused (an unexpected "(")

const MAX_DEPTH = 8;
const isMeta = c => c === undefined || ' \t\n;&|<>()'.includes(c);
const PREFIX_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', 'time', 'coproc']);
const END_WORDS = new Set(['fi', 'done', 'esac']);
const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const NAMED_FD = /\{[A-Za-z_]\w*\}[<>]/y;
const ASSIGNMENT = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/;
const REDIRECT = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;

/**
 * @typedef {{raw: string, value: string, dynamic: boolean, glob: boolean, tilde: boolean, quoted: boolean}} Word
 *   value is the word after quote removal and $'...' decoding; dynamic means it holds an
 *   expansion or substitution, so value is not what bash will pass.
 * @typedef {{fd: number|null, op: string, target: Word, heredoc: {body: string, quoted: boolean}|null}} Redirect
 * @typedef {{assignments: {name: string, value: Word}[], words: Word[], redirects: Redirect[],
 *   pipedFrom: SimpleCommand|'compound'|null}} SimpleCommand
 *   pipedFrom is the command whose output a pipe feeds into this one's stdin, or 'compound'
 *   when it comes from a subshell, group or loop. null means unknown, not clean: commands
 *   inside a compound that is piped into (echo x | (sh)) also show null.
 * @returns {{commands: SimpleCommand[], functions: Map<string, SimpleCommand[]>}}
 */
// bash runs $((text)) as a command substitution, $( (text) ), unless a plain scan of the text
// (quotes and backslashes skipped, nothing else understood) finds its parens balanced. A case
// pattern's ")" or a commented "(" inside $(...) or backticks unbalances them. bash's quote
// skipping understands substitutions inside double quotes and this scan doesn't, so a double-
// quoted span holding one is refused rather than guessed at.
function bashReadsAsArithmetic(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === "'") { i = text.indexOf("'", i + 1); if (i < 0) return false; }
    else if (c === '"') {
      const from = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (/\$\(|\$\{|`/.test(text.slice(from, i))) return false;
    }
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

export function parseShell(source) {
  if (source.includes('\0')) throw new ShellParseError('the command contains a NUL byte');
  // bash removes a line continuation before it splits words, so one inside a word, a reserved
  // word, a quoted string or a here-document line changes what runs. Only continuations after a
  // blank or an operator are read; any other throws.
  if (/[^ \t;&|()]\\\n/.test(source)) throw new ShellParseError('a line continuation inside a word');
  // One straight before an operator character can join two operators (| and & into |&).
  if (/\\\n[&|;<>]/.test(source)) throw new ShellParseError('a line continuation inside an operator');
  const sink = { commands: [], functions: new Map() };
  try {
    new Parser(source, 0, sink).parseList(null);
  } catch (error) {
    // Any failure, including a stack overflow, must reach the guard as a parse error so it denies.
    if (error instanceof ShellParseError) throw error;
    throw new ShellParseError(`the parser failed: ${error.message}`);
  }
  return sink;
}

class Parser {
  constructor(src, depth, sink) {
    if (depth > MAX_DEPTH) throw new ShellParseError(`the command nests more than ${MAX_DEPTH} levels deep`);
    Object.assign(this, { src, depth, sink, pos: 0, heredocs: [], groups: [], pendingFunction: null, heredocFloor: 0 });
  }

  fail(message) { throw new ShellParseError(`${message} (at character ${this.pos})`); }
  peek(n = 0) { return this.src[this.pos + n]; }
  startsWith(text) { return this.src.startsWith(text, this.pos); }
  atWord(word) { return this.startsWith(word) && isMeta(this.peek(word.length)); }

  // An unquoted plain word at the current position, for spotting reserved words.
  bareWord() {
    const match = /^[^\s;&|<>()'"`$\\]+/.exec(this.src.slice(this.pos));
    return match && isMeta(this.peek(match[0].length)) ? match[0] : null;
  }

  skipBlanks() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t') this.pos++;
      else if (c === '\\' && this.peek(1) === '\n') this.pos += 2;
      else if (c === '#') while (this.peek() !== undefined && this.peek() !== '\n') this.pos++;
      else return;
    }
  }

  newline() {
    if (this.heredocFloor) this.fail('a here-document is pending across a command substitution');
    this.pos++; this.readHeredocs();
  }

  skipBlanksAndNewlines() {
    for (;;) { this.skipBlanks(); if (this.peek() !== '\n') return; this.newline(); }
  }

  // Commands up to the end of input, an unmatched ")" (stop ")"), or ";;"/"esac" (stop "case").
  parseList(stop) {
    let last = null, pipedFrom = null;
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined) {
        if (stop) this.fail(stop === ')' ? 'missing )' : 'missing esac');
        if (this.heredocs.length) this.fail(`here-document ${this.heredocs[0].target.value} not terminated`);
        if (this.groups.length) this.fail('missing }');
        if (this.pendingFunction) this.fail('function without a body');
        return null;
      }
      if (c === '\n') { this.newline(); continue; }
      if (c === ')') { if (stop !== ')') this.fail('unexpected )'); this.pos++; return null; }
      if (this.startsWith(';;') || this.startsWith(';&')) {
        if (stop !== 'case') this.fail('unexpected ;;');
        this.pos += this.startsWith(';;&') ? 3 : 2;
        return 'next';
      }
      if (stop === 'case' && this.atWord('esac')) return 'esac';
      const operator = /^(&&|\|\||\|&|;|\||&(?!>))/.exec(this.src.slice(this.pos));
      if (operator) {
        this.pos += operator[0].length;
        pipedFrom = operator[0] === '|' || operator[0] === '|&' ? last : null;
        continue;
      }
      last = this.parseCommand(pipedFrom);
      pipedFrom = null;
    }
  }

  // Returns the command, or 'compound' when a compound command (whose output can't be pinned
  // to one simple command) ends here, so a pipe after it is recorded as coming from 'compound'.
  parseCommand(pipedFrom) {
    const command = { assignments: [], words: [], redirects: [], pipedFrom };
    let compound = false;
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined || c === '\n' || c === ';' || c === '|' || c === ')' || (c === '&' && this.peek(1) !== '>')) break;
      NAMED_FD.lastIndex = this.pos;
      if (NAMED_FD.test(this.src)) this.fail('named file descriptors ({name}>) are not supported');
      const atStart = !command.words.length && !command.assignments.length && !command.redirects.length;
      if (atStart) {
        const before = this.pos;
        if (this.compound()) return 'compound';
        if (this.pos !== before) { compound = true; continue; }
      }
      if (this.redirect(command)) continue;
      if (c === '(') this.fail('unexpected (');
      const word = this.readWord();
      if (!word) this.fail(`unexpected ${c}`);
      const assignment = ASSIGNMENT.exec(word.raw);
      // An array value, as a prefix or an argument to declare, local and the like.
      if (assignment && word.raw.endsWith('=') && this.peek() === '(') { this.pos++; this.wordsUntil(')'); word.dynamic = true; }
      if (assignment && !command.words.length) {
        const rest = word.raw.slice(assignment[0].length);
        command.assignments.push({ name: assignment[1], value: { ...word, value: word.value.slice(word.value.indexOf('=') + 1), tilde: /^~|:~/.test(rest) } });
      } else {
        command.words.push(word);
      }
    }
    if (command.words.length || command.assignments.length || command.redirects.length) this.sink.commands.push(command);
    return compound && !command.words.length ? 'compound' : command;
  }

  // Reserved words and compound commands at the start of a command. Returns true when it has
  // consumed a whole construct, false when parseCommand should carry on at the new position.
  compound() {
    for (;;) {
      this.skipBlanks();
      const word = this.bareWord();
      if (this.pendingFunction && word !== '{' && this.peek() !== '(') this.fail('unsupported function body');
      if (this.startsWith('((')) { this.pos += 2; this.readArithmetic(); return true; }
      if (this.peek() === '(') { this.pos++; this.subshell(); return false; }
      if (word === null) return false;
      if (PREFIX_WORDS.has(word)) {
        this.pos += word.length;
        if (word === 'time') {
          this.skipBlanks(); if (this.atWord('-p')) this.pos += 2;
          this.skipBlanks(); if (this.atWord('--')) this.pos += 2;
        }
        continue;
      }
      if (word === '{') { this.pos++; this.groups.push({ fn: this.takeFunction(), start: this.sink.commands.length }); continue; }
      if (word === '}') { this.pos++; this.closeGroup(); return false; }
      if (END_WORDS.has(word)) { this.pos += word.length; return false; }
      if (word === 'for' || word === 'select') { this.pos += word.length; this.forClause(); return true; }
      if (word === 'case') { this.pos += 4; this.caseClause(); return true; }
      if (word === '[[') { this.pos += 2; this.testClause(); return false; }
      if (word === 'function') { this.pos += 8; this.skipBlanks(); this.functionHeader(this.bareWord()); return true; }
      if (/^[ \t]*\([ \t]*\)/.test(this.src.slice(this.pos + word.length))) { this.functionHeader(word); return true; }
      return false;
    }
  }

  functionHeader(name) {
    if (!name) this.fail('function without a name');
    this.pos += name.length;
    const parens = /^[ \t]*\([ \t]*\)/.exec(this.src.slice(this.pos));
    if (parens) this.pos += parens[0].length;
    this.pendingFunction = name;
  }

  takeFunction() { const fn = this.pendingFunction; this.pendingFunction = null; return fn; }

  closeGroup() {
    const group = this.groups.pop();
    if (!group) this.fail('unexpected }');
    if (group.fn) this.sink.functions.set(group.fn, this.sink.commands.slice(group.start));
  }

  subshell() {
    const fn = this.takeFunction();
    const start = this.sink.commands.length;
    this.nested(() => this.parseList(')'));
    if (fn) this.sink.functions.set(fn, this.sink.commands.slice(start));
  }

  // $(...), <(...) and >(...). bash's rules for a here-document opened on one side of a
  // substitution's edge and read on the other are subtle, so a newline inside a substitution
  // while an outer here-document is pending, or one left open at its ")", throws.
  substitution() {
    const floor = this.heredocFloor;
    this.heredocFloor = this.heredocs.length;
    this.nested(() => this.parseList(')'));
    if (this.heredocs.length > this.heredocFloor) this.fail('a here-document is not terminated inside its substitution');
    this.heredocFloor = floor;
  }

  // Runs a nested list on the same source; groups opened inside must close inside.
  nested(parse) {
    if (++this.depth > MAX_DEPTH) this.fail(`the command nests more than ${MAX_DEPTH} levels deep`);
    const groups = this.groups.length;
    parse();
    if (this.groups.length !== groups) this.fail('missing }');
    this.depth--;
  }

  forClause() {
    this.skipBlanks();
    if (this.startsWith('((')) { this.pos += 2; this.readArithmetic(); return; }
    if (!this.readWord()) this.fail('for without a name');
    this.skipBlanksAndNewlines();
    if (!this.atWord('in')) return;
    this.pos += 2;
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined || c === '\n' || c === ';') return;
      if (!this.readWord()) this.fail('bad word in for list');
    }
  }

  caseClause() {
    this.skipBlanks();
    if (!this.readWord()) this.fail('case without a word');
    this.skipBlanksAndNewlines();
    if (!this.atWord('in')) this.fail('case without in');
    this.pos += 2;
    for (;;) {
      this.skipBlanksAndNewlines();
      if (this.atWord('esac')) { this.pos += 4; return; }
      if (this.peek() === '(') this.pos++;
      this.wordsUntil(')', '|');
      if (this.nestedCase() === 'esac') { this.pos += 4; return; }
    }
  }

  nestedCase() { let end; this.nested(() => { end = this.parseList('case'); }); return end; }

  // [[ ... ]]: operators inside are plain words, not redirections or separators.
  testClause() {
    for (;;) {
      this.skipBlanks();
      if (this.peek() === undefined) this.fail('missing ]]');
      if (this.atWord(']]')) { this.pos += 2; return; }
      if (this.peek() === '\n') { this.newline(); continue; }
      if ('<>'.includes(this.peek()) && this.peek(1) === '(') { this.readWord(); continue; }
      if ('<>()!|&'.includes(this.peek())) { this.pos++; continue; }
      if (!this.readWord()) this.fail('bad word in [[');
    }
  }

  // Words up to a closing character (array values, case patterns); separators are skipped.
  wordsUntil(close, separator = null) {
    for (;;) {
      this.skipBlanksAndNewlines();
      const c = this.peek();
      if (c === close) { this.pos++; return; }
      if (c === separator) { this.pos++; continue; }
      if (c === undefined || !this.readWord()) this.fail(`missing ${close}`);
    }
  }

  redirect(command) {
    const match = REDIRECT.exec(this.src.slice(this.pos, this.pos + 12));
    if (!match) return false;
    if ((match[2] === '<' || match[2] === '>') && this.peek(match[0].length) === '(') return false;
    this.pos += match[0].length;
    this.skipBlanks();
    const target = this.readWord();
    if (!target) this.fail(`missing target for ${match[2]}`);
    const redirect = { fd: match[1] ? Number(match[1]) : null, op: match[2], target, heredoc: null };
    if (match[2] === '<<' || match[2] === '<<-') this.heredocs.push(redirect);
    command.redirects.push(redirect);
    return true;
  }

  readHeredocs() {
    for (const redirect of this.heredocs.splice(0)) {
      const delimiter = redirect.target.value;
      const lines = [];
      for (;;) {
        if (this.pos >= this.src.length) this.fail(`here-document ${delimiter} not terminated`);
        const end = this.src.indexOf('\n', this.pos) < 0 ? this.src.length : this.src.indexOf('\n', this.pos);
        let line = this.src.slice(this.pos, end);
        this.pos = Math.min(end + 1, this.src.length);
        if (redirect.op === '<<-') line = line.replace(/^\t+/, '');
        if (line === delimiter) break;
        if (!redirect.target.quoted && line.endsWith('\\')) this.fail('a line continuation in a here-document');
        lines.push(line);
      }
      const body = lines.map(line => `${line}\n`).join('');
      redirect.heredoc = { body, quoted: redirect.target.quoted };
      // An unquoted here-document expands $(...) and backticks when the command runs.
      if (!redirect.target.quoted) new Parser(body, this.depth + 1, this.sink).scanExpansions();
    }
  }

  scanExpansions() {
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') this.pos += 2;
      else if (c === '$') this.readDollar();
      else if (c === '`') this.readBacktick(false);
      else this.pos++;
    }
  }

  /** @returns {Word|null} */
  readWord() {
    const start = this.pos;
    let value = '', dynamic = false, glob = false, quoted = false, brace = -1;
    const tilde = this.peek() === '~';
    for (;;) {
      const c = this.peek();
      if (c === '\\') {
        if (this.peek(1) === '\n') { this.pos += 2; continue; }
        if (this.peek(1) === undefined) this.fail('backslash at the end of the command');
        value += this.peek(1); this.pos += 2; quoted = true; continue;
      }
      if ((c === '<' || c === '>') && this.peek(1) === '(') {
        const from = this.pos;
        this.pos += 2; this.substitution();
        value += this.src.slice(from, this.pos); dynamic = true; continue;
      }
      if (isMeta(c)) break;
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) this.fail('unterminated single quote');
        value += this.src.slice(this.pos + 1, end); this.pos = end + 1; quoted = true; continue;
      }
      if (c === '$' && this.peek(1) === "'") { this.pos += 2; value += this.readAnsiC(); quoted = true; continue; }
      if (c === '"' || (c === '$' && this.peek(1) === '"')) {
        this.pos += c === '"' ? 1 : 2;
        // $"..." can be replaced by a translation, so its value is not certain.
        const part = this.readDouble(); value += part.value; dynamic ||= part.dynamic || c === '$'; quoted = true; continue;
      }
      if (c === '$') { const part = this.readDollar(); value += part; dynamic ||= part !== '$'; continue; }
      if (c === '`') { value += this.readBacktick(false); dynamic = true; continue; }
      // A word starting name[ is read by bash to the matching ], blanks and operators included.
      if (c === '[' && /^[A-Za-z_]\w*$/.test(this.src.slice(start, this.pos))) {
        const close = this.src.indexOf(']', this.pos);
        if (close < 0 || /[\s;&|<>()'"`\\]/.test(this.src.slice(this.pos + 1, close))) this.fail('an array subscript bash would read across blanks or operators');
      }
      if ('*?['.includes(c)) glob = true;
      // Brace expansion ({a,b} or {1..3}) turns one word into several.
      if (c === '{' && brace < 0) brace = value.length;
      if (c === '}' && brace >= 0 && /,|\.\./.test(value.slice(brace))) dynamic = true;
      value += c; this.pos++;
    }
    if (this.pos === start) return null;
    return { raw: this.src.slice(start, this.pos), value, dynamic, glob, tilde, quoted };
  }

  readDouble() {
    let value = '', dynamic = false;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('unterminated double quote');
      if (c === '"') { this.pos++; return { value, dynamic }; }
      if (c === '\\' && this.peek(1) === '\n') { this.pos += 2; continue; }
      if (c === '\\' && '$`"\\'.includes(this.peek(1) ?? ' ')) { value += this.peek(1); this.pos += 2; continue; }
      if (c === '$') { const part = this.readDollar(); value += part; dynamic ||= part !== '$'; continue; }
      if (c === '`') { value += this.readBacktick(true); dynamic = true; continue; }
      value += c; this.pos++;
    }
  }

  // $name, ${...}, $(...), $((...)) and special parameters; returns the raw text. A $ that
  // starts none of these is a literal $.
  readDollar() {
    const start = this.pos++;
    const c = this.peek();
    if (this.startsWith('((')) {
      this.pos += 2;
      const from = this.pos;
      this.nested(() => this.readArithmetic());
      if (!bashReadsAsArithmetic(this.src.slice(from, this.pos - 2))) this.fail('$((...)) that bash would run as a command substitution');
    }
    else if (c === '(') { this.pos++; this.substitution(); }
    else if (c === '{') { this.pos++; this.nested(() => this.readBraces()); }
    else if (c === '[') this.fail('$[...] arithmetic is not supported');
    else if (/[A-Za-z_]/.test(c ?? '')) { while (/\w/.test(this.peek() ?? '')) this.pos++; }
    else if (/[0-9@*#?$!-]/.test(c ?? '')) this.pos++;
    else return '$';
    return this.src.slice(start, this.pos);
  }

  // Inside ${...} and arithmetic, single quotes quote in some contexts and not others (not
  // within double quotes or here-documents), which moves where the construct ends, so they are
  // refused, as are backslashes.
  readBraces() {
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('unterminated ${');
      if (c === '}') { this.pos++; return; }
      if (c === "'" || c === '\\') this.fail(`a ${c} inside \${...}`);
      if (c === '"') { this.pos++; this.readDouble(); }
      else if (c === '$') this.readDollar();
      else if (c === '`') this.readBacktick(false);
      else this.pos++;
    }
  }

  readArithmetic() {
    let parens = 0;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('unterminated arithmetic');
      if (c === ')' && parens === 0) {
        if (this.peek(1) !== ')') this.fail('unterminated arithmetic');
        this.pos += 2; return;
      }
      if (c === '$') { this.readDollar(); continue; }
      if (c === '`') { this.readBacktick(false); continue; }
      if (c === '"') { this.pos++; this.readDouble(); continue; }
      if (c === "'" || c === '\\') this.fail(`a ${c} inside arithmetic`);
      if (c === '(') parens++;
      if (c === ')') parens--;
      this.pos++;
    }
  }

  // `...`: backslash escapes $, ` and \ (and " inside double quotes); the rest is a command list.
  readBacktick(inDouble) {
    const start = this.pos++;
    let body = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('unterminated backtick');
      if (c === '`') { this.pos++; break; }
      if (c === '\\' && (inDouble ? '$`\\"' : '$`\\').includes(this.peek(1) ?? ' ')) { body += this.peek(1); this.pos += 2; continue; }
      body += c; this.pos++;
    }
    if (body.includes('\n') && this.heredocs.length) this.fail('a here-document is pending across a command substitution');
    new Parser(body, this.depth + 1, this.sink).parseList(null);
    return this.src.slice(start, this.pos);
  }

  readAnsiC() {
    let value = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail("unterminated $'");
      this.pos++;
      if (c === "'") {
        if (value.includes('\0')) this.fail("a NUL in $'...' cuts the word short");
        return value;
      }
      if (c !== '\\') { value += c; continue; }
      const next = this.peek();
      if (next !== undefined && Object.hasOwn(ANSI_C, next)) { value += ANSI_C[next]; this.pos++; continue; }
      const rest = this.src.slice(this.pos);
      const octal = /^[0-7]{1,3}/.exec(rest);
      const hex = /^x([0-9a-fA-F]{1,2})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})/.exec(rest);
      // bash keeps the low byte of an octal escape: \516 is N.
      if (octal) { value += String.fromCharCode(parseInt(octal[0], 8) & 0xff); this.pos += octal[0].length; }
      else if (hex) {
        const code = parseInt(hex[1] ?? hex[2] ?? hex[3], 16);
        if (code > 0x10ffff) this.fail("an escape in $'...' past the last Unicode character");
        value += String.fromCodePoint(code); this.pos += hex[0].length;
      }
      else if (next === 'c') this.fail("\\c in $'...' is not supported");
      else value += '\\';
    }
  }
}
