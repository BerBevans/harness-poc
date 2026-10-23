import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, readRecords, solutionProjects } from '../build-settings-report.mjs';

const projects = [path.resolve('/repo/src/App/App.csproj'), path.resolve('/repo/tests/App.UnitTests/App.UnitTests.csproj')];

test('passes when every project is recorded', () => {
  assert.deepEqual(evaluate({ projects, recorded: projects }), { passed: true, lines: ['Build settings checked for all 2 projects.'] });
});

test('fails naming each project with no record', () => {
  const result = evaluate({ projects, recorded: [projects[0]] });
  assert.equal(result.passed, false);
  assert.match(result.lines[0], /App\.UnitTests\.csproj::No build-settings record\./);
  assert.match(result.lines.at(-1), /Don't change how the build imports files/);
});

test('matches paths whatever their case', () => {
  assert.equal(evaluate({ projects, recorded: projects.map(p => p.toUpperCase()) }).passed, true);
});

test('reads project paths from dotnet sln list, relative to the solution', () => {
  const runDotnet = () => ({ status: 0, stdout: 'Project(s)\n----------\nsrc/App/App.csproj\ntests/App.UnitTests/App.UnitTests.csproj\n' });
  assert.deepEqual(solutionProjects('/repo/App.slnx', runDotnet), projects);
});

test('a solution with no projects is an error, not a pass', () => {
  const runDotnet = () => ({ status: 0, stdout: 'No projects found in the solution.\n' });
  assert.throws(() => solutionProjects('/repo/App.slnx', runDotnet), /lists no projects/);
});

test('a failing dotnet sln list is an error', () => {
  const runDotnet = () => ({ status: 1, stdout: '', stderr: 'Could not find solution' });
  assert.throws(() => solutionProjects('/repo/App.slnx', runDotnet), /dotnet sln list failed: Could not find solution/);
});

test('reads each record, with its project references', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '1.txt'),
    '/r/tests/App.UnitTests/App.UnitTests.csproj\nIsTestProject=true\nAssemblyName=App.UnitTests\n' +
    'ProjectReferences=/r/src/App/App.csproj|/r/src/a=b/Lib.csproj\n');
  fs.writeFileSync(path.join(dir, '2.txt'), '/r/src/App/App.csproj\nIsTestProject=\nAssemblyName=App\nProjectReferences=\n');
  assert.deepEqual(readRecords(dir).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: '/r/src/App/App.csproj', isTestProject: false, assemblyName: 'App', references: [] },
    { path: '/r/tests/App.UnitTests/App.UnitTests.csproj', isTestProject: true, assemblyName: 'App.UnitTests',
      references: ['/r/src/App/App.csproj', '/r/src/a=b/Lib.csproj'] },
  ]);
});
