---
name: architecture-session
description: Run a product's architecture session with its owner. Reads docs/product.md, proposes the architecture, challenges it one question at a time, then writes ARCHITECTURE.md, a few ADRs, the empty project skeleton and NetArchTest rules in one PR, and creates needs-spec foundation issues. Use once per product after the product session, and again when a new deployable or major integration arrives.
disable-model-invocation: true
---

# Architecture session

You are running an architecture session with the product's owner, in their own session. It produces:

- `ARCHITECTURE.md`: the context every agent reads
- a few ADRs in `docs/adr/`: one per decision that is hard to reverse
- the empty project skeleton, so later tickets add code rather than structure
- NetArchTest rules in a `*.ArchitectureTests` project: the gates that keep the structure as agreed
- `needs-spec` foundation issues, for work an agent may do

The rules are gates; the documents are context. The owner decides. You propose, challenge and record.

## Before you start

1. Check you're in a product repo: `.github/CODEOWNERS` exists and owns `ARCHITECTURE.md` and `docs/adr/`. If not, stop and say so.
2. Check `docs/product.md` exists on `main`. If it doesn't, stop: the product session comes first.
3. Run `echo "$FACTORY_ARCHITECTURE_SESSION"`. If it isn't `1`, stop and ask the owner to restart Claude Code with `FACTORY_ARCHITECTURE_SESSION=1`. Without it the hook blocks the architecture tests.
4. Check the working tree is clean and you're not on `main`. Propose a branch name (`architecture-session`, or `architecture-<topic>` for a revision) and create it once the owner agrees.
5. If `ARCHITECTURE.md` exists, this is a revision. Read it and the ADRs, and ask what has changed.
6. Read `docs/product.md`, especially "Questions for the architecture session" and the quality bar. Read `Directory.Packages.props`, `global.json` and the solution file to see what's already allowed and present.

## Factory constraints the architecture must fit

These come from the harness and aren't up for decision in this session:

- Test projects are named `*.UnitTests`, `*.ArchitectureTests`, `*.IntegrationTests` or `*.UiTests`, and nothing else may use those names.
- Unit tests are sociable: they use the real classes and fake only the boundaries (database, message brokers, HTTP clients, the clock if needed).
- Code that talks to a boundary lives in product projects named `*.Adapters`, tested only by `*.IntegrationTests` against real dependencies in Testcontainers.
- Core code must never reference an adapter project. Mutation testing and the unit-test coverage figure only see core code, so logic in an adapter escapes both.
- Every product project needs a test project of the right kind that loads it, or the build fails.
- Packages come only through `Directory.Packages.props`, which only the owner edits.

## 1. Propose

From the product document, draft the whole proposal in one message, and keep it as small as the first release allows:

- **Deployables:** how many processes, and what each one is for
- **Projects:** each project, what lives in it, and which projects it may reference
- **Boundaries:** each external dependency (storage, integrations, identity) and the adapter that owns it
- **Data:** what is stored, where, and how the schema changes
- **Cross-cutting:** configuration, logging and telemetry, error handling, authentication
- **ADR candidates:** the decisions that would be expensive to reverse
- **Packages:** every package the proposal needs that isn't in `Directory.Packages.props` yet

Mark every guess as `**Assumption:**`.

## 2. Challenge

List the weak spots, most important first, then work through them **one question at a time**. Give your recommendation with each question and wait for the answer. Look for:

- unconfirmed assumptions
- more deployables or projects than the first release needs
- a dependency direction that lets core code reach a boundary
- a product question the proposal answers without the owner having decided it
- a quality-bar item the architecture can't meet, or doesn't say how it meets
- a decision recorded as an ADR that is cheap to change later (leave it out), or an expensive one with no ADR
- a claim about what an external service can or can't do that a decision rests on, such as whether an identity proxy passes the user's identity to the app. Check it against the service's documentation before it goes in an ADR, and say what you checked

Stop when the list is empty or the owner says it's good enough.

## 3. Packages

If the agreed design needs new packages (always `NetArchTest.Rules` the first time), give the owner the exact `<PackageVersion>` lines for `Directory.Packages.props`, with the latest stable versions, and wait for them to add the lines themselves. Don't edit that file. Then restore to check the versions resolve and the lock files update.

## 4. Write it

1. **ADRs** in `docs/adr/`, numbered from `0001`, using the template below. Usually two to five. In a revision, number new ADRs from the next free number and never edit an accepted ADR's text: a new ADR that replaces one adds a `- Supersedes: [ADR <n>](<file>)` line under its date, and the old ADR changes only its status line, to `superseded by [ADR <n>](<file>)`. `ARCHITECTURE.md` links only the ADRs in force.
2. **`ARCHITECTURE.md`** at the repo root, using the template below. Keep it short: an agent reads it on every ticket.
3. **The skeleton:** create each agreed project with `dotnet new`, add it to the solution, and set the project references the design allows. No product code beyond what a project needs to compile.
4. **The architecture tests:** one `<Product>.ArchitectureTests` project. Write one test per dependency rule in `ARCHITECTURE.md`, each with a name that states the rule and a failure message that lists the offending types. Cover at least:
   - core projects don't reference adapter or host projects
   - core projects don't reference the boundary packages (for example the database driver or an HTTP client library)
   - any layering rule the design adds inside the core
5. **Check it:** build with warnings as errors and run the architecture tests. Then break one rule on purpose (a reference core shouldn't have), confirm the right test fails, and undo it. Tell the owner the result.

## 5. Open the PR, wait for the merge, then create the issues

1. Commit and open one PR with the documents, the skeleton and the architecture tests. The body summarises the design in a few lines and includes the proposed foundation issues as a table. The owner reviews and merges it.
2. Foundation issues are only for work an agent may do, such as the walking skeleton's first end-to-end slice or an adapter's first integration. Never for guardrail work (CI wiring, packages, architecture tests); list that in the PR body as work for the owner instead. Ask the owner to approve the table first.
3. Ask the owner to tell you when the PR has merged, and check with `gh pr view <number> --json state`. Create nothing before it's `MERGED`.
4. Create the approved issues in order with `gh issue create --label needs-spec`, using the product session's issue body template, and link `ARCHITECTURE.md` as well as `docs/product.md`.
5. Never apply `ready`, or any label other than `needs-spec`.

## ARCHITECTURE.md template

```markdown
# Architecture

## Overview

<Two or three sentences: what runs where.>

## Deployables

- <Name>: <what it does, where it runs>

## Projects and dependency rules

| Project | Contains | May reference |
| --- | --- | --- |

The architecture tests in `<Product>.ArchitectureTests` enforce these rules.

## Boundaries

- <External dependency>: owned by <Adapter project>, tested by <IntegrationTests project>

## Data

<What is stored, where, and how the schema changes.>

## Cross-cutting

<Configuration, logging and telemetry, error handling, authentication: one or two lines each.>

## Decisions

- [ADR 0001: <title>](docs/adr/0001-<slug>.md)

## When to escalate

A ticket needs an architecture decision from the owner, flagged as a blocking assumption, if it adds a new dependency direction, new persistence, a new external integration or a new deployable.
```

## ADR template

```markdown
# <Number>. <Decision as a short phrase>

- Status: accepted
- Date: <YYYY-MM-DD>

## Context

<The forces at play and the constraint that makes this decision necessary.>

## Decision

<What we will do, in one or two paragraphs.>

## Alternatives considered

- <Option>: <why not>

## Consequences

<What becomes easier, what becomes harder, and what would make us revisit this.>
```
