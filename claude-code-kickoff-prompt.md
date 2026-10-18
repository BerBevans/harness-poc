# Kickoff prompt for Claude Code

Paste everything below the line into Claude Code, started in the harness repo with the journal repo added as an extra directory (for example `claude --add-dir ../factory-journal`). It assumes the decisions doc has been exported to `docs/decisions.md`.

---

I'm building a software factory as a personal side project, to learn how to make agent-driven development reliable before taking the approach to work. `docs/decisions.md` is the agreed design and the spec for everything we build. Read it in full before doing anything else.

## What we're building in this session

This repo is the harness: the central, human-owned part of the factory that every product repo consumes. Guardrails are the one exception to the "no human coding" rule, so you're helping me build them directly rather than through the factory. Start with the Claude Code plugin hooks described under "Harness hooks" in the decisions doc:

- PreToolUse hooks that block changes to guardrail files (`.editorconfig`, `Directory.Build.props`, `.github/workflows/`, `.claude/`) and block suppressions in code (`#pragma warning disable`, `[SuppressMessage]`, skipped tests).
- PreToolUse hooks that block access to secrets files and destructive git commands such as force-pushing or pushing to main.
- A PostToolUse hook that formats the files just edited.
- A Stop hook that refuses to finish unless the build (analyser warnings as errors), unit tests and architecture tests pass.

Every block message must tell the agent what to do instead, normally: stop and explain in an issue comment. Hooks are code, so they need their own tests.

## How I want to work

- Plan before building. Propose the repo structure and the hook design first, and don't write code until I've agreed the plan.
- Ask me one question at a time.
- If something in the decisions doc looks wrong or contradictory, say so and explain why before building on it. Don't silently work around it.
- Prefer readable code over clever code. Use self-describing identifiers, minimal comments and British English in docs. No emoji.
- Never write my employer's name, or anything that identifies it, in any file, commit message or comment. I won't give it to you. If you see it in something I paste, tell me rather than using it.

## Keeping the decisions doc current

When we change a decision, propose the edit to `docs/decisions.md` and wait for my agreement. Record the reason in the journal.

## The project journal

Maintain a journal in the journal repo. It's the raw material for a possible conference talk and for the plan I'll use when taking this to work, so the gotchas and surprises matter more than the routine.

- At the end of each working session, and at each milestone, draft an entry and show it to me before writing it.
- One file per entry: `entries/YYYY-MM-DD-short-title.md`. Keep `index.md` as a dated list of entries with one line each.
- Entries are append-only. Correct earlier entries with a new entry that links back, never by editing history.
- Record facts and what actually happened, including failures. Don't polish.

Use this template for each entry:

```markdown
# YYYY-MM-DD: short title

**Milestone:**
**Session goal:**

## What we did

## Decisions and why
(link to the decisions doc section if one changed)

## Gotchas and surprises
(what broke, what took longer than expected, what the docs got wrong)

## What I'd do differently at work
(where this would change in a brownfield, regulated, multi-team setting)

## Numbers
(any metrics, costs, timings or counts from this session)

## Talk material
(a story, a quote, a before and after, or a diagram idea worth reusing)

## Open threads
```

Start by confirming you've read the decisions doc, then tell me anything in it you'd challenge before we begin. After that, propose the harness repo structure.
