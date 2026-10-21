import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, guardrailPathsTouched, run } from '../guardrail-paths.mjs';
import { changed, fakeApi } from './helpers.mjs';

const OWNER = { login: 'owner', id: 1001, type: 'User' };
const AGENT = { login: 'factory-implementer[bot]', id: 2002, type: 'Bot' };
const DEPENDABOT = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };
const STRANGER = { login: 'someone', id: 3003, type: 'User' };

const check = (author, files) => evaluate({ author, files, changedFileCount: files.length, exemptUserIds: [OWNER.id] });

test('every guardrail path the decisions doc lists is caught', () => {
  const guardrails = [
    '.editorconfig', 'src/Tasks/.editorconfig', 'src/relaxed.globalconfig',
    'Directory.Build.props', 'src/Directory.Build.targets', 'Directory.Packages.props',
    'NuGet.Config', 'global.json', '.config/dotnet-tools.json', 'stryker-config.json',
    'tests/coverage.runsettings', '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/settings.json',
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
