import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, fakeContext, powershell } from './helpers.mjs';
import { evaluate } from '../guard.mjs';

decisionTable({
  blocked: [
    ['push --force', bash('git push --force origin feature/42')],
    ['push -f', bash('git push -f')],
    ['push -fu cluster', bash('git push -fu origin feature/42')],
    ['push --force-with-lease', bash('git push --force-with-lease origin feature/42')],
    ['push + refspec', bash('git push origin +feature/42')],
    ['push to main', bash('git push origin main')],
    ['push HEAD:main', bash('git push origin HEAD:main')],
    ['push to refs/heads/master', bash('git push origin feature:refs/heads/master')],
    ['push --all', bash('git push --all origin')],
    ['push --mirror', bash('git push --mirror')],
    ['push --delete', bash('git push origin --delete feature/42')],
    ['push empty-source refspec', bash('git push origin :feature/42')],
    ['push after global options', bash('git -C ../app push -f')],
    ['reset --hard', bash('git reset --hard HEAD~1')],
    ['clean -fd', bash('git clean -fd')],
    ['clean -xdf', bash('git clean -xdf')],
    ['checkout .', bash('git checkout .')],
    ['checkout -- .', bash('git checkout -- .')],
    ['restore .', bash('git restore .')],
    ['restore --staged --worktree .', bash('git restore --staged --worktree .')],
    ['branch -D', bash('git branch -D feature/41')],
    ['filter-branch', bash('git filter-branch --tree-filter "rm secrets" HEAD')],
    ['chained after add', bash('git add . && git push origin main')],
    ['PowerShell push to main', powershell('git push origin main; Write-Host done')],
    ['gh pr merge', bash('gh pr merge 42 --squash')],
  ],
  allowed: [
    ['push a feature branch', bash('git push -u origin feature/42-add-task')],
    ['bare push from a feature branch', bash('git push')],
    ['reset --soft', bash('git reset --soft HEAD~1')],
    ['clean dry run', bash('git clean -n')],
    ['checkout a branch', bash('git checkout main')],
    ['checkout one file', bash('git checkout -- src/Tasks/TaskService.cs')],
    ['restore --staged .', bash('git restore --staged .')],
    ['branch -d', bash('git branch -d feature/41')],
    ['gh pr create', bash('gh pr create --fill')],
    ['commit mentioning a force push', bash('git commit -m "Explain why we never push --force"')],
  ],
});

test('a bare push while on main is blocked', () => {
  assert.ok(evaluate(bash('git push'), fakeContext({ branch: 'main' })));
});

test('pushing HEAD while on main is blocked', () => {
  assert.ok(evaluate(bash('git push origin HEAD'), fakeContext({ branch: 'main' })));
});
