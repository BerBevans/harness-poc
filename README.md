# Software factory harness

The central, human-owned part of a personal software factory: the guardrails every product repo consumes. `docs/decisions.md` is the design and the spec.

| Folder | What it holds |
| --- | --- |
| `.claude-plugin/` | The plugin marketplace listing |
| `plugins/factory-harness/` | The Claude Code plugin: hooks now, skills and the reviewer agent later |
| `samples/consumer/` | A small .NET solution the hooks are tested against |
| `workstation/` | Guardrails for my own machine (global git hooks and a user-level Claude hook), installed by hand |
| `docs/` | Decisions and how the hooks work |

Install in a product repo:

```sh
claude plugin marketplace add <owner>/harness-poc#v0.1.0 --scope project
claude plugin install factory-harness@factory-harness --scope project
```

See `docs/hooks.md` for what the hooks do, their known limits and how to run their tests.
