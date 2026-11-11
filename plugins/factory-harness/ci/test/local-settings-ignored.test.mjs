// Claude Code's local settings file can hold secrets, so every repo the harness owns ignores it.
// The guardrail path check backstops this in product repos; this test keeps the ignore rules here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RULE = '**/.claude/settings.local.json';
const repoFile = path => new URL(`../../../../${path}`, import.meta.url);

for (const path of ['.gitignore', 'samples/consumer/.gitignore']) {
  test(`${path} ignores Claude Code's local settings file`, () => {
    const lines = readFileSync(repoFile(path), 'utf8').split(/\r?\n/).map(line => line.trim());
    assert.ok(lines.includes(RULE), `${path} must have the line ${RULE}`);
  });
}
