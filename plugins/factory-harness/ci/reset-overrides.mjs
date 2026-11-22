// Removes every override label from a PR when someone pushes to it. A label approves the diff it was
// applied to; after a push the diff is different, so the owner reviews it and applies the label
// again. The checks don't rely on this: a label counts only with the owner's approval of the commit
// the check ran on (lib/override-label.mjs), so a check that runs before this one can't pass on a
// stale label.
//
// Usage: node reset-overrides.mjs
// Environment: GITHUB_EVENT_NAME (pull_request_target), GITHUB_EVENT_PATH, GITHUB_API_URL,
// GITHUB_REPOSITORY, GITHUB_TOKEN (pull-requests write).

import { readFileSync } from 'node:fs';
import { runIfMain } from './lib/pull-request.mjs';

export const OVERRIDE_LABELS = ['size-override', 'coverage-override', 'mutation-override'];

/** The override labels on the PR now, in the casing GitHub holds them. */
export const staleOverrides = labels =>
  (labels ?? []).map(label => label.name).filter(name => OVERRIDE_LABELS.includes(name.toLowerCase()));

/** Resolves to { passed, lines }. Only a push (synchronize) removes anything. */
export async function run({ env, readEvent = path => JSON.parse(readFileSync(path, 'utf8')), fetchImpl = fetch }) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    throw new Error(`reset-overrides must run on pull_request_target, not ${env.GITHUB_EVENT_NAME}: on pull_request its token can't remove labels.`);
  }
  const event = readEvent(env.GITHUB_EVENT_PATH);
  if (event.action !== 'synchronize') return { passed: true, lines: ['Not a push, so the override labels stay.'] };
  const names = staleOverrides(event.pull_request.labels);
  for (const name of names) {
    const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/issues/${event.pull_request.number}/labels/${encodeURIComponent(name)}`;
    const response = await fetchImpl(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    // 404: someone removed it already, which is what this step wants.
    if (!response.ok && response.status !== 404) throw new Error(`GitHub API returned ${response.status} removing ${name}.`);
  }
  return {
    passed: true,
    lines: [names.length ? `Removed ${names.join(', ')} after the push. Review the new diff before applying them again.` : 'No override labels to remove.'],
  };
}

await runIfMain(import.meta.url, env => run({ env }));
