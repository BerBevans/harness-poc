# CLAUDE.md

Working notes for sessions in the harness repo. The design is `docs/decisions.md`; the hooks and CI checks are in `docs/hooks.md`.

## Releasing

1. If the release changes `actions/run-agent` or `CLAUDE_CODE_VERSION`, rerun the `Run-agent check` workflow first.
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

## SDK updates

- The local machine is arm64 WSL; CI, the VPS and agent runs are x86_64.
- SDK 10.0.404's VSTest opens the test session folder with x86_64 `open()` flags, which mean `O_DIRECT` on arm64, so `dotnet test` with a collector exits 1 with errno 22 there (microsoft/vstest#16657, fixed on vstest `main` by #16656, not yet in an SDK). Locally, `VSTEST_DISABLE_ARTIFACTS_DIRECTORY_VERIFICATION=1` is set in `~/.profile` to get past it. Never set it in a repo or a workflow: the check works on x86_64 and should stay on there.
- Whenever the SDK moves (a `global.json` bump, by hand or by Dependabot, in this repo or a product repo), test locally with the check back on: `env -u VSTEST_DISABLE_ARTIFACTS_DIRECTORY_VERIFICATION node --test "build/test/coverage.test.mjs"`. If it passes, remove the line from `~/.profile` and this item.
