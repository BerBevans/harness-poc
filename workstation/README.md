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

`guard-git-hooks.mjs` stops the agent getting round the git hooks or reading the blocked-terms file. It parses Bash commands with `shell-parse.mjs` (the factory plugin carries a byte-identical copy in `plugins/factory-harness/hooks/lib/`, which a test keeps in step, so change both together), so it judges what a command runs rather than what its text mentions: a note written through a quoted here-document is data, and a commit message may name a flag. It denies:

- the skip-verification flag and any prefix git accepts for it, and `git commit -n` (including clusters like `-anm`), wherever git runs: behind wrappers, in functions, in `eval`, `bash -c` and `sh -c` strings, in the commands git itself runs (`rebase --exec`, `--upload-pack`, `--receive-pack`, `difftool -x`, `grep -O` and the like), `git submodule foreach` and `git bisect run`, and in a here-document, `echo` or `printf` piped into a shell
- git config keys that aren't on a short allowlist of harmless ones (`user.*`, `color.*`, `core.quotepath` and similar), through `-c`, `--config-env`, `clone --config`, `GIT_CONFIG_*` or a `git config` write; reading a value, `core.hooksPath` included, is allowed
- changing `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG*`, `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `BASH_ENV` or `ENV` (by assignment, `export`, `env`, `unset` or `read`), `git --git-dir`, and a `PATH` that puts a folder before the existing one; the editor, pager and ssh variables git runs (`GIT_EDITOR`, `GIT_SSH_COMMAND` and the like) may only name a plain program with options, and for ssh no config file or command option
- a git global option it doesn't list (before the subcommand). git matches its global options exactly and rejects unknown ones, so a value-taking option added in a newer git can't hide the subcommand; `git-global-options.test.mjs` checks the lists against the real git. Because git is checked wherever the word appears, a command such as `grep -rn git --include=*.yml .` is denied too; put that program's options before the word git
- `alias` and `shopt -s expand_aliases`
- writing any repository's `.git/config` by hand, and `cd` into a `.git` folder
- any mention of the blocked-terms file or `GIT_BLOCKED_TERMS_FILE`, any path into `~/.config/git` or `~/.claude/hooks`, and a glob that could reach the terms file
- code it can't see: a command name, `eval` string or git argument known only when it runs (and an unquoted one, which could split into more words), a shell or interpreter reading its program from stdin it can't follow (`curl ... | sh`), `xargs` into git or a shell, and bash it can't parse

git's own commands run directly (`git-commit`, `/usr/lib/git-core/git-config`) count as git. Variables set once to a literal earlier in the same command (`S=/tmp/x; bash -c "ls $S"`) are worked out and checked by value. A variable used as a command name is allowed when every value it's given ends in a harmless program name, and a function whose body is just `"$@"` has each call checked as the command it runs.

Under all of that, the old text rules still run as a floor, so the guard is never weaker than the pattern-matching one it replaced: strings other programs run as code (`trap`, `watch`, `GIT_SSH_COMMAND`, inline `node -e` code) are still caught. The floor reads the whole command text, so anything the parser reads past (array elements, `for` lists, `[[ ]]` operands) is still checked, and blanks out only what is proven data, using the parser's positions: literal commit, merge and tag messages, `gh` bodies and titles, a quoted here-document feeding the message (`git commit -m "$(cat <<'EOF' ... EOF)"`), and `core.hooksPath` in a `git config` read. It blanks only when the whole command is that one bare `git` or `gh` call, with no env prefix, pipe or other command. Anything beside it could read the "data" back and run it (a function, `eval`, a trap, `test -v`, python reading `git log`), so then the text rules read everything, as the old guard did. A note naming a skip flag written with `cat <<'EOF'`, or `cd x && git commit -m "..."` with one in the message, is denied; use the Write tool, or run the commit on its own. Variable resolution is off when the command mentions `IFS`. The terms-file rule reads everything, notes included. PowerShell gets the text rules alone.

Every denial says what to do next: a command it couldn't see or parse can be written out plainly and retried; anything else means stop and tell the user. Any error in the hook is a denial (fail closed). In settings it's set to `onFailure: block`, so a missing `node` blocks tool calls rather than letting them through.

Test: `node --test "workstation/claude/*.test.mjs"`

Install: copy `guard-git-hooks.mjs` and `shell-parse.mjs` to `~/.claude/hooks/` (the sandbox write-protects that folder, so do it from a terminal or `claude-admin`) and add this to `~/.claude/settings.json`. Replace `<user>` with your user name, because the path must be absolute. A path that's left unchanged doesn't exist, and because the hook is set to `onFailure: block`, every tool call is then blocked. Run `echo $HOME` to get the right prefix.

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

The hook is a guard against accidents and casual bypasses, not a wall against a determined agent. It doesn't yet follow script files (`bash x.sh`, `source x`, `./x.sh`); that is the next change, which will also deny running a script the same command writes, since reading it from disk at check time sees the old file or none. Until then a script written and run in one command is caught only when its text trips the floor. It never checks script files run by an interpreter (`node x.mjs`, `python x.py`) or the commands a build runs (`npm test`, `make`, MSBuild targets). It also doesn't yet check a write redirect to a variable it can't work out (`>> "$p"`), `/dev/stdin` used as a script, or some less common variables whose value git or ssh runs (`GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`). It can't see code bash evaluates from data (`x='a[$(cmd)]'` read from a file, then `$((x))`), a variable holding `;` and more commands inside a `bash -c` string, a script rewritten between the check and the run, or a recursive read of a folder above `~/.config/git`. Each Bash call is checked on its own, so text split across calls gets past it: a commit message naming a skip flag in one call, and a later call that reads it back with `git log` and runs it. Inline interpreter code (`python3 -c`, `node -e`) gets only the text rules, so string concatenation beats it. The real backstops are `pre-push` and the planned CI scan. Like any hook, it also has no effect if hooks are disabled or the settings entry is removed. On WSL the sandbox below enforces the file rules.

## claude/sandbox-settings.json - Claude Code sandbox (WSL)

The hook reads command text; the sandbox enforces at the OS level. On WSL2, Claude Code runs every Bash command and its child processes (scripts, `node -e`, git, its hooks) under bubblewrap, so the file rules hold however a command is spelt. `failIfUnavailable` stops a session starting without the sandbox. Native Windows has no sandbox, so agent work runs only in WSL, through the launcher below; the native Windows install is kept only as `claude-admin`. The Windows and WSL installs each have their own `settings.json`.

What the fragment does (checked in scratch runs on 2026-11-26, except the best-effort deny entries, which are checked after install; a denied path that doesn't exist yet can't be created either):

- Writes are allowed only in the working folder (where the session started, fixed for the session), `$TMPDIR`, the journal (an additional directory), the twin repo and the npm and agent NuGet caches. Everything else is read-only, `~/.config/git` and `~/.gitconfig` included. Claude Code also protects `~/.claude`, settings files and the working folder's `.git/hooks` and `.git/config` by itself.
- The twin and journal repos are writable, so their `.git/hooks` and `.git/config` are denied explicitly: a planted hook would run unsandboxed the next time I use git there. Commits still work.
- The best-known places where code runs unsandboxed later are denied too: the launcher and the binary it runs (`~/.local/bin`, `~/.local/share/claude`), the login shell's files (`~/.profile`, `~/.bash_profile`, `~/.bash_login`, `~/.bashrc`, `~/.bash_logout`), systemd user units and `environment.d` (WSL runs systemd), npx's installed packages (`~/.npm/_npx`, which npx reuses without re-checking), `claude-admin`'s binary, settings, MCP servers (`.claude.json`), hooks, plugins, agents, skills, commands and `CLAUDE.md` on the Windows side, the PowerShell profile folders (with and without OneDrive's Documents redirect) and the Windows Startup folder. This is best effort. No deny list can be complete for a session started in a home folder (tool configs such as `~/.npmrc` or `~/.dotnet/tools` would still be writable), so the launcher's folder check is the control; these entries only limit the damage if it's skipped.
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

Claude Code protects only the start folder's own `.git/hooks` and `.git/config`, so a repo nested inside it (a clone under `.test-work/`, say) has writable git hooks, and probably so does a submodule's `.git/modules/<name>/hooks` (unchecked). Accepted: they run only when git is used in that nested repo.

After installing, check in a session that `touch ~/.gitconfig`, `touch ~/.local/bin/x` and a write to the PowerShell profile folder all fail with "Read-only file system".

Test: `node --test "workstation/claude/*.test.mjs"` pins the whole fragment, so any change, a new key included, means changing the test too. It checks the repo copy, not the installed settings: after editing either, merge by hand again.

Install (WSL):

```sh
sudo apt-get install -y bubblewrap socat
mkdir -p ~/.npm ~/.cache/agent-nuget  # an allowWrite folder must exist before the session starts
```

Back up `~/.claude/settings.json`, merge the fragment into it by hand, replacing `<user>` and `<windows-user>`, then restart Claude Code. `/sandbox` should show the sandbox as enabled, with no Dependencies tab, and in a session `touch ~/.gitconfig` must fail with "Read-only file system".

## claude/claude-wsl - the launcher

The sandbox always lets a session write to the folder it started in. Started in `~`, a session could rewrite this launcher or a shell profile; started in the Windows home, the PowerShell profile; started in `~/src`, every repo's git hooks. So `claude-wsl` starts Claude only inside a git repository under `~/src`, after resolving symlinks, and refuses anywhere else (including inside a `.git` folder) with a message pointing at `claude-admin`. The two routes I use go through it: `claude` in an interactive WSL shell and `claude` in PowerShell. Anything that runs `~/.local/bin/claude` directly (`wsl claude` from cmd, `command claude`, an IDE extension) skips the check, and only the best-effort deny entries in the sandbox section limit the damage then. Making `~/.local/bin/claude` itself the launcher would close that, but the auto-updater rewrites that link (backlog).

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
