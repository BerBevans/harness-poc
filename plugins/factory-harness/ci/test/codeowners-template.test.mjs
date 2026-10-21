import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GUARDRAIL_EXAMPLES, ORDINARY_EXAMPLES } from './helpers.mjs';

const templatePath = new URL('../../../../templates/CODEOWNERS.example', import.meta.url);
const OWNER = '@harness-owner';

// The template's rules as [pattern, owners]. Comments and blank lines are skipped.
const rules = fs.readFileSync(templatePath, 'utf8').split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => { const [pattern, ...owners] = line.split(/\s+/); return { pattern, owners }; });

// GitHub's CODEOWNERS matching, which follows .gitignore: a pattern with a slash at the start or in
// the middle is anchored to the root, otherwise it matches at any depth. A trailing slash matches
// a folder and everything in it. Matching is case-sensitive.
function toRegex(pattern) {
  const folder = pattern.endsWith('/');
  const body = pattern.replace(/^\//, '').replace(/\/$/, '');
  const anchored = pattern.startsWith('/') || body.includes('/');
  const glob = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${glob}${folder ? '/.+' : '(?:/.*)?'}$`);
}

// The owners of a path: the last matching rule wins, as on GitHub.
const ownersOf = path => rules.findLast(rule => toRegex(rule.pattern).test(path))?.owners ?? [];

test('the matcher follows GitHub\'s anchoring and folder rules', () => {
  assert.ok(toRegex('.editorconfig').test('src/A/.editorconfig'));
  assert.ok(toRegex('/ARCHITECTURE.md').test('ARCHITECTURE.md'));
  assert.ok(!toRegex('/ARCHITECTURE.md').test('src/ARCHITECTURE.md'));
  assert.ok(toRegex('.github/').test('src/.github/workflows/ci.yml'));
  assert.ok(!toRegex('.github/').test('.github'));
  assert.ok(toRegex('**/.config/dotnet-tools.json').test('.config/dotnet-tools.json'));
  assert.ok(toRegex('*.globalconfig').test('src/relaxed.globalconfig'));
  assert.ok(!toRegex('*.globalconfig').test('src/relaxed.globalconfig.bak'));
  assert.ok(!toRegex('nuget.config').test('NuGet.Config'));
});

test('every rule names the owner placeholder and nothing else', () => {
  assert.ok(rules.length > 0);
  for (const { pattern, owners } of rules) assert.deepEqual(owners, [OWNER], pattern);
});

test('every guardrail path the path check catches is owned', () => {
  const unowned = GUARDRAIL_EXAMPLES.filter(path => ownersOf(path).length === 0);
  assert.deepEqual(unowned, []);
});

test('the casings .NET tools look for are owned', () => {
  const variants = [
    'nuget.config', 'NuGet.config', 'src/NuGet.Config', 'src/.config/dotnet-tools.json',
    'stryker-config.yml', 'stryker-config.yaml', '.claude/agents/reviewer.md',
  ];
  assert.deepEqual(variants.filter(path => ownersOf(path).length === 0), []);
});

test('the product and architecture docs are owned', () => {
  const docs = ['docs/product.md', 'ARCHITECTURE.md', 'docs/adr/0001-record-decisions.md'];
  assert.deepEqual(docs.filter(path => ownersOf(path).length === 0), []);
});

test('ordinary code, tests and docs are not owned', () => {
  assert.deepEqual(ORDINARY_EXAMPLES.filter(path => ownersOf(path).length > 0), []);
});
