# Workstation guardrails

Guardrails for my own machine, not for product repos: they keep the employer's name out of every commit and protect the global git hooks. Agents can't change the installed copies, so this folder is the source of truth: edit here, run the tests, then reinstall by hand. The factory-harness plugin protects `~/.claude` wherever it is installed, so this hook doesn't duplicate that.

## git/ - global git hooks

These keep the employer's name and other identifying terms out of every commit and push. The terms are read from `~/.config/git/blocked-terms.txt`, which lives outside every repo and must never be committed.

- `pre-commit` checks the whole staged tree, file paths, author/committer identity and the branch name.
- `commit-msg` checks the commit message.
- `pre-push` re-checks every outgoing commit (message, identity, full diff). It catches anything committed with `--no-verify`.
- Each hook chains to the repo's own `.git/hooks/<name>`, which a global `core.hooksPath` would otherwise silently disable.
- Output gives locations but never the matched term, so the term can't leak into an agent's context.

Install:

```sh
mkdir -p ~/.config/git/hooks
cp workstation/git/* ~/.config/git/hooks/ && chmod +x ~/.config/git/hooks/*
git config --global core.hooksPath "~/.config/git/hooks"
```

## claude/ - Claude Code PreToolUse hook

`guard-git-hooks.mjs` stops the agent getting round the git hooks. It denies:

- `--no-verify`, or `git commit -n` (including clusters like `-anm`)
- any mention of `core.hooksPath`, including through `-c` and `GIT_CONFIG_*` variables
- any access to the blocked-terms file, or to `GIT_BLOCKED_TERMS_FILE`
- any tool touching `~/.config/git`, and writes to `~/.claude/hooks/` or `~/.gitconfig`

Every denial tells the agent to stop and explain to the user rather than look for another way round. If the hook can't parse its input it denies (fail closed). In settings it's set to `onFailure: block`, so a missing `node` blocks tool calls rather than letting them through.

Test: `node --test "workstation/claude/*.test.mjs"`

Install: copy the script to `~/.claude/hooks/` and add this to `~/.claude/settings.json`. Replace `<user>` with your user name, because the path must be absolute. A path that's left unchanged doesn't exist, and because the hook is set to `onFailure: block`, every tool call is then blocked. Run `echo $HOME` to get the right prefix.

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob",
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": ["/home/<user>/.claude/hooks/guard-git-hooks.mjs"],
          "timeout": 10,
          "onFailure": "block"
        }
      ]
    }
  ]
}
```

### Known limits

The hook pattern-matches text, so it's fast feedback, not enforcement. It won't catch a bypass built at runtime, for example a script file that's written first and run afterwards, or a flag assembled from variables. The real backstops are `pre-push` and the planned CI scan. Like any hook, it also has no effect if hooks are disabled or the settings entry is removed.
