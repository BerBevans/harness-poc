// Checks that build/BuildSettings.targets ran for every project in the solution. Each project it
// checks leaves a record in the report folder. A project with no record stopped the file being
// imported, or never compiled, and either way its settings weren't checked.
//
// Usage: node build-settings-report.mjs <solution> <report folder>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { annotation, runIfMain } from './lib/pull-request.mjs';

const FIX =
  "Build settings weren't checked for these projects. Something stopped the shared build-settings " +
  "targets being imported, or the project didn't compile. Don't change how the build imports files; " +
  'comment on the issue to explain what you needed.';

// Paths compared case-insensitively, with one separator style, so Windows and Linux agree.
const samePath = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();

const defaultDotnet = args => spawnSync('dotnet', args, { encoding: 'utf8' });

/** The full paths of the projects in a solution, as `dotnet sln list` gives them, which may be none. */
export function listProjects(solution, runDotnet = defaultDotnet) {
  const result = runDotnet(['sln', solution, 'list']);
  if (result.status !== 0) throw new Error(`dotnet sln list failed: ${result.stderr || result.stdout}`);
  const projects = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /\.\w+proj$/i.test(line));
  return projects.map(project => path.resolve(path.dirname(solution), project));
}

/** The full paths of the projects in a solution. Throws if there are none. */
export function solutionProjects(solution, runDotnet = defaultDotnet) {
  const projects = listProjects(solution, runDotnet);
  if (projects.length === 0) throw new Error(`${solution} lists no projects.`);
  return projects;
}

/**
 * The records in the report folder: each project's path, whether it's a test project, its assembly
 * name and the full paths of the projects it references. The first line of a record is the path;
 * the rest are name=value pairs, and references are separated by `|`.
 */
export function readRecords(reportDir) {
  if (!fs.existsSync(reportDir)) return [];
  return fs.readdirSync(reportDir)
    .filter(name => name.endsWith('.txt'))
    .map(name => {
      const [projectPath, ...pairs] = fs.readFileSync(path.join(reportDir, name), 'utf8').split(/\r?\n/).filter(Boolean);
      // Split at the first = only, since a path may hold one.
      const values = Object.fromEntries(pairs.map(pair => /^([^=]*)=(.*)$/.exec(pair)?.slice(1) ?? [pair, '']));
      return {
        path: projectPath.trim(),
        isTestProject: (values.IsTestProject ?? '').toLowerCase() === 'true',
        assemblyName: values.AssemblyName ?? '',
        references: (values.ProjectReferences ?? '').split('|').map(reference => reference.trim()).filter(Boolean),
      };
    });
}

/** The project paths recorded in the report folder. */
export const recordedProjects = reportDir => readRecords(reportDir).map(record => record.path);

/** Decides the check. Returns { passed, lines }. */
export function evaluate({ projects, recorded }) {
  const checked = new Set(recorded.map(samePath));
  const missing = projects.filter(project => !checked.has(samePath(project)));
  if (missing.length === 0) return { passed: true, lines: [`Build settings checked for all ${projects.length} projects.`] };
  return {
    passed: false,
    lines: [...missing.map(project => annotation(path.relative(process.cwd(), project), 'No build-settings record.')), FIX],
  };
}

await runIfMain(import.meta.url, () => {
  const [solution, reportDir] = process.argv.slice(2);
  if (!solution || !reportDir) throw new Error('Usage: build-settings-report.mjs <solution> <report folder>');
  return evaluate({ projects: solutionProjects(solution), recorded: recordedProjects(reportDir) });
});
