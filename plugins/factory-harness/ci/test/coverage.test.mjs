import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { figure, measure, parseCobertura, rate, unmeasuredResult } from '../coverage.mjs';

// A Cobertura report shaped like the one the Microsoft collector writes, with each line listed
// under its method and again under its class.
function cobertura(packages) {
  const line = ([number, hits, branches]) => branches
    ? `<line number="${number}" hits="${hits}" branch="True" condition-coverage="50% (${branches})"><conditions><condition number="0" type="jump" coverage="50%" /></conditions></line>`
    : `<line number="${number}" hits="${hits}" branch="False" />`;
  const classes = files => Object.entries(files).map(([file, lines]) =>
    `<class name="C" filename="${file}"><methods><method name="M"><lines>${lines.map(line).join('')}</lines></method></methods>` +
    `<lines>${lines.map(line).join('')}</lines></class>`).join('');
  return `<?xml version="1.0"?><coverage line-rate="1"><packages>${Object.entries(packages).map(([name, files]) =>
    `<package name="${name}"><classes>${classes(files)}</classes></package>`).join('')}</packages></coverage>`;
}

const fig = (lines, branches = [0, 0]) =>
  ({ lines: { covered: lines[0], valid: lines[1] }, branches: { covered: branches[0], valid: branches[1] } });

test('parses each class line once, with its branches, from the named assemblies only', () => {
  const xml = cobertura({
    App: { '/r/src/App/A.cs': [[5, 1], [7, 1, '2/4'], [8, 0]] },
    'App.UnitTests': { '/r/tests/ATests.cs': [[3, 1]] },
  });
  assert.deepEqual(parseCobertura(xml, new Set(['app'])), [
    { file: '/r/src/App/A.cs', line: 5, hits: 1, branchesCovered: 0, branches: 0 },
    { file: '/r/src/App/A.cs', line: 7, hits: 1, branchesCovered: 2, branches: 4 },
    { file: '/r/src/App/A.cs', line: 8, hits: 0, branchesCovered: 0, branches: 0 },
  ]);
});

test('a line any test project covered counts as covered', () => {
  const assemblies = new Set(['app']);
  const first = parseCobertura(cobertura({ App: { 'A.cs': [[1, 1], [2, 0, '1/2']] } }), assemblies);
  const second = parseCobertura(cobertura({ App: { 'A.cs': [[1, 0], [2, 3, '2/2']] } }), assemblies);
  assert.deepEqual(figure([...first, ...second]), fig([2, 2], [2, 2]));
});

const record = (name, isTestProject = false) =>
  ({ path: path.resolve(`/r/src/${name}/${name}.csproj`), isTestProject, assemblyName: name });

test('measures the product projects across every report, and names any no report covers', t => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  t.after(() => fs.rmSync(results, { recursive: true, force: true }));
  fs.mkdirSync(path.join(results, 'a'));
  fs.writeFileSync(path.join(results, 'a', 'x.cobertura.xml'), cobertura({ App: { 'A.cs': [[1, 1], [2, 0]] }, 'App.UnitTests': { 'T.cs': [[1, 1]] } }));
  fs.writeFileSync(path.join(results, 'y.cobertura.xml'), cobertura({ App: { 'A.cs': [[2, 1]] }, 'App.ArchitectureTests': { 'T.cs': [[1, 1]] } }));
  const records = [record('App'), record('App.UnitTests', true), record('App.ArchitectureTests', true), record('Orphan')];

  const { figure: result, unmeasured } = measure({ records, results });
  assert.deepEqual(result, fig([2, 2]));
  assert.deepEqual(unmeasured.map(r => r.assemblyName), ['Orphan']);

  const failed = unmeasuredResult(unmeasured);
  assert.equal(failed.passed, false);
  assert.match(failed.lines[0], /Orphan\.csproj::Orphan has no coverage: no test loads it\./);
  assert.match(failed.lines.at(-1), /an architecture test that loads it is enough/);
  assert.equal(unmeasuredResult([]), null);
});

test('no coverage reports is an error, not a pass', () => {
  assert.throws(() => measure({ records: [record('App')], results: '/no/such/folder' }), /No coverage reports/);
});

test('code with no branches is fully branch-covered', () => {
  assert.equal(rate({ covered: 0, valid: 0 }), 100);
});
