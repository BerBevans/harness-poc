// Run with: node --test "workstation/claude/*.test.mjs"
// Pins the sandbox fragment as a whole: any change, including a new key, fails here and has to be
// made in this file too, so it shows in review. The comments say why each value is what it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('./sandbox-settings.json', import.meta.url), 'utf8'));
const win = '/mnt/c/Users/<windows-user>';
const journal = '~/src/harness-journal';
// The twin repo is reached through a symlink into the Windows home, so both forms are listed.
const twin = ['~/.claude/twin', `${win}/.claude/twin`];
const sorted = list => [...list].sort();

const expected = {
  // NuGet doesn't re-check packages it has already extracted, so agents get their own cache.
  env: {
    NUGET_PACKAGES: '/home/<user>/.cache/agent-nuget/packages',
    NUGET_HTTP_CACHE_PATH: '/home/<user>/.cache/agent-nuget/http-cache',
  },
  permissions: { additionalDirectories: [journal] },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    // Closes the dangerouslyDisableSandbox escape hatch. No excludedCommands: excluded commands run
    // with full access.
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      // Credentials agents don't need, in both homes.
      denyRead: sorted(['~', win].flatMap(home => ['.ssh', '.aws', '.azure', '.claude/.credentials.json'].map(p => `${home}/${p}`))),
      allowWrite: sorted(['~/.npm', '~/.cache/agent-nuget', ...twin]),
      // The git guardrails, and the hooks and config of every writable repo: a planted hook would
      // run unsandboxed the next time Ben uses git there. Then what runs unsandboxed at the next
      // start: the launcher and the real binary, the login shell's profiles, claude-admin's binary,
      // settings and hooks, PowerShell profiles (Documents may be redirected to OneDrive) and
      // Windows Startup. The launcher's own folder check is the first line; these back it up.
      denyWrite: sorted([
        '~/.gitconfig', '~/.config/git', ...[...twin, journal].flatMap(r => [`${r}/.git/hooks`, `${r}/.git/config`]),
        '~/.local/bin', '~/.local/share/claude', '~/.profile', '~/.bash_profile', '~/.bash_login', '~/.bashrc', '~/.bash_logout',
        '~/.config/systemd/user', '~/.config/environment.d', '~/.npm/_npx',
        ...['.local/bin', ...['settings.json', 'settings.local.json', 'hooks', 'plugins', 'agents', 'skills', 'commands', 'CLAUDE.md'].map(p => `.claude/${p}`)]
          .map(p => `${win}/${p}`),
        ...['Documents', 'OneDrive/Documents'].flatMap(d => ['WindowsPowerShell', 'PowerShell'].map(p => `${win}/${d}/${p}`)),
        `${win}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup`,
      ]),
    },
    // No unix sockets: Docker's daemon runs as root. No wildcards over hosts anyone can rent.
    network: {
      allowedDomains: sorted(['github.com', 'api.github.com', '*.githubusercontent.com', 'api.nuget.org', 'registry.npmjs.org']),
    },
  },
};

test('the sandbox fragment is exactly the agreed one', () => {
  const actual = structuredClone(settings);
  const { filesystem, network } = actual.sandbox ?? {};
  for (const key of ['denyRead', 'allowWrite', 'denyWrite']) if (filesystem?.[key]) filesystem[key] = sorted(filesystem[key]);
  if (network?.allowedDomains) network.allowedDomains = sorted(network.allowedDomains);
  assert.deepEqual(actual, expected);
});
