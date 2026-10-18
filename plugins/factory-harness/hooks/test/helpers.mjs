// Shared test inputs. Rules are tested through guard.evaluate so the tests see what the
// hook would actually decide, including which rule wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../guard.mjs';

export const HOME = 'C:\\Users\\dev';
export const REPO = 'C:\\Development\\app';

export function fakeContext({ env = {}, files = {}, branch = 'feature/42-add-task' } = {}) {
  return {
    home: HOME,
    env,
    readFile: filePath => files[filePath] ?? null,
    currentBranch: () => branch,
  };
}

export const bash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: REPO });
export const powershell = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: REPO });
export const read = filePath => ({ tool_name: 'Read', tool_input: { file_path: filePath }, cwd: REPO });
export const write = (filePath, content = '') => ({ tool_name: 'Write', tool_input: { file_path: filePath, content }, cwd: REPO });
export const edit = (filePath, oldString, newString) =>
  ({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: oldString, new_string: newString }, cwd: REPO });

/** Registers one test per row: [name, input] for blocked and allowed tables. */
export function decisionTable({ blocked = [], allowed = [], context = fakeContext() }) {
  for (const [name, input] of blocked) {
    test(`blocks: ${name}`, () => assert.ok(evaluate(input, context), 'expected a denial reason'));
  }
  for (const [name, input] of allowed) {
    test(`allows: ${name}`, () => assert.equal(evaluate(input, context), null));
  }
  test('every denial says what to do instead', () => {
    for (const [, input] of blocked) assert.match(evaluate(input, context), /Stop and tell the user/);
  });
}
