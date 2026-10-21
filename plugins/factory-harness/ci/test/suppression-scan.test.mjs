import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parsePatch, run } from '../suppression-scan.mjs';
import { fakeApi } from './helpers.mjs';

const OWNER = { login: 'owner', id: 1001, type: 'User' };
const AGENT = { login: 'factory-implementer[bot]', id: 2002, type: 'Bot' };
const DEPENDABOT = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };

// A changed file as the API returns it, built from the diff lines after the hunk header.
function diff(filename, lines, { startLine = 1, status = 'modified' } = {}) {
  const additions = lines.filter(l => l.startsWith('+')).length;
  return { filename, status, additions, deletions: lines.filter(l => l.startsWith('-')).length,
    patch: [`@@ -${startLine},10 +${startLine},10 @@`, ...lines].join('\n') };
}

const scan = (author, files) => evaluate({ author, files, changedFileCount: files.length, exemptUserIds: [OWNER.id] });

test('a new pragma in C# fails, pointing at its line in the new file', () => {
  const file = diff('src/Tasks/TaskList.cs', [' namespace Tasks;', '+#pragma warning disable CA1822', ' public class TaskList'], { startLine: 20 });
  const result = scan(AGENT, [file]);
  assert.equal(result.passed, false);
  assert.equal(result.lines[0], '::error file=src/Tasks/TaskList.cs,line=21::Adds a suppression: #pragma warning disable.');
  assert.match(result.lines.at(-1), /fix the underlying warning or test instead/);
});

test('every C# rule the hook has is applied', () => {
  const added = [
    '+#nullable disable', '+[SuppressMessage("x", "y")]', '+// Stryker disable all', '+[Fact(Skip = "later")]',
    '+[Test, Explicit]', '+Assert.Skip("no");', '+[Ignore]', '+[ExcludeFromCodeCoverage]', '+[DebuggerNonUserCode]',
    '+[DebuggerHidden]',
  ];
  const result = scan(AGENT, [diff('src/A.cs', added)]);
  assert.equal(result.passed, false);
  assert.equal(result.lines.length - 1, added.length);
});

test('a build setting in a project file fails, without calling it a suppression', () => {
  const result = scan(AGENT, [diff('src/Tasks/Tasks.csproj', ['+    <NoWarn>CS1591</NoWarn>'])]);
  assert.equal(result.lines[0],
    '::error file=src/Tasks/Tasks.csproj,line=1::Sets NoWarn, a build setting only the shared Directory.Build.props may set.');
  assert.match(result.lines.at(-1), /remove them from project files/);
});

test('pointing a test project at run settings fails, since they can exclude code from coverage', () => {
  const result = scan(AGENT, [diff('tests/A.UnitTests/A.UnitTests.csproj', ['+    <RunSettingsFilePath>x.runsettings</RunSettingsFilePath>'])]);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /Sets RunSettingsFilePath/);
});

test('switching a setting on in a project file also fails, as dotnet new does with Nullable', () => {
  const result = scan(AGENT, [diff('src/New/New.csproj', ['+    <Nullable>enable</Nullable>'], { status: 'added' })]);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /Sets Nullable/);
});

test('project-file rules do not apply to C#, nor C# rules to project files', () => {
  const files = [diff('src/A.cs', ['+var noWarn = "<NoWarn>";']), diff('src/A.csproj', ['+<!-- #pragma warning disable -->'])];
  assert.equal(scan(AGENT, files).passed, true);
});

test('a suppression moved within a file passes', () => {
  const file = diff('src/A.cs', ['-#pragma warning disable CA1822', ' class A {}', '+#pragma warning disable CA1822']);
  assert.equal(scan(AGENT, [file]).passed, true);
});

test('a suppression moved to another file passes', () => {
  const files = [
    diff('src/Old.cs', ['-#pragma warning disable CA1822']),
    diff('src/New.cs', ['+#pragma warning disable CA1822']),
  ];
  assert.equal(scan(AGENT, files).passed, true);
});

test('one removed and two added fails, reporting both added', () => {
  const files = [
    diff('src/A.cs', ['-#pragma warning disable CA1822']),
    diff('src/B.cs', ['+#pragma warning disable CA1822']),
    diff('src/C.cs', ['+#pragma warning disable CA1822']),
  ];
  const result = scan(AGENT, files);
  assert.equal(result.passed, false);
  assert.deepEqual(result.lines.slice(0, 2).map(l => l.split('::')[1]), ['error file=src/B.cs,line=1', 'error file=src/C.cs,line=1']);
});

test('a different suppression removed does not pay for one added', () => {
  const file = diff('src/A.cs', ['-#nullable disable', '+#pragma warning disable CA1822']);
  assert.equal(scan(AGENT, [file]).passed, false);
});

test('a suppression split across lines is still caught', () => {
  const file = diff('tests/ATests.cs', ['+[Test,', '+ Ignore]']);
  const result = scan(AGENT, [file]);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /line=1::Adds a suppression: \[Ignore\]/);
});

test('generated code and other file types are not scanned', () => {
  const files = [
    diff('src/obj/Debug/A.cs', ['+#pragma warning disable']),
    diff('src/A.Designer.cs', ['+#pragma warning disable']),
    diff('docs/suppressions.md', ['+Never write #pragma warning disable.']),
  ];
  assert.equal(scan(AGENT, files).passed, true);
});

test('the owner and Dependabot are exempt', () => {
  const files = [diff('src/A.cs', ['+#pragma warning disable'])];
  assert.deepEqual(scan(OWNER, files).lines, ['owner is exempt from the suppression scan.']);
  assert.equal(scan(DEPENDABOT, files).passed, true);
});

test('fails closed when a C# file that gained lines has no diff', () => {
  const file = { filename: 'src/Big.cs', status: 'modified', additions: 5000, deletions: 0 };
  const result = scan(AGENT, [file]);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /file=src\/Big.cs::GitHub didn't return this file's diff/);
});

test('a missing diff is harmless for a file that only lost lines, or a file type not scanned', () => {
  const files = [
    { filename: 'src/Gone.cs', status: 'removed', additions: 0, deletions: 900 },
    { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 },
    { filename: 'data/big.json', status: 'modified', additions: 9000, deletions: 0 },
  ];
  assert.equal(scan(AGENT, files).passed, true);
});

test('fails closed when not every changed file was listed', () => {
  const result = evaluate({ author: AGENT, files: [], changedFileCount: 4000, exemptUserIds: [OWNER.id] });
  assert.equal(result.passed, false);
});

test('parsePatch tracks new-file line numbers across hunks, skipping removed lines', () => {
  const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '@@ -40,2 +40,3 @@', ' x', '+y', '\\ No newline at end of file'].join('\n');
  const { addedText, removedText, lineStarts } = parsePatch(patch);
  assert.equal(addedText, 'c\ny');
  assert.equal(removedText, 'b');
  assert.deepEqual(lineStarts, [{ offset: 0, line: 2 }, { offset: 2, line: 41 }]);
});

test('run scans the PR from the event, and refuses pull_request', async () => {
  const env = {
    GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: 'event.json', GITHUB_API_URL: 'https://api',
    GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', EXEMPT_USER_IDS: '1001',
  };
  const readEvent = () => ({ pull_request: { number: 7, user: AGENT, changed_files: 1 } });
  const api = fakeApi([diff('src/A.cs', ['+#pragma warning disable'])]);
  assert.equal((await run({ env, readEvent, fetchImpl: api.fetchImpl })).passed, false);
  await assert.rejects(run({ env: { ...env, GITHUB_EVENT_NAME: 'pull_request' }, readEvent, fetchImpl: api.fetchImpl }),
    /suppression scan must run on pull_request_target/);
});
