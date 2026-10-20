import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fetchChangedFiles, guardrailPathsTouched, parseUserIds, run } from '../guardrail-paths.mjs';

const OWNER = { login: 'owner', id: 1001, type: 'User' };
const AGENT = { login: 'factory-implementer[bot]', id: 2002, type: 'Bot' };
const DEPENDABOT = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };
const STRANGER = { login: 'someone', id: 3003, type: 'User' };

const changed = (...filenames) => filenames.map(filename => ({ filename, status: 'modified' }));
const check = (author, files) => evaluate({ author, files, changedFileCount: files.length, exemptUserIds: [OWNER.id] });

test('every guardrail path the decisions doc lists is caught', () => {
  const guardrails = [
    '.editorconfig', 'src/Tasks/.editorconfig', 'src/relaxed.globalconfig',
    'Directory.Build.props', 'src/Directory.Build.targets', 'Directory.Packages.props',
    'NuGet.Config', 'global.json', '.config/dotnet-tools.json', 'stryker-config.json',
    '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/settings.json',
    'tests/Tasks.ArchitectureTests/LayerTests.cs',
  ];
  assert.deepEqual(guardrailPathsTouched(changed(...guardrails)), guardrails);
});

test('ordinary source, test and doc files are not guardrails', () => {
  const ordinary = ['src/Tasks/TaskList.cs', 'tests/Tasks.UnitTests/TaskListTests.cs', 'README.md', 'docs/github.md'];
  assert.deepEqual(guardrailPathsTouched(changed(...ordinary)), []);
});

test('a guardrail file renamed away counts under its old name', () => {
  const files = [{ filename: 'old.editorconfig.bak', previous_filename: '.editorconfig', status: 'renamed' }];
  assert.deepEqual(guardrailPathsTouched(files), ['.editorconfig']);
});

test('a file renamed into a guardrail path counts under its new name', () => {
  const files = [{ filename: '.github/workflows/x.yml', previous_filename: 'notes/x.yml', status: 'renamed' }];
  assert.deepEqual(guardrailPathsTouched(files), ['.github/workflows/x.yml']);
});

test('a deleted guardrail file counts', () => {
  assert.deepEqual(guardrailPathsTouched([{ filename: 'global.json', status: 'removed' }]), ['global.json']);
});

test('an agent PR touching a guardrail fails, naming each file and what to do', () => {
  const result = check(AGENT, changed('src/Tasks/TaskList.cs', '.editorconfig', 'Directory.Build.props'));
  assert.equal(result.passed, false);
  assert.deepEqual(result.lines.slice(0, 2), [
    '::error file=.editorconfig::.editorconfig is a guardrail file.',
    '::error file=Directory.Build.props::Directory.Build.props is a guardrail file.',
  ]);
  assert.match(result.lines.at(-1), /Revert these changes, then comment on the issue/);
});

test('an agent PR touching no guardrails passes', () => {
  assert.equal(check(AGENT, changed('src/Tasks/TaskList.cs')).passed, true);
});

test('any author not exempt is checked, not just known agent Apps', () => {
  assert.equal(check(STRANGER, changed('.github/workflows/ci.yml')).passed, false);
});

test('the exempt owner may change guardrails', () => {
  const result = check(OWNER, changed('.editorconfig'));
  assert.equal(result.passed, true);
  assert.deepEqual(result.lines, ['owner is exempt from the guardrail path check.']);
});

test('Dependabot may change guardrails', () => {
  assert.equal(check(DEPENDABOT, changed('.github/workflows/ci.yml', 'Directory.Packages.props')).passed, true);
});

test('a user account with Dependabot\'s ID but not a Bot is not exempt', () => {
  assert.equal(check({ ...DEPENDABOT, type: 'User' }, changed('.editorconfig')).passed, false);
});

test('fails closed when not every changed file was listed', () => {
  const files = changed('src/a.cs');
  const result = evaluate({ author: AGENT, files, changedFileCount: 3500, exemptUserIds: [OWNER.id] });
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /Listed 1 of the 3500 changed files/);
});

test('annotation properties escape characters that would break them', () => {
  const result = check(AGENT, changed('.github/a:b,c.yml'));
  assert.equal(result.lines[0], '::error file=.github/a%3Ab%2Cc.yml::.github/a:b,c.yml is a guardrail file.');
});

test('user IDs parse from commas or spaces', () => {
  assert.deepEqual(parseUserIds('1001, 1002 1003'), [1001, 1002, 1003]);
});

test('an empty exempt list is an error, not an empty list', () => {
  assert.throws(() => parseUserIds(' '), /EXEMPT_USER_IDS is empty/);
  assert.throws(() => parseUserIds(undefined), /EXEMPT_USER_IDS is empty/);
});

test('logins are rejected, because a login can be renamed and reused', () => {
  assert.throws(() => parseUserIds('1001,owner'), /numeric user IDs, not logins: "owner"/);
});

// A fake API that serves `files` in pages of 100, and records the URLs it was asked for.
function fakeApi(files, { status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: status === 200, status, json: async () => files.slice((page - 1) * 100, page * 100) };
  };
  return { urls, fetchImpl };
}

const manyFiles = count => Array.from({ length: count }, (_, i) => ({ filename: `src/f${i}.cs`, status: 'added' }));

test('fetches every page until a short one', async () => {
  const api = fakeApi(manyFiles(250));
  const files = await fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl });
  assert.equal(files.length, 250);
  assert.equal(api.urls.length, 3);
  assert.equal(api.urls[0], 'https://api/repos/o/r/pulls/7/files?per_page=100&page=1');
});

test('stops at the API limit of 3,000 files', async () => {
  const api = fakeApi(manyFiles(3500));
  const files = await fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl });
  assert.equal(files.length, 3000);
});

test('an API error throws rather than passing', async () => {
  const api = fakeApi([], { status: 403 });
  await assert.rejects(
    fetchChangedFiles({ apiUrl: 'https://api', repository: 'o/r', number: 7, token: 't', fetchImpl: api.fetchImpl }),
    /GitHub API returned 403/);
});

const actionsEnv = overrides => ({
  GITHUB_EVENT_NAME: 'pull_request_target',
  GITHUB_EVENT_PATH: 'event.json',
  GITHUB_API_URL: 'https://api',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_TOKEN: 't',
  EXEMPT_USER_IDS: String(OWNER.id),
  ...overrides,
});

const prEvent = (author, changedFiles) => () => ({ pull_request: { number: 7, user: author, changed_files: changedFiles } });

test('run checks the PR from the event against the API file list', async () => {
  const api = fakeApi(changed('.editorconfig'));
  const result = await run({ env: actionsEnv(), readEvent: prEvent(AGENT, 1), fetchImpl: api.fetchImpl });
  assert.equal(result.passed, false);
  assert.equal(api.urls.length, 1);
});

test('run refuses the pull_request event, where a PR could edit the check out', async () => {
  await assert.rejects(
    run({ env: actionsEnv({ GITHUB_EVENT_NAME: 'pull_request' }), readEvent: prEvent(AGENT, 1), fetchImpl: fakeApi([]).fetchImpl }),
    /must run on pull_request_target, not pull_request/);
});

test('run refuses to start without an exempt list', async () => {
  await assert.rejects(
    run({ env: actionsEnv({ EXEMPT_USER_IDS: '' }), readEvent: prEvent(AGENT, 1), fetchImpl: fakeApi([]).fetchImpl }),
    /EXEMPT_USER_IDS is empty/);
});
