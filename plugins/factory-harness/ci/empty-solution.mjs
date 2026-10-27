// Lets a new product repo store its first coverage baseline. Every check fails a solution with no
// projects, so main could never pass a build, and the first PR would have no baseline to compare
// with. On a push or a run by hand, a solution with no projects instead passes and stores an empty
// figure. The comparison then treats each of the PR's figures as new, and the measurement still
// fails any project that no test of the right kind loads.
//
// A PR with no projects still fails, because this refuses every event but push and a run by hand.
// Only a merged PR can push to main, and a PR that empties the solution fails its build.
//
// Usage: node empty-solution.mjs <solution> <figure file>
// Writes empty=true or empty=false to GITHUB_OUTPUT, and the empty figure when it's true.

import fs from 'node:fs';
import { listProjects } from './build-settings-report.mjs';
import { runIfMain } from './lib/pull-request.mjs';

const ALLOWED_EVENTS = ['push', 'workflow_dispatch'];

/** The figure a solution with no projects stores: no figure for either group. */
export const emptyFigure = commit => ({ core: null, adapters: null, commit });

/** Decides whether the build can be skipped. Returns { empty, lines }. */
export function decide({ eventName, projects }) {
  if (!ALLOWED_EVENTS.includes(eventName)) {
    throw new Error(`An empty solution is only allowed on push or a run by hand, not on ${eventName}.`);
  }
  if (projects.length > 0) return { empty: false, lines: [`The solution has ${projects.length} projects, so the build runs.`] };
  return {
    empty: true,
    lines: ['The solution has no projects yet, so the build and tests are skipped and an empty coverage figure is stored.'],
  };
}

await runIfMain(import.meta.url, env => {
  const [solution, figureFile] = process.argv.slice(2);
  if (!solution || !figureFile) throw new Error('Usage: empty-solution.mjs <solution> <figure file>');
  const { empty, lines } = decide({ eventName: env.GITHUB_EVENT_NAME, projects: listProjects(solution) });
  if (empty) fs.writeFileSync(figureFile, JSON.stringify(emptyFigure(env.GITHUB_SHA), null, 2));
  fs.appendFileSync(env.GITHUB_OUTPUT, `empty=${empty}\n`);
  return { passed: true, lines };
});
