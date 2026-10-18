import { bash, decisionTable, powershell, read, REPO, write } from './helpers.mjs';

const grep = (path, glob) => ({ tool_name: 'Grep', tool_input: { pattern: 'password', path, glob }, cwd: REPO });
const glob = pattern => ({ tool_name: 'Glob', tool_input: { pattern }, cwd: REPO });

decisionTable({
  blocked: [
    ['Read of .env', read(`${REPO}\\.env`)],
    ['Read of .env.local', read(`${REPO}\\.env.local`)],
    ['Write of .env.production', write(`${REPO}\\.env.production`, 'KEY=x')],
    ['Read of a certificate', read(`${REPO}\\certs\\dev.pfx`)],
    ['Read of a PEM file', read(`${REPO}\\certs\\server.pem`)],
    ['Read of an SSH key', read('C:\\Users\\dev\\.ssh\\id_ed25519')],
    ['Read of AWS credentials', read('C:\\Users\\dev\\.aws\\credentials')],
    ['Read of gh hosts', read('C:\\Users\\dev\\.config\\gh\\hosts.yml')],
    ['Read of user secrets', read('C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\UserSecrets\\abc\\secrets.json')],
    ['Read of git credentials', read('C:\\Users\\dev\\.git-credentials')],
    ['Grep through .ssh', grep('C:\\Users\\dev\\.ssh')],
    ['Grep with an .env glob', grep(REPO, '.env')],
    ['Glob for .env files', glob('**/.env')],
    ['cat .env', bash('cat .env')],
    ['source .env', bash('source .env && dotnet run')],
    ['cat SSH key through ~', bash('cat ~/.ssh/id_rsa')],
    ['PowerShell Get-Content of .env', powershell('Get-Content .\\.env')],
    ['gh auth token', bash('gh auth token')],
    ['dotnet user-secrets list', bash('dotnet user-secrets list --project src/Tasks')],
  ],
  allowed: [
    ['Read of .env.example', read(`${REPO}\\.env.example`)],
    ['Read of appsettings', read(`${REPO}\\src\\Tasks\\appsettings.Development.json`)],
    ['process.env in a node one-liner', bash('node -e "console.log(process.env.PATH)"')],
    ['commit message mentioning a pem file', bash('git commit -m "Stop loading server.pem at startup"')],
    ['gh auth status', bash('gh auth status')],
    ['Read of a C# file', read(`${REPO}\\src\\Tasks\\EnvironmentReader.cs`)],
  ],
});
