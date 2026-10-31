# Software factory side project: decisions

Oct 16, 2026 · @Ben Evans

## Purpose

Learn to build a working, reliable software factory on a personal side project, then bring the approach to work as a central harness with per-repo rules. The side project runs outside work's security and compliance process, so nothing from work goes into it.

## Projects and sequence

Three projects, each used for real so usability bugs surface through use rather than only through tests.

| Order | Project | Stack | What it proves |
| --- | --- | --- | --- |
| 1 | To-do app | .NET with a server-rendered UI (Razor Pages, optionally htmx) | The core factory loop works on one stack, with daily real-world use |
| 2 | Slack triage bot: a new, centrally hosted version for multiple users in one workspace | .NET | The harness is not coupled to project 1 |
| 3 | React frontend | React with TypeScript in strict mode | Which harness parts are language-neutral and which are per-language |

The existing single-user bot acts as a test oracle for project 2: its behaviour feeds holdout scenarios, but its code stays out of the agent's reach.

## Repositories and tooling

A harness repo and a consumer repo exist from the first commit, all public on GitHub. The free plan only enforces branch protection on public repos, and keeping the harness public avoids authentication plumbing in every consumer. Work's Bitbucket and Jira setup is deliberately not mirrored.

| Concern | Central (harness repo) | Local override (product repo) |
| --- | --- | --- |
| Code rules | NuGet package of Roslyn analysers, plus off-the-shelf analysers | `.editorconfig` severities |
| Build defaults | Shared `Directory.Build.props` | Repo-level props |
| Agent behaviour | Plugin marketplace with a harness plugin: hooks, skills, reviewer agent | `.claude/settings.json` and a short CLAUDE.md map |
| CI | Composite GitHub Actions | Inputs from the calling workflow |

Each consumer pins its harness version. The harness has its own tests, including a run against a sample consumer, and consumers upgrade deliberately rather than automatically.

**Agent identities.** Each agent role (spec, test, implementer, reviewer, security) has its own GitHub App with only the permissions its job needs. That allows code-owner review of agent PRs, keeps agent work distinguishable from mine in the metrics, and uses short-lived tokens. My own interactive sessions run under my identity. Proposed: the reviewer reports through a status check that is optional in the advise phase and required in the veto phase, and its App merges in the merge phase.

**Hosting.** The to-do app runs on a small VPS costing a few pounds a month, behind Cloudflare Tunnel and Cloudflare Access. It opens no ports and needs no agent-written authentication in the first version. All Cloudflare services use a personal account.

## Intake and specs

GitHub Issues are the factory's intake. The spec author and the implementer are separate agents, so the implementer works to a target it did not set.

1. Refine the spec in the issue with a spec agent.
2. Write acceptance criteria as Given/When/Then, and decide at spec time which scenarios are visible to the implementer and which are holdouts.
3. Apply the `ready` label as the Definition of Ready. It starts the implementer, either automatically through an Action or manually.
4. The implementer's first commit copies the spec into `docs/specs/`, so the spec and code merge in the same PR. The issue stays the conversation; the repo is the record.

## Ambiguity handling

The implementer behaves like a senior developer: it states its interpretation and assumptions for review instead of asking open-ended questions.

- **First step, before any code:** read the spec and post an issue comment with its interpretation and numbered assumptions, so replies can be as short as "1 and 3 fine, 2 wrong: should be X".
- **Blocking assumptions** change user-visible behaviour, the data model or persistence, or are hard to reverse. The implementer stops and waits.
- **Non-blocking assumptions** are everything else. The implementer proceeds and records them in the PR.
- **A stop partway through** means committing work in progress and a progress note in `.factory/progress.md`, so the resumed run doesn't start from scratch.
- **Answers** are written back into the spec, not left only in the comment thread.

Work resumes only when I re-apply the `ready` label. A reply comment alone doesn't restart it, because a clarification may take several rounds.

## Review and merge authority

Autonomy is earned in phases on measured evidence, not granted up front.

**Human code review.** I review the code at first. Every review comment becomes a rule, lint, test or doc; if it can't be encoded, the reason is recorded. I step back from code review once comments per change trend towards zero.

**Reviewer agent.** It runs with fresh context and never sees the implementer's reasoning. Its authority grows in phases:

1. **Advise:** findings only; I approve merges. (Agreed.)
2. **Veto:** a rejection sends the work back to the implementer automatically; an approval still needs me to merge, and I spot-check a sample of approved changes. (Agreed.)
3. **Merge:** it can approve and merge, starting with docs, test-only changes and dependency bumps, then widening to features. (Agreed.)

The gate between phases is measured against my review comments, not PRs, over a rolling window. Veto needs 30 comments with no significant misses; merge needs 60, which shows a miss rate of about 5% or less. Precision is tracked alongside.

**Deleted and weakened tests.** The reviewer agent's instructions require it to check every deleted test and every removed or loosened assertion, and to flag any the PR doesn't justify. Coverage catches deletions that lose coverage. The reviewer catches the rest, such as a deleted test whose code another test still covers.

**PR size.** Aim for 200 changed lines; 250 is acceptable and 300 is a hard limit. Above the limit, a PR needs an override label with a justification, for changes that are large but still easy to review. The goal is coherent, reviewable PRs, not one change chopped into pieces to pass the check.

Whitespace-only changes don't count towards the limit. The CI check accepts the override label only when I applied it, not an agent's App. The label is `size-override`. Only the generated files a .NET repo commits are left out of the count: `packages.lock.json`, and `*.Designer.cs` and `*ModelSnapshot.cs` inside a `Migrations/` folder. Everything else counts, docs included, because every excluded name is somewhere an agent could put bulk.

## Security scanning

Every public repo has GitHub's dependency scanning (Dependabot alerts and security updates) and secret scanning with push protection turned on. Both are free on public repos. Dependabot PRs go through the same checks and review phases as agent PRs.

## Package management

New packages are gated by policy and objective checks, not by the judgement of the agent that wants them.

- **The allowlist is `Directory.Packages.props`.** Central Package Management means a reference without a central version fails the build. The file is a guardrail: agents can't edit it, and must stop and comment instead.
- **Package source mapping** in `nuget.config` restricts packages to nuget.org, closing off dependency confusion. `nuget.config` is a guardrail too.
- **Lock files with locked-mode restores in CI** stop transitive dependencies changing unnoticed.
- **NuGet Audit** runs at restore and includes transitive packages; with warnings as errors, a known-vulnerable version fails the build.
- **New packages need me; version bumps don't.** A CI check compares the file: a new package ID needs the `package-approved` label, applied by me, while a version change passes if the audit is clean.

The approval flow:

1. The implementer requests the package in an issue comment, giving the reason, the alternatives considered and why the framework isn't enough.
2. A separate security agent, with its own App, fresh context and a brief to find reasons not to add it, assembles an evidence pack from scripted facts: age, downloads and release history; publisher verification and prefix ownership; source repository activity and any recent change of owner; known vulnerabilities and licence; new transitive packages; and name similarity to popular packages.
3. I decide using a short rubric based on the evidence pack.

## Product and architecture

There is no product owner or architecture agent in the pipeline. An agent role is added only when the job needs independence or a different incentive, not just a different hat, because every handoff loses context.

- **One product session per project**, before the first ticket, produces a short product document: purpose, users, scope, non-goals and the quality bar. The spec agent reads it for every ticket.
- **One architecture session per project** produces `ARCHITECTURE.md`, a few ADRs, the empty project skeleton and NetArchTest rules in a `*.ArchitectureTests` project, all in one PR I open. The rules are gates; the documents are context. Architecture tests are guardrails, so the session writes them itself: I start it with `FACTORY_ARCHITECTURE_SESSION=1`, which lets the hook allow `*.ArchitectureTests` and nothing else. A factory run never gets the exemption, and the CI path check still fails any agent PR that touches them.
- **Escalation, not an agent, per ticket.** The spec agent flags any ticket that needs an architectural decision (a new dependency direction, new persistence, a new external integration or a new deployable) as a blocking assumption for me.
- **Product and architecture docs are human-owned** through CODEOWNERS: `docs/product.md`, `ARCHITECTURE.md` and the ADRs in `docs/adr/`.
- **Both sessions are skills in the harness plugin, not agent definitions.** They're interactive and run in my own session, so they're reusable for each project and transferable to work. They start thin and are refined after the to-do app's sessions.
- **New architecture sessions** are run when the React frontend arrives and before the Slack bot's integrations. Frequent escalations would signal that a standing design-review agent has earned its place.

**Sessions create backlog issues, never `ready` ones.** The product session ends by creating feature issues labelled `needs-spec`, each with its user-facing outcome, a link to the product document, a rough order and dependencies. The architecture session adds foundation issues only for work an agent may do. The project skeleton and architecture tests arrive in the session's own PR, and CI wiring is guardrail work done through the harness. Every issue then goes through spec refinement, which usually splits it to fit the PR size target, and only I apply `ready`.

**The first `ready` issue is a walking skeleton:** the thinnest end-to-end slice, built, tested, reviewed, merged and deployed to the VPS behind Cloudflare. It tests the whole factory before any real feature depends on it.

## Verification and feedback

Deterministic checks come first, agent judgement second, real use last, and every escaped bug improves one of them.

- **Compiler as first reviewer:** nullable reference types and warnings-as-errors in C#; strict mode in TypeScript.
- **Holdout scenarios:** the implementer never sees the scenarios it's judged on. While a feature is in progress, its scenarios live in a separate private repo that only the CI job can read. The spec agent drafts them in Given/When/Then, I approve them with the spec, and a separate test agent makes them executable as black-box tests. Failure details go to me and the spec agent; the implementer only learns that a holdout failed. When the feature is deployed, a workflow moves its scenarios into the product repo's regression suite, so the private repo only holds scenarios for work in progress.
- **Live regression suite:** black-box xUnit tests in the product repo. They reach the application only over HTTP and don't reference its projects, and they run against the built application with its dependencies in Testcontainers. CI runs the suite from the commit tagged `live`, not from the PR, so a PR can't weaken the tests that judge it. Only the deploy workflow moves the tag, under a tag ruleset. Each run uses the live flag states, plus each flag the PR changes flipped on its own. The PR's own black-box tests run against the same flag sets, so flipping a flag later doesn't break them. A behaviour change that isn't behind a flag fails the live-tag tests it contradicts, and passes only with a `regression-override` label that I applied. Before the first deploy there's no `live` tag, so the check passes with a message saying so. Tests use the database only as a last resort, because assertions on the schema break on legitimate migrations. The suite's folder is not a guardrail: weakening a test at HEAD only affects what runs after the change ships, the reviewer agent flags weakened tests, and the workflow that moves shipped holdouts needs to write there.
- **Mutation testing:** Stryker.NET, to prove the tests would catch a broken implementation.
- **Architecture tests:** NetArchTest.
- **UI checks:** the agent drives the app with Playwright for .NET.
- **Entropy control:** golden principles plus a recurring clean-up agent that opens small refactoring PRs.
- **Real use:** usability bugs found while using the app are filed as issues. Each is tagged either as a missing check (a new scenario or lint) or as a wrong spec.

## Metrics

These numbers are what will make the case for each step up in autonomy, at home and later at work.

| Metric | What it shows |
| --- | --- |
| Autonomy rate | Share of tasks reaching merge without my intervention |
| Escaped defects | Holdout or oracle failures after merge |
| Cost per merged change | Tokens or usage windows spent per change |
| Rework rate | Changes reverted or fixed in a later task |
| Review comments per change | When I can step back from code review |
| Blocking stops per issue | Spec quality |
| Reviewer recall and precision | Readiness for the veto and merge phases |
| Missing check versus wrong spec | Whether the weak point is the harness or the specs |

## Observability

The factory is observed in two layers, joined by one trace per issue. This is what produces the metrics above.

| Layer | What it covers | Source |
| --- | --- | --- |
| Agent telemetry | Sessions, tokens, cost, tool calls, commits, API errors | Claude Code's native OpenTelemetry export |
| Factory telemetry | Issue labelled, spec approved, each agent run, reviewer verdict, merge, holdout result, real-use bug | Spans emitted from the GitHub workflows |
| Diagnosis | Why a run failed | Session transcripts |

- **One trace per issue:** the workflow starts a trace when an issue gets `ready` and passes `TRACEPARENT` to every headless agent run (spec, test, implementer, reviewer, security), so each run is a child span. The issue number is also set through `OTEL_RESOURCE_ATTRIBUTES`.
- **Conventions:** factory attribute names are defined and enforced with OpenTelemetry Weaver.
- **Content stays redacted:** prompt and response content is left redacted, as it is by default.
- **Transcripts are stored privately,** compressed in a Cloudflare R2 bucket on a personal account and expired after 30 days by a lifecycle rule, never as workflow artifacts on a public repo.
- **Backend:** Grafana Cloud's free tier, with 14-day retention, for operational telemetry, plus a local Grafana LGTM container for experimenting. Long-term history comes from GitHub for pipeline facts, and from a daily cost and token summary written to R2.
- **Scope:** the minimum is the trace per issue, the resource attributes and private transcripts. Dashboards come once there is data, and observability does not delay the hooks.

## Harness hooks

**Guardrail files are human-owned.** Agents may not change `.editorconfig`, `.globalconfig` or `.runsettings` files at any depth, `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config`, `global.json`, `.config/dotnet-tools.json`, Stryker configuration, anything under `.github/` or `.claude/`, user-level Claude settings and plugins under `~/.claude`, commands that change Claude's configuration, or architecture test projects (`*.ArchitectureTests`). Changes to them come only through the harness repo, as the one exception to the no-human rule. Enforcement is server-side: a required CI check fails any PR that touches them unless I or Dependabot opened it. CODEOWNERS, copied from the harness's `templates/CODEOWNERS.example`, makes me the owner of the guardrail paths and of the product and architecture docs. Code-owner review is required through a ruleset of its own, with me as a bypass actor for pull requests. Dependabot's PRs, and any agent change to an owned doc, need my approval, and my own PRs can still merge. A second human reviewer was rejected for now: they would need to know the harness and be available when needed, which is friction for little gain while I make every guardrail change myself. Exempting named people instead of listing agent Apps means a new App is checked by default. Dependabot is exempt because the versions it bumps live in guardrail files; the new-package check still catches packages it adds. The check runs on `pull_request_target`, so a PR can't edit the workflow that runs it, and it reads the changed files from the API without running the PR's code. The PreToolUse hooks are fast feedback that catches the obvious attempts early, not the enforcement. The hook's one exception is the architecture session's opt-in for `*.ArchitectureTests` (see "Product and architecture").

**Suppressions are blocked too,** in code and in project files. In code that means `#pragma warning disable`, `#nullable disable`, `[SuppressMessage]`, `[UnconditionalSuppressMessage]`, `// Stryker disable`, and skipped or explicit-only tests (`Skip =`, `Explicit = true`, `Assert.Skip`, `[Ignore]`). It also means the attributes the coverage collector skips: `[ExcludeFromCodeCoverage]`, `[DebuggerNonUserCode]` and `[DebuggerHidden]`. In `.csproj` files it means adding `NoWarn`, `WarningsNotAsErrors` or `TreatWarningsAsErrors`, or `Nullable`, `AnalysisMode`, `AnalysisLevel`, `EnforceCodeStyleInBuild`, `RunAnalyzers*`, `WarningLevel`, `NuGetAudit*`, `CodeAnalysisRuleSet`, `RunSettingsFilePath` or `VSTestSetting` properties. Generated files (`*.g.cs`, `*.Designer.cs`, `obj/`) are exempt. An agent that thinks one is needed stops and comments on the issue, as it does for a blocking assumption.

**The Stop hook gives fast feedback only:** a build with analyser warnings as errors, unit tests and architecture tests. Mutation testing, holdouts and the PR size check run in CI only.

**Every block says what to do instead.** Headless runs get `FACTORY_ISSUE` from the workflow, and a block tells the agent to comment on that issue and write a progress note. Without it, as in my own sessions, the block tells the agent to stop and explain to me.

**Formatting runs when the agent commits.** A PreToolUse hook on `git commit` runs whitespace and style formatting on the files being committed; if anything changed, it denies the commit and asks the agent to review and re-stage. The build remains the gate: IDE0055 and code-style rules fail it through `EnforceCodeStyleInBuild` and warnings as errors.

**Test projects follow a naming convention** so the Stop hook can tell fast tests from slow ones: `*.UnitTests` and `*.ArchitectureTests` run in the Stop hook; `*.IntegrationTests` and `*.UiTests` run in CI only. A CI check rejects test projects that don't match, and projects named like test projects that aren't. It knows which projects are test projects from MSBuild's `IsTestProject`, which the build-settings target records. Unit tests are sociable: they use the application's real classes and fake only its boundaries, such as the database, message brokers and HTTP clients. The code that talks to those boundaries lives in product projects named `*.Adapters`, and integration tests exercise it against real dependencies in Testcontainers.

**The progress note is the only way to stop on a red build.** An implementer that stops partway writes `.factory/progress.md` on the branch, with a status (`blocked: awaiting answer` or `paused: work in progress`) and where it got to. The Stop hook allows a stop if there are no changes since the last green run, if the checks pass, or if a valid progress note exists. Otherwise it refuses and tells the agent to fix the failures or write the note and explain the blocker. It never refuses twice in a row, so it can't loop, because CI still catches a red build. A required CI check fails any PR that contains a progress note, so it can pause work but never merge it. A resumed run reads the note and deletes it when it finishes.

## Analyser package

**Off-the-shelf analysers only to start**, with custom rules added later as review comments surface them. At work the order reverses, because existing house rules justify custom analysers from day one.

**Everything on, with deliberate opt-outs:** `AnalysisMode` set to `All`, `EnforceCodeStyleInBuild` and warnings as errors. Severities ship as a `.globalconfig` in the package, which each repo's own `.editorconfig` can override.

**Size and complexity limits are enabled explicitly,** not left to analyser defaults: files under 500 lines, methods under 50 lines and cognitive complexity under 15. They keep code small enough for agents to reason about within their context, and changes to them come through me like any other guardrail. They come from the Sonar analyser (`SonarAnalyzer.CSharp`), the only off-the-shelf one found that covers all three: S104, S138 and S3776, set to `error` in `.editorconfig` because Sonar leaves them off. The thresholds can't go in `.editorconfig`, so they live in the repo's `.github/SonarLint.xml`, which is a guardrail because it's under `.github/`. Sonar counts lines of code for the file limit, leaving out blank lines and comments, and doesn't apply the method limit to test projects. Meziantou's method-length rule, set in `.editorconfig`, was rejected because nothing off the shelf would then cover file length or cognitive complexity.

**First custom rule: strongly typed IDs.** A method parameter whose name ends in `Id` must not be a primitive (`int`, `long`, `Guid` or `string`); the error tells the agent to use or create a type such as `TaskId`. The ID types themselves and generated code are exempt. Primitives stay at the edges: each ID type supports `IParsable` for model binding, an EF Core value converter and a JSON converter, possibly generated by a library such as Vogen. The analyser has its own tests. The React project gets the equivalent as branded types enforced by a custom ESLint rule.

## CI actions

**Mutation testing gates every PR** on changed product code, using Stryker.NET, to build confidence in agent-written tests. It runs unit tests only, because integration tests are too slow to run per mutant, and it doesn't mutate `*.Adapters` projects. The harness chooses the files to mutate: every changed file in a core project, plus every file in a core project that a changed unit test project references. Stryker's own comparison with the target branch isn't used, because it ignores changes to tests, so a weakened assertion would pass. Whole files are scored, not changed lines, so touching a file means owning its score. That catches tests weakened elsewhere, and in an existing codebase it pushes poor tests to be fixed. Stryker only mutates a project that a test project references directly, so a core project that no unit test project references directly fails the check. The harness pins Stryker's version and passes its own settings, ignoring any configuration in the product repo. The check reads Stryker's JSON reports: a missing report fails, and a PR with no mutants in product code passes. Some mutants behave exactly like the original code, and `// Stryker disable` is a blocked suppression, so a score below the threshold passes when I applied the `mutation-override` label, as with PR size and coverage. Moving the check to a nightly run may be considered later; changing one test file mutates every core project its test project references.

**The mutation score threshold starts at 75%** on changed code and is raised as results allow.

**Coverage is a ratchet, not a target.** Two figures are ratcheted, each as line and branch coverage that must not fall below the latest successful build of the target branch. Product code is measured from `*.UnitTests` only, and `*.Adapters` code from `*.IntegrationTests` only. Architecture and UI tests count towards neither. The allowed drop is 0.1 percentage points, to cover rounding. A deleted or weakened test that loses coverage fails the PR wherever the overall figure stands. Deleting code that is well covered can legitimately lower the figure, so an override label is accepted only when I applied it, as with PR size. The label is `coverage-override`, separate from the PR size label, so approving one doesn't approve the other. A fixed floor may be added later. A product project that no unit test loads, or an adapter project that no integration test loads, fails the build, because it would otherwise be left out of the figure rather than counted as 0%. An adapter project could become a place to hide logic from the mutation gate. Each product's architecture tests keep core code from referencing adapters, and the reviewer agent flags logic in an adapter. Each push stores its branch's figure, and a PR whose target branch has no stored figure, or only an expired one, fails. Code can't be left out of the figure. The attributes the collector skips are suppressions, run settings files are guardrails, and a project may not choose its own run settings. `[GeneratedCode]`, `[CompilerGenerated]` and `[DebuggerStepThrough]` are allowed, because the collector still measures that code.

**CI backstops every hook rule,** since hooks only match text and can be got round. Build settings are asserted by a target that CI imports last, from the pinned harness checkout, through `CustomAfterMicrosoftCommonTargets`. It fails if warnings-as-errors, nullable, `AnalysisMode` (overall or for any category) or code-style enforcement are weakened, analysers are switched off, a project chooses its own run settings, a project doesn't load the Sonar analyser or uses any `SonarLint.xml` but the repo's, a project takes rule severities from a file that isn't an `.editorconfig` or `.globalconfig`, or drops the root `.editorconfig`, or `NoWarn` holds anything beyond the SDK defaults, however the change was made. Exceptions for a product are rule severities in its `.editorconfig`, not `NoWarn`. Each project the target checks leaves a record, and CI fails if any project in the solution has none. Local builds don't run it; it moves into the build package when that exists. Test results fail the run unless every test ran and passed, judged from each test's own result in the TRX files: `dotnet test` reports a skipped test as a pass, and the TRX summary counters miss skips. A test project with no results fails too. A diff scan rejects suppressions in added lines, using the same rules as the hooks. It counts across the whole PR, so moving code with its suppression passes, and it exempts the same people as the path check. In project files it rejects the build properties outright, even when they switch a setting on, because they belong in the shared, human-owned `Directory.Build.props`. A path check rejects agent PRs that touch guardrail files.

**Agent runs in CI use the harness's `run-agent` action,** which loads the plugin with `--plugin-dir` from the action's own copy of the harness, so the pinned tag is written once. A reusable workflow can't see which ref it was called at, so it would need the tag repeated as an input. A headless run ignores marketplaces declared in the repository and drops the plugin without any error. The action therefore fails any run whose startup event doesn't list the plugin as loaded. Runs authenticate with a `claude setup-token` OAuth token, so usage stays within the subscription, and they don't use `--bare`, because bare mode ignores that token.

## Constraints

- **Budget:** Claude Pro, not Max, and free tiers only. To fit that, keep tasks small, send routine jobs to a smaller model and run long loops after the usage allowance resets.  I small budget exists for paid tiers but must be justified.
- **Public repos:** no secrets anywhere, ever.
- **Employer anonymity:** my employer's name and identifying details never appear in anything public. The planned layers are:
  - a separate side-project environment with its own Claude config, git identity and noreply email;
  - a global git hook and a user-level PreToolUse hook, with the pattern list kept outside every repo;
  - a CI scan before any push, with the patterns stored as an Actions secret.
- **Intellectual property:** check the employment contract's IP and outside-work clauses, and get a written agreement before the pitch.

## Open questions

- [x] Add the veto phase between advise and merge? Agreed.
- [x] Value of N for the reviewer agent's gate? 30 comments for veto, 60 for merge, no significant misses.
- [x] A PR size limit? 200 target, 300 hard limit, override label.
- [x] Counting rules for the size check? Whitespace excluded; only I can apply the override.
- [x] Where holdout scenarios live? A private repo, written by a separate test agent.
- [x] What resumes a stopped implementer? Re-applying `ready`.
- [x] Where the to-do app is hosted? A small VPS behind Cloudflare Tunnel and Access.
- [x] Which telemetry backend, and where transcripts are stored? Grafana Cloud free tier; transcripts in R2.
- [x] What each first harness component does? See the hooks, analyser and workflow sections.
- [x] Deleted tests? No dedicated check. The coverage ratchet and the reviewer agent cover it. A list of test names was rejected because names change and a test can be weakened without being deleted.
- [ ] Day 2: stop the line when main is broken, with a fix-the-line exception.
- [ ] Claude Code plans to make `--bare` the default for `-p`. If that happens without a way to opt out, how do CI runs authenticate within the subscription?
