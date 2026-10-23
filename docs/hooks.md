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
- **suppressions:** new suppressions in C# and new weakening properties in project files. Added text is compared with removed text, so moving existing code is allowed. Generated code is exempt. The rule lists are exported for CI's suppression scan.
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
| Scripts written in one step and run in the next | Write `fix.sh` that edits `Directory.Build.props`, then run it | CI path check; build-settings target |
| Other languages writing files | `python -c "open('.editorconfig','w')"` | CI path check |
| Encoded content | A suppression written via base64 | CI diff scan; skipped-test check on test results |
| Patches | `git apply` of a patch touching a guardrail | CI path check |
| Commits made outside Bash and PowerShell | A script that commits | Build fails on IDE0055 |
| Printing secrets from the environment | `printenv` | No secrets in public repos; GitHub push protection |
| Deleting tests | Removing a test method in a refactor | Coverage ratchet in CI; the reviewer agent checks deleted tests |

## CI checks for product repos

Product repos call these checks from one workflow triggered by `pull_request_target`. The `labeled` and `unlabeled` types re-run the size check when its override label changes:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  pull-requests: read
  issues: read
jobs:
  guardrail-paths:
    name: Guardrail paths
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/harness-poc/actions/guardrail-paths@v0.1.0
        with:
          exempt-user-ids: <your user ID>
  suppression-scan:
    name: Suppression scan
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/harness-poc/actions/suppression-scan@v0.1.0
        with:
          exempt-user-ids: <your user ID>
  pr-size:
    name: PR size
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/harness-poc/actions/pr-size@v0.1.0
        with:
          exempt-user-ids: <your user ID>
          override-user-ids: <your user ID>
```

- **The guardrail path check** fails any PR that adds, changes, deletes or renames a guardrail file, unless the author is exempt. It uses the same `isGuardrailPath` as the hook rule.
- **The suppression scan** fails a PR that adds more of any suppression than it removes, counted across the whole PR, or that sets a build property in a project file. It fails closed if GitHub leaves out the diff for a C# or project file that gained lines.
- **The PR size check** fails a PR that changes more than 300 lines, added plus removed, and warns above 250. Blank lines don't count, and within each hunk a removed and an added line that match once whitespace is stripped cancel out, so reindenting is free. It leaves out `packages.lock.json` and EF Core's `Migrations/*.Designer.cs` and `*ModelSnapshot.cs`, and counts everything else. It fails closed if GitHub leaves out the diff for a text file. The `size-override` label lets an oversized PR pass, but only when someone in `override-user-ids` applied it.
- **All three must run on `pull_request_target`.** On `pull_request` the workflow comes from the PR branch, so a PR could remove a check from its own run. Each action refuses any other event.
- **Exempt user IDs, not logins,** because a login can be renamed and then taken. Find an ID with `gh api users/<login> --jq .id`. Dependabot is always exempt.
- **Make `Guardrail paths`, `Suppression scan`, `PR size` and `Build` required checks** in the repo's ruleset.
- **Copy `templates/CODEOWNERS.example` to `.github/CODEOWNERS`** and replace `@harness-owner`. Then add a second ruleset on the default branch: require a pull request with review from code owners, and add the owner as a bypass actor for pull requests only. Keep it separate from the status-check ruleset, which has no bypass.

The guardrail path check and the suppression scan are tested against the GitHub API with real PRs; the PR size check only against a fake API so far. None is tested yet as a required check in a product repo.

The build-settings and test-results checks run in the product repo's build workflow. That workflow is triggered by `pull_request`, because building runs the PR's code:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-dotnet@v6
        with:
          global-json-file: global.json
      - uses: <owner>/harness-poc/actions/build-and-test@v0.1.0
        with:
          solution: <solution>.slnx
          override-user-ids: <your user ID>
```

- **It imports `build/BuildSettings.targets` last,** so the build fails for any project whose settings are weaker than the decisions doc requires, wherever the change was made. It then fails if any project in the solution has no record from the target, which catches a project that blocks the import.
- **It then runs every test project, one at a time,** and fails unless every test passed. One `dotnet test` over the whole solution would merge every project's coverage into a single report, so the figures below couldn't be told apart. A skipped, inconclusive or timed-out test fails, as does a test project that ran no tests. A test project must be named `*.UnitTests`, `*.ArchitectureTests`, `*.IntegrationTests` or `*.UiTests`, and a project named that way must be a test project.
- **It then measures line and branch coverage as two figures,** with the coverage collector the test SDK includes: core code from `*.UnitTests` only, and `*.Adapters` projects from `*.IntegrationTests` only. Architecture and UI tests count towards neither. It fails if a core project has no unit-test coverage at all, or an adapter project no integration-test coverage: a project no test of the right kind loads is missing from the reports, not counted as 0%.
- **A push run stores the figure** as the `coverage-baseline` artifact, kept for 90 days. A PR run fails if either figure's line or branch coverage is more than 0.1 percentage points below the latest successful push run on its target branch. The first adapter project has no figure to compare with, so it passes on the rule that an integration test loads it. A figure stored before the split is refused; rerun the workflow on the target branch. If there's no figure, or it has expired, the PR fails. Run the workflow by hand on that branch to store a new one.
- **A coverage drop passes with the `coverage-override` label,** but only if someone in `override-user-ids` added it. The check reads who last added the label from the PR's issue events when it runs, so an agent re-adding a label you removed doesn't count. The build reruns whenever a label is added or removed. Don't add a job-level `if:` to skip label events: GitHub treats a skipped job as passing a required check, so any label would turn a failing build green.
- **Branches are counted per line, from whichever test project of the right kind covered most of them,** because the report gives counts, not which branches were taken. That understates coverage slightly, but equally for the PR and the target branch.
- **Code can't be quietly left out of coverage.** The hook and the diff scan reject the three attributes the collector skips (`[ExcludeFromCodeCoverage]`, `[DebuggerNonUserCode]` and `[DebuggerHidden]`), the target fails a project that sets `RunSettingsFilePath` or `VSTestSetting`, and `.runsettings` files are guardrails.
- **It must not run on `pull_request_target`,** which would run the PR's code with the repo's secrets. It's safe on `pull_request` because the guardrail path check fails any PR that changes the workflow. The action refuses `pull_request_target`.
- **Every step runs after the PR's code,** so a PR that sets out to fake its results can do so. It can block the build-settings import and write a fake record, have a test rewrite the TRX or coverage files, or set run settings only when `dotnet test --no-build` runs, so the build-time check doesn't see them. Each needs code that review sees.

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

The harness repo itself doesn't enable the plugin, because the plugin would block the guardrail work done here. The harness is protected by its rulesets and required checks instead. It has no CODEOWNERS file, because I open its PRs and can't approve my own.

This works for interactive sessions once the folder is trusted. It does not work in CI; see the next section.

## Running headless in CI

A `claude -p` run never shows the trust dialog, and it ignores `extraKnownMarketplaces` from the repository. The project install above therefore doesn't load the plugin in CI, and nothing reports that it's missing. CI loads the plugin from a pinned checkout of the harness instead:

```yaml
- uses: actions/checkout@v7
  with:
    repository: <owner>/harness-poc
    ref: v0.1.0
    path: .harness

- run: >
    claude -p "$PROMPT"
    --plugin-dir "$GITHUB_WORKSPACE/.harness/plugins/factory-harness"
    --output-format stream-json --verbose
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

- **Check that the plugin loaded.** The first event in the stream, `system/init`, lists the loaded plugins. The workflow stops the run and fails the job if `factory-harness` isn't in `plugins`, or if `plugin_errors` isn't empty.
- **Don't pass `--bare`.** Bare mode still loads `--plugin-dir`, but it doesn't read `CLAUDE_CODE_OAUTH_TOKEN`. It would need an API key, which is billed separately from the subscription.
- **The token** comes from `claude setup-token`, lasts a year and is stored as the `CLAUDE_CODE_OAUTH_TOKEN` repository secret. CI usage counts against the same subscription allowance as interactive sessions.

Tested with Claude Code 2.1.303: the project install didn't load the plugin, `--plugin-dir` did, and a headless attempt to edit `.editorconfig` was blocked by the guard hook.
