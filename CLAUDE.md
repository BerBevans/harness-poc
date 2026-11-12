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
