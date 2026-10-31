---
name: product-session
description: Run a product's product session with its owner. Turns a rough brief into docs/product.md (purpose, users, scope, non-goals, quality bar), challenges the weak spots one question at a time, then creates needs-spec backlog issues. Use once per product before the first ticket, or to revise an existing product document.
disable-model-invocation: true
---

# Product session

You are running a product session with the product's owner, in their own session. The goal is a short product document that the spec agent reads for every ticket, and a backlog of feature issues waiting for spec refinement.

The owner decides. You draft, challenge and record. Don't invent requirements: anything you assume is marked as an assumption until the owner confirms it.

## Before you start

1. Check you're in a product repo: `.github/CODEOWNERS` exists and owns `docs/product.md`. If it doesn't, stop and say so.
2. Check the working tree is clean and you're not on `main`. If you're on `main`, propose a branch name (`product-session`, or `product-revision-<topic>` for a revision) and create it once the owner agrees.
3. If `docs/product.md` already exists, this is a revision. Read it and ask what has changed, instead of asking for a new brief. If its PR's backlog table has no matching issues yet, offer to create them first (step 5).
4. List the open issues (`gh issue list --state open --limit 200`) so you don't create duplicates later.

## 1. Get the brief

Ask the owner for a rough brief in one message. Tell them it can be notes, and suggest they cover:

- what the product is for and the problem it solves
- who uses it, and in what situation
- what the first useful release must do
- anything it deliberately won't do
- what "good enough" means: reliability, speed, accessibility, security, data loss

## 2. Draft the whole document

Write `docs/product.md` from the brief, using the template below. Keep it short: one to two pages. Where the brief is silent, write the section anyway and mark each guess as `**Assumption:**`, so gaps are visible rather than hidden.

Show the owner the draft, then move on to the challenge.

## 3. Challenge it

List the weak spots you found, most important first, as a short numbered list. Then work through them **one question at a time**. Give your recommendation with each question, and wait for the answer before asking the next. After each answer, update the document.

Look for:

- **Unconfirmed assumptions.** Every `**Assumption:**` needs a yes, a no or a correction.
- **Scope items with no user outcome.** Each item should say what a user can do, not what the system contains.
- **A first release that's too big.** Push for the smallest release that is useful to a real user. Move the rest to "Later".
- **Missing or vague non-goals.** Non-goals stop the spec agent widening tickets. Ask about the obvious neighbours of the scope.
- **A quality bar that can't be tested.** "Fast" and "reliable" aren't checkable. Ask for a number, a scenario or an explicit "not a concern yet".
- **Contradictions** between sections, or with what the owner said.
- **Architectural questions.** If the brief forces one (persistence, an external integration, a new deployable, authentication), record it under "Questions for the architecture session". Don't decide it here.

Stop when the list is empty or the owner says the document is good enough. Remove any `**Assumption:**` markers the owner has confirmed.

## 4. Draft the backlog

Propose the feature issues as a table: order, title, user-facing outcome and dependencies. One issue per user-facing outcome, at the size of a feature, not a ticket. Spec refinement splits them later to fit the PR size target, so don't split them yourself.

- Order them so each one builds on the ones before it.
- Leave out foundation work (solution structure, architecture tests, CI wiring). The architecture session adds those.
- Ask the owner to approve, change or drop rows. Create nothing until they approve the list.

## 5. Open the PR, wait for the merge, then create the issues

1. Commit `docs/product.md` and open a PR. The PR body summarises the product in two or three lines and includes the approved backlog table. The document is code-owner owned, so the owner reviews and merges it.
2. Ask the owner to tell you when the PR has merged. Don't create any issue before then: the issues link to the document on `main`, and the spec agent must never run without it.
3. Once they say it has merged, check it with `gh pr view <number> --json state`. If it isn't `MERGED`, say so and wait again.
4. Create the approved issues in order, so later issues can name earlier ones as dependencies. Use `gh issue create --label needs-spec` with the body template below.
5. Never apply `ready`, or any label other than `needs-spec`. Only the owner applies `ready`, after spec refinement.
6. Finish with the issue links in order, and any questions recorded for the architecture session.

If the session ends before the merge, the backlog table in the PR body is the record. A later run of this skill finds the merged document, sees no matching issues, and offers to create them from that table.

## Product document template

```markdown
# <Product name>

## Purpose

<Two or three sentences: the problem, and why this product solves it.>

## Users

<Who uses it and in what situation. One short paragraph or a list per kind of user.>

## Scope

### First release

- <A user can ...>

### Later

- <A user can ...>

## Non-goals

- <What it deliberately won't do, and why if it isn't obvious.>

## Quality bar

- <A checkable statement, such as "a change made on one device shows on another within 5 seconds", or "not a concern yet".>

## Questions for the architecture session

- <Questions the scope raises but this document doesn't decide.>
```

## Issue body template

```markdown
## Outcome

<One or two sentences on what a user can do once this is shipped.>

## Product document

[docs/product.md](https://github.com/<owner>/<repo>/blob/main/docs/product.md), merged in #<PR number>.

## Order and dependencies

- Order: <n> of <total>
- Depends on: <#issue numbers, or "none">

## Notes for spec refinement

<Anything from the session the spec agent should know: confirmed decisions, edge cases raised, open questions. "None" if there are none.>
```
