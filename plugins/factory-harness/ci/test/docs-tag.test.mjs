import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The docs' examples pin the harness by tag. They fell three releases behind twice, so this test
// fails when they name an older tag than the newest one. A newer tag is allowed, so a release PR can
// bump the docs before its merge is tagged. Harness CI must check out with tags for this to work.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCS = ['README.md', ...fs.readdirSync(path.join(repoRoot, 'docs'))
  .filter(name => name.endsWith('.md'))
  .map(name => path.join('docs', name))];

// `harness-poc#v1.2.3` (marketplace) and `harness-poc/actions/<name>@v1.2.3` (actions).
const PIN = /harness-poc(?:#|\/actions\/[\w-]+@)(v\d+\.\d+\.\d+)\b/g;

const parse = tag => tag.slice(1).split('.').map(Number);

function compareTags(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function examplePins() {
  return DOCS.flatMap(file => [...fs.readFileSync(path.join(repoRoot, file), 'utf8').matchAll(PIN)]
    .map(match => ({ file, tag: match[1] })));
}

function newestTag() {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  return tags.sort(compareTags).at(-1);
}

test('tags compare by number, not as text', () => {
  assert.ok(compareTags('v0.10.0', 'v0.9.0') > 0);
  assert.ok(compareTags('v1.0.0', 'v0.99.99') > 0);
  assert.ok(compareTags('v0.9.1', 'v0.9.0') > 0);
  assert.equal(compareTags('v0.9.0', 'v0.9.0'), 0);
});

test('the docs\' examples all name one tag, no older than the newest tag', () => {
  const pins = examplePins();
  assert.ok(pins.length > 0, 'found no harness pins in the docs: has the example format changed?');

  const named = [...new Set(pins.map(pin => pin.tag))];
  assert.equal(named.length, 1,
    `the examples name more than one tag: ${pins.map(pin => `${pin.file} ${pin.tag}`).join(', ')}`);

  const newest = newestTag();
  assert.ok(newest, 'no v* tags found: harness CI needs `fetch-tags: true` on its checkout');
  assert.ok(compareTags(named[0], newest) >= 0,
    `the docs' examples name ${named[0]} but the newest tag is ${newest}: bump README.md and docs/`);
});
