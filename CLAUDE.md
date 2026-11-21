# CLAUDE.md

Working notes for sessions in the harness repo. The design is `docs/decisions.md`; the hooks and CI checks are in `docs/hooks.md`.

## Releasing

1. If the release changes `actions/run-agent` or `CLAUDE_CODE_VERSION`, rerun the `Run-agent check` workflow first. When `CLAUDE_CODE_VERSION` moves, first read the Claude Code monitoring docs (code.claude.com/docs/en/monitoring-usage) for telemetry variables that `TELEMETRY_SWITCHES` or `CONTENT_SWITCHES` in `ci/run-agent.mjs` don't list, including beta switches and aliases. Add any you find to the list and to the `telemetry-exports` job's env: the strip is a deny list, so a new variable gets through unnoticed.
2. Open a release PR that moves every docs example to the coming tag. `ci/test/docs-tag.test.mjs` fails if the examples name an older tag than the newest, so never tag without this PR.
3. Tag the release PR's merge commit with an annotated tag, and push the tag on its own:
   `git tag -a vX.Y.Z <merge commit> -m "vX.Y.Z: <what it brings>"`, then `git push origin vX.Y.Z`.
   Every release tag is annotated. Check with `git cat-file -t vX.Y.Z`, which must say `tag`.
4. Move the product repo's pins in a PR by hand. Don't wait for Dependabot.

## Driving spec rounds in a product repo

- Every `needs-spec` label added, and every comment by the owner on an issue that has the label, starts a round. Add the label once.
- Remove `needs-spec` before commenting on an issue you're closing or splitting.
- Check each round's claims against the code before replying.
- Reply to every point you want changed. The agent changes only what a reply addresses.
- A round takes about 90 seconds, too fast to cancel a queued duplicate.
- Every spec App comment starts a workflow run that the trigger stops in about 200 ms ("not the owner"). That's expected, not a loop.
- Check rounds against the rules too: one round read the code correctly but talked itself past the size rule.

## Tests

Run in a login shell so `~/.profile` applies. The build tests need .NET, and install Stryker into `.test-work/` on first run (network needed).

- From `plugins/factory-harness/hooks`: `node --test "test/*.test.mjs"` and `node --test "test/integration/*.test.mjs"`
- From `plugins/factory-harness/ci`: `node --test "test/*.test.mjs"`
- From the repo root: `node --test "build/test/*.test.mjs"` and `node --test "workstation/claude/*.test.mjs"`

## Gotchas

- This repo doesn't enable its own plugin: it would block the guardrail work done here.
- Harness PRs keep to the 300-line limit by hand (this repo doesn't run the size check): added plus removed lines, blank ones left out.
- The runner rewrites `$RUNNER_TEMP/_github_workflow/event.json` before every step, so `run-agent.mjs` deletes it in the agent's own step.
- `Run-agent check` has a concurrency group that keeps one queued run. To run it repeatedly, start each run after the previous one finishes.
- Claude Code (2.1.310) sends `OTEL_EXPORTER_OTLP_HEADERS` without URL-decoding, though it decodes `OTEL_RESOURCE_ATTRIBUTES`. `run-agent` decodes the headers, and the telemetry check job uses a `%20` header to prove it. A refused export fails silently.
- `system/init` can be read for free: kill the process after the first line and no request reaches the model.
- `plugin validate .` checks only `marketplace.json`; also run `plugin validate plugins/factory-harness`.
- CODEOWNERS is case-sensitive; `isGuardrailPath` isn't. The template lists the casings .NET tools look for. A new guardrail goes in both `templates/CODEOWNERS.example` and the examples in `ci/test/helpers.mjs` (`codeowners-template.test.mjs` checks).
- Parallel `dotnet` calls on a fresh runner race on the NuGet-Migrations lock, so `harness-ci.yml` runs `dotnet nuget locals all --list` first.

## SDK updates

- The local machine is arm64 WSL; CI, the VPS and agent runs are x86_64.
- SDK 10.0.404's VSTest opens the test session folder with x86_64 `open()` flags, which mean `O_DIRECT` on arm64, so `dotnet test` with a collector exits 1 with errno 22 there (microsoft/vstest#16657, fixed on vstest `main` by #16656, not yet in an SDK). Locally, `VSTEST_DISABLE_ARTIFACTS_DIRECTORY_VERIFICATION=1` is set in `~/.profile` to get past it. Never set it in a repo or a workflow: the check works on x86_64 and should stay on there.
- Whenever the SDK moves (a `global.json` bump, by hand or by Dependabot, in this repo or a product repo), test locally with the check back on: `env -u VSTEST_DISABLE_ARTIFACTS_DIRECTORY_VERIFICATION node --test "build/test/coverage.test.mjs"`. If it passes, remove the line from `~/.profile` and this item.
