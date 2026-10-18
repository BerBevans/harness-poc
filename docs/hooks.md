# Harness hooks

The `factory-harness` plugin's hooks give agents fast feedback when they reach for something the factory doesn't allow. They are not the enforcement. Every rule has a server-side backstop in CI, branch protection or CODEOWNERS, as the decisions doc requires.

## What runs, and when

| Hook | Event | If the hook itself fails |
| --- | --- | --- |
| `guard.mjs` | PreToolUse on Bash, PowerShell, Read, Edit, Write, NotebookEdit, Grep and Glob | Blocks (fails closed, and `onFailure: block` covers a missing `node`) |
| `format-on-commit.mjs` | PreToolUse on Bash and PowerShell; acts only on `git commit` | Allows; the build's IDE0055 and code-style rules are the gate |
| `verify-before-stop.mjs` | Stop | Allows; CI catches a red build, and blocking could trap the session |

The guard runs five rules in order and denies on the first match:

- **claude-config:** writes under `~/.claude` (except session data in `projects/`, `plans/` and `todos/`) or to `~/.claude.json`, any mention of `disableAllHooks`, and `claude plugin|config|mcp`. Claude Code applies settings changes mid-session, so this protects the hooks themselves.
- **guardrail-files:** changes to the guardrail files listed in the decisions doc, by file tool or by a shell command that writes to them, plus `dotnet new` templates that create them, `dotnet add package` and `dotnet tool install`.
- **secrets:** any access, reads included, to `.env` files, keys and certificates, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gh`, .NET user secrets and git credentials, plus `gh auth token` and `dotnet user-secrets`.
- **suppressions:** new suppressions in C# and new weakening properties in project files. Added text is compared with removed text, so moving existing code is allowed. Generated code is exempt. `findNewSuppressions` is exported for CI's diff scan.
- **destructive-git:** force pushes, pushes to `main` or `master`, deleting remote branches, `reset --hard`, `clean -f`, `checkout .`, `restore .`, `branch -D`, history rewriting and `gh pr merge`.

Every denial ends with what to do instead. With `FACTORY_ISSUE` set by the workflow, that is: comment on the issue and write `.factory/progress.md`. Without it: stop and explain to the user.

## The Stop hook

1. Allow if `stop_hook_active` is set, so it never refuses twice in a row.
2. Allow if there is no solution at the repo root.
3. Allow without building if the working tree matches the last green run. The fingerprint covers `HEAD`, the uncommitted diff and untracked files, and is stored under `${CLAUDE_PLUGIN_DATA}`.
4. Build with warnings as errors, then run the `*.UnitTests` and `*.ArchitectureTests` projects.
5. On success, record the fingerprint and allow (with a warning to the user if there were no test projects).
6. On failure with a valid progress note: ask for a commit if work is uncommitted, otherwise allow.
7. Otherwise block, with only compiler errors and failing tests' names and messages, capped at 4,000 characters and with repo paths made relative.

## Known limits and their backstops

The guard matches text. It can't see what a command will do, only how it's spelt.

| Gets past the hook | Example | Backstop |
| --- | --- | --- |
| Commands assembled at runtime | `f=.editor; f=${f}config; echo x > $f` | CI path check on guardrail files |
| Scripts written in one step and run in the next | Write `fix.sh` that edits `Directory.Build.props`, then run it | CI path check; build-settings target in `Directory.Build.targets` |
| Other languages writing files | `python -c "open('.editorconfig','w')"` | CI path check |
| Encoded content | A suppression written via base64 | CI diff scan; skipped-test check on test results |
| Patches | `git apply` of a patch touching a guardrail | CI path check |
| Commits made outside Bash and PowerShell | A script that commits | Build fails on IDE0055 |
| Printing secrets from the environment | `printenv` | No secrets in public repos; GitHub push protection |
| Deleting tests | Removing a test method in a refactor | Open question in the decisions doc |

## Running the tests

From `plugins/factory-harness/hooks`:

```sh
node --test "test/*.test.mjs"               # rules, wording, process behaviour: seconds
node --test "test/integration/*.test.mjs"   # Stop and format hooks against samples/consumer: needs git and .NET
```

The integration tests copy `samples/consumer` into `.test-work/` and break it in specific ways. They don't use `%TEMP%`. On Windows with Smart App Control enforcing, freshly built test DLLs are blocked wherever they are, so the two tests that run unit tests fail locally on this machine and pass in CI on Linux.

## Using the plugin in a product repo

Register the harness marketplace at a pinned tag and enable the plugin, then commit the `.claude/settings.json` it writes:

```sh
claude plugin marketplace add <owner>/harness-poc#v0.1.0 --scope project
claude plugin install factory-harness@factory-harness --scope project
```

The harness repo itself doesn't enable the plugin, because the plugin would block the guardrail work done here. The harness is protected by branch protection, CODEOWNERS and review instead.
