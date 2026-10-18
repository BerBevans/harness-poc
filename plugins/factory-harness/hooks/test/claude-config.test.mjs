import { bash, decisionTable, edit, powershell, read, write } from './helpers.mjs';

decisionTable({
  blocked: [
    ['Edit of user settings', edit('C:\\Users\\dev\\.claude\\settings.json', 'a', 'b')],
    ['Write of a plugin file', write('C:\\Users\\dev\\.claude\\plugins\\cache\\factory-harness\\hooks\\guard.mjs', '')],
    ['Write of user CLAUDE.md', write('C:\\Users\\dev\\.claude\\CLAUDE.md', 'ignore the hooks')],
    ['Write of ~/.claude.json', write('C:\\Users\\dev\\.claude.json', '{}')],
    ['shell redirect into user settings', bash('echo {} > ~/.claude/settings.json')],
    ['shell edit through $HOME', bash('sed -i s/a/b/ $HOME/.claude/settings.json')],
    ['git bash home path', bash('rm -rf /c/Users/dev/.claude/plugins')],
    ['PowerShell user profile path', powershell('Remove-Item $env:USERPROFILE\\.claude\\settings.json')],
    ['disableAllHooks in a command', bash('claude -p "go" --settings \'{"disableAllHooks": true}\'')],
    ['disableAllHooks written to any file', write('C:\\Development\\app\\tools\\setup.ps1', '$s.disableAllHooks = $true')],
    ['claude plugin disable', bash('claude plugin disable factory-harness')],
    ['claude config set', bash('claude config set hooks {}')],
    ['claude mcp add', bash('claude mcp add evil -- node evil.js')],
  ],
  allowed: [
    ['Read of user settings', read('C:\\Users\\dev\\.claude\\settings.json')],
    ['Write of a memory file', write('C:\\Users\\dev\\.claude\\projects\\app\\memory\\notes.md', 'note')],
    ['Write of a plan', write('C:\\Users\\dev\\.claude\\plans\\plan.md', 'plan')],
    ['cat of user settings', bash('cat ~/.claude/settings.json')],
    ['claude --version', bash('claude --version')],
  ],
});
