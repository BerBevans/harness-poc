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

The hook pattern-matches text, so it's fast feedback, not enforcement. It won't catch a bypass built at runtime, for example a script file that's written first and run afterwards, or a flag assembled from variables. The real backstops are `pre-push` and the planned CI scan. Like any hook, it also has no effect if hooks are disabled or the settings entry is removed. On WSL the sandbox below now enforces the file rules; the hook's rewrite will narrow it to what the sandbox can't see.

## claude/sandbox-settings.json - Claude Code sandbox (WSL)

The hook reads command text; the sandbox enforces at the OS level. On WSL2, Claude Code runs every Bash command and its child processes (scripts, `node -e`, git, its hooks) under bubblewrap, so the file rules hold however a command is spelt. `failIfUnavailable` stops a session starting without the sandbox. Native Windows has no sandbox, so agent work runs only in WSL, through the launcher below; the native Windows install is kept only as `claude-admin`. The Windows and WSL installs each have their own `settings.json`.

What the fragment does (each point was checked in a scratch run on 2026-11-26):

- Writes are allowed only in the working folder (where the session started, fixed for the session), `$TMPDIR`, the journal (an additional directory), the twin repo and the npm and agent NuGet caches. Everything else is read-only, `~/.config/git` and `~/.gitconfig` included. Claude Code also protects `~/.claude`, settings files and the working folder's `.git/hooks` and `.git/config` by itself.
- The twin and journal repos are writable, so their `.git/hooks` and `.git/config` are denied explicitly: a planted hook would run unsandboxed the next time I use git there. Commits still work.
- What runs unsandboxed at the next start is denied too: `~/.local/bin` (the launcher) and `~/.local/share/claude` (the binary it runs), the login shell's profiles (`~/.profile`, `~/.bash_profile`, `~/.bash_login`, `~/.bashrc`), `claude-admin`'s binary, settings and hooks on the Windows side, the PowerShell profile folders (with and without OneDrive's Documents redirect) and the Windows Startup folder. These back up the launcher's folder check, for a session started some other way.
- NuGet uses an agent-only cache, because NuGet doesn't re-check packages it has already extracted. A package tampered with in the shared cache would run in my own builds.
- `allowUnsandboxedCommands: false` closes the `dangerouslyDisableSandbox` escape hatch. There are no `excludedCommands`. An excluded command runs with full access, and Docker's daemon runs as root, so excluding `docker` would undo the sandbox.
- The network goes through a proxy that allows only GitHub, NuGet (`api.nuget.org` is enough for restore) and npm. Add a host only when something needs it, and never a wildcard that covers hosts anyone can rent, such as `*.blob.core.windows.net`.
- Reads are denied for credentials agents don't need: `.ssh`, `.aws`, `.azure` and Claude Code's own `.claude/.credentials.json`, in both the WSL and the Windows home (`/mnt/c` is readable from the sandbox).

Accepted limits, while reads are otherwise open:

- The global git hooks read the blocked-terms file from inside the sandbox, so the sandbox can't deny it. The hook above discourages reading it but doesn't enforce that: a command built at runtime can still read it, and GitHub is reachable.
- `gh` needs its token, so `~/.config/gh` stays readable, and a command could send it to GitHub. Git in WSL uses the same token for github.com (`gh auth setup-git --hostname github.com`), because the Windows credential manager is reached through WSL interop, which the sandbox blocks. The token is broad and doesn't expire, so the rulesets are what limit where agents can push. A fine-grained, expiring token for `gh` would narrow it.
- `~/.npm` is shared because npm checks each package against its integrity hash when it reads the cache.

Containers: none in agent sessions. Docker's socket is blocked, and rootless Podman can't map its user ids in the sandbox (`newuidmap` loses its setuid privileges). The container isolation test therefore skips locally and is required in CI: a local green run doesn't cover it. I run container work myself, or CI does.

The twin repo is writable, so an agent could edit the twin's own profile. That's accepted for a personal repo.

Claude Code protects only the start folder's own `.git`, so a repo nested inside it (a clone under `.test-work/`, say) has writable git hooks. Accepted: they run only when git is used in that nested repo.

After installing, check in a session that `touch ~/.gitconfig`, `touch ~/.local/bin/x` and a write to the PowerShell profile folder all fail with "Read-only file system".

Test: `node --test "workstation/claude/*.test.mjs"` pins the whole fragment, so any change, a new key included, means changing the test too. It checks the repo copy, not the installed settings: after editing either, merge by hand again.

Install (WSL):

```sh
sudo apt-get install -y bubblewrap socat
mkdir -p ~/.npm ~/.cache/agent-nuget  # an allowWrite folder must exist before the session starts
```

Back up `~/.claude/settings.json`, merge the fragment into it by hand, replacing `<user>` and `<windows-user>`, then restart Claude Code. `/sandbox` should show the sandbox as enabled, with no Dependencies tab, and in a session `touch ~/.gitconfig` must fail with "Read-only file system".

## claude/claude-wsl - the launcher

The sandbox always lets a session write to the folder it started in. Started in `~`, a session could rewrite this launcher or a shell profile; started in the Windows home, the PowerShell profile; started in `~/src`, every repo's git hooks. So `claude-wsl` starts Claude only inside a git repository under `~/src`, after resolving symlinks, and refuses anywhere else (including inside a `.git` folder) with a message pointing at `claude-admin`. The two routes I use go through it: `claude` in an interactive WSL shell and `claude` in PowerShell. Anything that runs `~/.local/bin/claude` directly (`wsl claude` from cmd, `command claude`, an IDE extension) skips the check; the deny entries in the sandbox section are what cover that.

`claude-admin` on Windows is the native Windows Claude Code, kept as an unsandboxed admin console for maintaining these controls only: manual permission mode, the guard hook installed, never used for coding.

Install (in a WSL terminal outside Claude: a sandboxed session can't write these files, by design):

```sh
install -m 755 workstation/claude/claude-wsl ~/.local/bin/claude-wsl
grep -q 'claude-wsl' ~/.bashrc || echo 'claude() { "$HOME/.local/bin/claude-wsl" "$@"; }' >> ~/.bashrc
source ~/.bashrc
```

Test: `claude-wsl.test.mjs` pins the allowed and refused folders.

On Windows, add both functions to the PowerShell profile (`notepad $PROFILE`). `claude` passes the folder to WSL, mapping `\\wsl.localhost\<distro>\...` paths itself because `wsl.exe --cd` doesn't accept them, and uses `--exec` because Windows PowerShell 5.1 drops quotes embedded in arguments:

```powershell
$global:ClaudeAdminPath = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source

function claude {
    if ($PWD.Provider.Name -ne 'FileSystem') { Write-Error "claude: '$PWD' is not a folder WSL can open."; return }
    $dir = $PWD.ProviderPath
    $distro = @()
    if ($dir -match '^\\\\wsl(?:\.localhost|\$)\\(?<distro>[^\\]+)(?<path>\\.*)?$') {
        $distro = @('-d', $Matches.distro)
        $dir = if ($Matches.path) { $Matches.path -replace '\\', '/' } else { '/' }
    }
    wsl.exe @distro --cd $dir --exec /home/<user>/.local/bin/claude-wsl @args
}

function claude-admin {
    if (-not $global:ClaudeAdminPath) { Write-Error 'claude-admin: native Claude Code not found.'; return }
    Write-Host 'Native Windows Claude Code: UNSANDBOXED admin console.' -ForegroundColor Yellow
    & $global:ClaudeAdminPath @args
}
```
