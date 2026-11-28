import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../guard.mjs';
import { bash, decisionTable, edit, fakeContext, powershell, read, REPO, write } from './helpers.mjs';

const inRepo = relative => `${REPO}\\${relative}`;

decisionTable({
  blocked: [
    ['rm after an escaped quote', bash(String.raw`x=\' rm Directory.Build.props 'y'`)],
    ['a redirect target quoted in part', bash('echo x > ".github/workflows/"ci.yml')],
    // The bash parser's reading of write targets.
    ['>| redirect', bash('echo x >| .editorconfig')],
    ['>& redirect to a file', bash('echo x >& Directory.Build.props')],
    ['&>> redirect', bash('dotnet build &>> Directory.Build.props')],
    ['<> redirect (opens the file read-write)', bash('echo x <> .editorconfig')],
    // Wrapper programs run the command after their options.
    ['command rm', bash('command rm Directory.Build.props')],
    ['env with an assignment, then rm', bash('env FOO=1 rm global.json')],
    ['env -u, then rm', bash('env -u FOO rm global.json')],
    ['nice -n, then rm', bash('nice -n 5 rm .editorconfig')],
    ['timeout with its duration, then cp', bash('timeout -s KILL 5 cp x .editorconfig')],
    ['nohup sed -i', bash("nohup sed -i 's/a/b/' .editorconfig")],
    ['exec rm', bash('exec rm .editorconfig')],
    ['sudo -u, then rm', bash('sudo -u root rm global.json')],
    ['xargs with the path given', bash('echo | xargs rm .editorconfig')],
    ['wrappers nested', bash('nohup nice -n 5 timeout 5 rm .editorconfig')],
    ['wrappers nested deeply', bash(`${Array(12).fill('nohup').join(' ')} rm Directory.Build.props`)],
    ['sudo --, then rm', bash('sudo -- rm global.json')],
    ['timeout --signal=KILL, then rm', bash('timeout --signal=KILL 5 rm .editorconfig')],
    ['nice -n5 attached, then rm', bash('nice -n5 rm .editorconfig')],
    ['nice -5, then rm', bash('nice -5 rm .editorconfig')],
    ['xargs -n1 attached, then rm', bash('echo | xargs -n1 rm .editorconfig')],
    ['env -i with an assignment, then rm', bash('env -i PATH=/usr/bin rm global.json')],
    ['env -, then rm', bash('env - rm global.json')],
    ['flock with its lock file, then rm', bash('flock /tmp/x.lock rm .editorconfig')],
    ['env -S with a separate string', bash("env -S 'rm global.json'")],
    ['env -S attached', bash("env -S'rm global.json'")],
    ['env --split-string=', bash("env --split-string='rm global.json'")],
    ['a wrapper in PowerShell', powershell('command rm .editorconfig')],
    ['rm after a here-document whose prose has an apostrophe',
      bash("cat > notes.md <<'EOF'\nthe docs' note\nEOF\nrm Directory.Build.props")],
    ['rm inside bash -c after an apostrophe', bash(`bash -c "echo it's; rm global.json"`)],
    ['Edit of root .editorconfig', edit(inRepo('.editorconfig'), 'a', 'b')],
    ['Write of nested .editorconfig', write(inRepo('src\\Tasks\\.editorconfig'), 'root = true')],
    ['Write of a .globalconfig', write(inRepo('src\\relaxed.globalconfig'), 'is_global = true')],
    ['Edit of Directory.Build.props', edit(inRepo('Directory.Build.props'), 'a', 'b')],
    ['Edit of Directory.Build.targets', edit(inRepo('Directory.Build.targets'), 'a', 'b')],
    ['Edit of Directory.Packages.props', edit(inRepo('Directory.Packages.props'), 'a', 'b')],
    ['Edit of nuget.config, any case', edit(inRepo('NuGet.Config'), 'a', 'b')],
    ['Write of global.json', write(inRepo('global.json'), '{}')],
    ['Write of a nested Directory.Build.rsp', write(inRepo('src\\Directory.Build.rsp'), '-p:TreatWarningsAsErrors=false')],
    ['shell redirect into MSBuild.rsp', bash('echo "-nowarn:CS8602" > MSBuild.rsp')],
    ['Write of Directory.Solution.targets', write(inRepo('Directory.Solution.targets'), '<Project />')],
    ['Write of a project .user file', write(inRepo('src\\App\\App.csproj.user'), '<Project />')],
    ['Write of after.<sln>.targets', write(inRepo('after.App.sln.targets'), '<Project />')],
    ['Write under obj, which MSBuild imports from', write(inRepo('src\\App\\obj\\App.csproj.x.props'), '<Project />')],
    ['Write of tool manifest', write(inRepo('.config\\dotnet-tools.json'), '{}')],
    ['Edit of Stryker config', edit(inRepo('stryker-config.json'), '75', '50')],
    ['Write of a .runsettings file', write(inRepo('tests\\coverage.runsettings'), '<RunSettings />')],
    ['Edit of a .runsettings file, any case', edit(inRepo('Tests.RunSettings'), 'a', 'b')],
    ['shell redirect into a .runsettings file', bash('echo "<RunSettings />" > coverage.runsettings')],
    ['Write of a workflow', write(inRepo('.github\\workflows\\ci.yml'), 'on: push')],
    ['Write of CODEOWNERS', write(inRepo('.github\\CODEOWNERS'), '* @someone')],
    ['Edit of project .claude settings', edit(inRepo('.claude\\settings.json'), 'a', 'b')],
    ['Edit of a Dockerfile', edit(inRepo('Dockerfile'), 'USER app', 'USER root')],
    ['Edit of a Dockerfile, any case', edit(inRepo('src\\Web\\dockerfile'), 'a', 'b')],
    ['Write of a named Dockerfile', write(inRepo('web.Dockerfile'), 'FROM x')],
    ['Write of a Dockerfile variant', write(inRepo('Dockerfile.dev'), 'FROM x')],
    ['Write of a Containerfile', write(inRepo('Containerfile'), 'FROM x')],
    ['Edit of .dockerignore', edit(inRepo('.dockerignore'), 'tests/', '')],
    ['Write of a per-Dockerfile ignore file', write(inRepo('Dockerfile.dockerignore'), '')],
    ['shell redirect into a Dockerfile', bash('echo "USER root" >> Dockerfile')],
    ['Edit of the Compose file in deploy', edit(inRepo('deploy\\compose.yaml'), '127.0.0.1:8080', '8080')],
    ['Write of a deploy script, any case', write(inRepo('Deploy\\house-todo-deploy'), 'x')],
    ['shell redirect into deploy', bash('echo "ALL ALL=(ALL) ALL" >> deploy/sudoers')],
    ['Edit of an architecture test', edit(inRepo('tests\\Tasks.ArchitectureTests\\LayerTests.cs'), 'a', 'b')],
    ['shell redirect into .editorconfig', bash('echo "root = true" > .editorconfig')],
    ['shell append into nested props', bash('cat >> src/Directory.Build.props <<EOF')],
    ['sed in place on .editorconfig', bash("sed -i 's/error/none/' .editorconfig")],
    ['rm of a workflow', bash('rm .github/workflows/ci.yml')],
    ['cp over Directory.Packages.props', bash('cp /tmp/x.props Directory.Packages.props')],
    ['mv of global.json', bash('mv global.json global.json.bak')],
    ['tee into nuget.config', bash('echo x | tee nuget.config')],
    ['git checkout of a guardrail from another branch', bash('git checkout other -- .editorconfig')],
    ['git checkout of a guardrail after --attr-source and its value', bash('git --attr-source x checkout other -- .editorconfig')],
    ['git rm of an architecture test', bash('git rm tests/Tasks.ArchitectureTests/LayerTests.cs')],
    ['PowerShell Set-Content', powershell('Set-Content -Path .editorconfig -Value "root = true"')],
    ['PowerShell Remove-Item', powershell('Remove-Item .\\.github\\workflows\\ci.yml')],
    ['PowerShell WriteAllText', powershell('[IO.File]::WriteAllText("Directory.Build.props", "x")')],
    ['dotnet new editorconfig', bash('dotnet new editorconfig')],
    ['dotnet new tool-manifest', bash('dotnet new tool-manifest')],
    ['dotnet add package', bash('dotnet add src/Tasks package Newtonsoft.Json')],
    ['dotnet package add', bash('dotnet package add Newtonsoft.Json --project src/Tasks')],
    ['dotnet tool install', bash('dotnet tool install dotnet-ef')],
  ],
  allowed: [
    ['>& to a descriptor', bash('dotnet build >&2 2>&1 | tee build.log')],
    ['>&- closes a descriptor', bash('dotnet build 2>&- | tee build.log')],
    ['a wrapper around a harmless command', bash('timeout 60 dotnet test --no-build')],
    ['nice around a build', bash('nice -n 10 dotnet build')],
    ['a word that names an Object.prototype property', bash('constructor -x')],
    ['>& to a log file', bash('dotnet build >& build.log')],
    ['Read of .editorconfig', read(inRepo('.editorconfig'))],
    ['cat of Directory.Build.props', bash('cat Directory.Build.props')],
    ['copying a guardrail elsewhere', bash('cp .editorconfig /tmp/editorconfig.copy')],
    ['grep in workflows', bash('grep -r dotnet .github/workflows')],
    ['Edit of a csproj', edit(inRepo('src\\Tasks\\Tasks.csproj'), '</ItemGroup>', '<PackageReference Include="Vogen" />\n</ItemGroup>')],
    ['Edit of a unit test', edit(inRepo('tests\\Tasks.UnitTests\\TaskTests.cs'), 'a', 'b')],
    ['Write of the progress note', write(inRepo('.factory\\progress.md'), 'Status: paused: work in progress')],
    ['git checkout of a branch', bash('git checkout -b feature/42-add-task')],
    ['dotnet tool restore', bash('dotnet tool restore')],
    ['dotnet new classlib', bash('dotnet new classlib -n Tasks')],
    ['dotnet remove package', bash('dotnet remove src/Tasks package Old.Package')],
    ['redirect to /dev/null', bash('dotnet build > /dev/null')],
    ['Write of a doc about Dockerfiles', write(inRepo('docs\\dockerfile-notes.md'), 'x')],
    ['Write of a class about deploys', write(inRepo('src\\Tasks\\DeployStatus.cs'), 'x')],
    ['Write of a class named after Docker', write(inRepo('src\\Tasks\\DockerfileParser.cs'), 'x')],
  ],
});

// An architecture session relaxes the rule for architecture tests only.
decisionTable({
  context: fakeContext({ env: { FACTORY_ARCHITECTURE_SESSION: '1' } }),
  blocked: [
    ['architecture session: Edit of .editorconfig', edit(inRepo('.editorconfig'), 'a', 'b')],
    ['architecture session: Write of a workflow', write(inRepo('.github\\workflows\\ci.yml'), 'on: push')],
    ['architecture session: architecture tests under .github', write(inRepo('.github\\Tasks.ArchitectureTests\\x.cs'), 'x')],
    ['architecture session: .runsettings in architecture tests', write(inRepo('tests\\Tasks.ArchitectureTests\\a.runsettings'), 'x')],
    ['architecture session: .editorconfig in architecture tests', write(inRepo('tests\\Tasks.ArchitectureTests\\.editorconfig'), 'x')],
  ],
  allowed: [
    ['architecture session: Edit of an architecture test', edit(inRepo('tests\\Tasks.ArchitectureTests\\LayerTests.cs'), 'a', 'b')],
    ['architecture session: git rm of an architecture test', bash('git rm tests/Tasks.ArchitectureTests/LayerTests.cs')],
  ],
});

test('a factory run never gets the architecture session exemption', () => {
  const context = fakeContext({ env: { FACTORY_ARCHITECTURE_SESSION: '1', FACTORY_ISSUE: '42' } });
  const input = edit(inRepo('tests\\Tasks.ArchitectureTests\\LayerTests.cs'), 'a', 'b');
  assert.match(evaluate(input, context), /is a guardrail file/);
});

for (const value of ['true', '0', ' 1', '']) {
  decisionTable({
    context: fakeContext({ env: { FACTORY_ARCHITECTURE_SESSION: value } }),
    blocked: [
      [`architecture flag "${value}": Edit of an architecture test`, edit(inRepo('tests\\Tasks.ArchitectureTests\\LayerTests.cs'), 'a', 'b')],
    ],
  });
}
