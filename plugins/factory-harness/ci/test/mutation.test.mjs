import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluate, selectRuns, tally, untestableResult } from '../mutation.mjs';

const root = path.resolve('/r');
const project = (folder, name, { isTestProject = false, references = [] } = {}) => ({
  path: path.join(root, folder, name, `${name}.csproj`),
  isTestProject,
  assemblyName: name,
  references: references.map(reference => path.join(root, reference)),
});

const app = project('src', 'App');
const domain = project('src', 'App.Domain');
const adapters = project('src', 'App.Adapters');
const unitTests = project('tests', 'App.UnitTests', { isTestProject: true, references: ['src/App/App.csproj', 'src/App.Domain/App.Domain.csproj'] });
const domainTests = project('tests', 'App.Domain.UnitTests', { isTestProject: true, references: ['src/App.Domain/App.Domain.csproj'] });
const integrationTests = project('tests', 'App.IntegrationTests', { isTestProject: true, references: ['src/App.Adapters/App.Adapters.csproj'] });
const records = [app, domain, adapters, unitTests, domainTests, integrationTests];

const changed = (...filenames) => filenames.map(filename => {
  const [name, status = 'modified'] = filename.split(':');
  return { filename: name, status };
});
const select = (...filenames) => selectRuns({ records, changedFiles: changed(...filenames), repoRoot: root })
  .map(run => ({ project: run.project.assemblyName, files: run.files, tests: run.testProjects.map(t => t.assemblyName) }));

test('a changed core file is mutated whole, with the unit test projects that reference its project', () => {
  assert.deepEqual(select('src/App.Domain/Order.cs', 'src/App.Domain/Rules/Price.cs'), [
    { project: 'App.Domain', files: ['src/App.Domain/Order.cs', 'src/App.Domain/Rules/Price.cs'], tests: ['App.UnitTests', 'App.Domain.UnitTests'] },
  ]);
});

test('a changed unit test file mutates every core project its project references', () => {
  assert.deepEqual(select('tests/App.UnitTests/OrderTests.cs', 'src/App/Program.cs'), [
    { project: 'App', files: null, tests: ['App.UnitTests'] },
    { project: 'App.Domain', files: null, tests: ['App.UnitTests', 'App.Domain.UnitTests'] },
  ]);
});

test('a deleted unit test counts as a test change, but a deleted core file has nothing to mutate', () => {
  assert.deepEqual(select('tests/App.Domain.UnitTests/PriceTests.cs:removed', 'src/App/Old.cs:removed'), [
    { project: 'App.Domain', files: null, tests: ['App.UnitTests', 'App.Domain.UnitTests'] },
  ]);
});

test('adapters, integration tests, non-C# files and files outside any project are left alone', () => {
  assert.deepEqual(select('src/App.Adapters/Store.cs', 'tests/App.IntegrationTests/StoreTests.cs', 'src/App/App.csproj',
    'src/App/appsettings.json', 'docs/notes.cs', 'build/Tool.cs'), []);
});

test('a project in a folder nested inside another belongs to the nearer project', () => {
  const nested = { ...project('src/App', 'Inner'), path: path.join(root, 'src/App/Inner/Inner.csproj') };
  const runs = selectRuns({ records: [...records, nested], changedFiles: changed('src/App/Inner/Thing.cs'), repoRoot: root });
  assert.deepEqual(runs.map(run => run.project.assemblyName), ['Inner']);
});

test('a core project no unit test project references directly fails, since Stryker cannot mutate it', () => {
  const runs = selectRuns({ records: [app, domain, unitTests].map(r => r === unitTests ? { ...r, references: [app.path] } : r),
    changedFiles: changed('src/App.Domain/Order.cs'), repoRoot: root });
  const result = untestableResult(runs, root);
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /src\/App\.Domain\/App\.Domain\.csproj::App\.Domain can't be mutation tested/);
  assert.match(result.lines.at(-1), /Add a ProjectReference/);
  assert.equal(untestableResult(selectRuns({ records, changedFiles: changed('src/App.Domain/Order.cs'), repoRoot: root }), root), null);
});

const mutant = (status, line = 3, extra = {}) => ({ status, mutatorName: 'Equality mutation', replacement: 'total >= 100', location: { start: { line } }, ...extra });
const report = mutants => ({ projectRoot: path.join(root, 'src/App.Domain'), files: { [path.join(root, 'src/App.Domain/Price.cs')]: { mutants } } });

test('killed and timed-out mutants are caught; survivors and uncovered ones are missed; errors and ignored ones do not count', () => {
  const total = tally([report([mutant('Killed'), mutant('Timeout'), mutant('Survived', 5), mutant('NoCoverage', 9),
    mutant('CompileError'), mutant('RuntimeError'), mutant('Ignored')])], root);
  assert.equal(total.detected, 2);
  assert.equal(total.undetected, 2);
  assert.deepEqual(total.missed.map(m => [m.file, m.line, m.status]), [['src/App.Domain/Price.cs', 5, 'Survived'], ['src/App.Domain/Price.cs', 9, 'NoCoverage']]);
});

test('an unknown mutant status is an error, not a guess', () => {
  assert.throws(() => tally([report([mutant('Pending')])], root), /status "Pending"/);
});

test('totals add up across several reports', () => {
  const total = tally([report([mutant('Killed')]), report([mutant('Killed'), mutant('Survived')])], root);
  assert.deepEqual([total.detected, total.undetected], [2, 1]);
});

test('passes at the threshold, with the score', () => {
  const result = evaluate({ detected: 3, undetected: 1, missed: [] });
  assert.deepEqual(result, { passed: true, lines: ['Mutation score 75.00% (3 of 4 mutants caught); the threshold is 75%.'] });
});

test('fails below the threshold, annotating each missed mutant', () => {
  const total = tally([report([mutant('Killed'), mutant('Survived', 5), mutant('NoCoverage', 9, { replacement: undefined })])], root);
  const result = evaluate(total);
  assert.equal(result.passed, false);
  assert.equal(result.lines[0], '::error file=src/App.Domain/Price.cs,line=5::Survived: Equality mutation, changing it to `total >= 100`. Every unit test still passed.');
  assert.equal(result.lines[1], '::error file=src/App.Domain/Price.cs,line=9::Not covered: no unit test runs this code (Equality mutation).');
  assert.equal(result.lines[2], '::error::Mutation score 33.33% (1 of 3 mutants caught); the threshold is 75%.');
  assert.match(result.lines[3], /Don't apply mutation-override yourself/);
});

test('no mutants passes, since there is nothing to score', () => {
  assert.equal(evaluate({ detected: 0, undetected: 0, missed: [] }).passed, true);
});
