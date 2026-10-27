// Builds a copy of samples/consumer with BuildSettings.targets imported the way CI imports it,
// then weakens the settings in each way the target must catch. Needs the .NET SDK.
//   node --test "build/test/*.test.mjs"

import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, readRecords, recordedProjects, solutionProjects } from '../../plugins/factory-harness/ci/build-settings-report.mjs';

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));
const targetsFile = path.join(harnessRoot, 'build/BuildSettings.targets');
// Not %TEMP%: Windows Smart App Control blocks loading freshly built DLLs from there.
const workFolder = process.env.HARNESS_TEST_WORK_DIR || path.join(harnessRoot, '.test-work');
const projectFile = 'src/Consumer/Consumer.csproj';

let repo;
let reportDir;
let originalProject;

const sonarLintFile = () => path.join(repo, '.github/SonarLint.xml');
const projectPath = () => path.join(repo, projectFile);
const writeProject = text => fs.writeFileSync(projectPath(), text);
// Adds properties to the sample's project file, just before its closing tag.
const addToProject = xml => writeProject(originalProject.replace('</Project>', `${xml}\n</Project>`));

function build(...extraArgs) {
  fs.rmSync(reportDir, { recursive: true, force: true });
  const result = spawnSync('dotnet', [
    'build', path.join(repo, 'Consumer.slnx'), '-nologo', '-v:q',
    `-p:CustomAfterMicrosoftCommonTargets=${targetsFile}`,
    `-p:BuildSettingsReportDir=${reportDir}`,
    `-p:FactorySonarLintFile=${sonarLintFile()}`,
    ...extraArgs,
  ], { encoding: 'utf8' });
  const solution = path.join(repo, 'Consumer.slnx');
  const report = evaluate({ projects: solutionProjects(solution), recorded: recordedProjects(reportDir) });
  return { status: result.status, output: result.stdout + result.stderr, report };
}

describe('build settings target', { timeout: 600_000 }, () => {
  before(() => {
    fs.mkdirSync(workFolder, { recursive: true });
    repo = fs.mkdtempSync(path.join(workFolder, 'build-settings-'));
    reportDir = path.join(repo, '.build-settings-report');
    fs.cpSync(path.join(harnessRoot, 'samples/consumer'), repo, { recursive: true, filter: source => !/[\\/](bin|obj)$/.test(source) });
    originalProject = fs.readFileSync(projectPath(), 'utf8');
  });

  afterEach(() => writeProject(originalProject));
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('the sample builds and every project is recorded', () => {
    const { status, output, report } = build();
    assert.equal(status, 0, output);
    assert.equal(report.passed, true, report.lines.join('\n'));
    const tests = readRecords(reportDir).find(record => record.isTestProject);
    assert.deepEqual(tests.references, [projectPath()]);
  });

  test('every weakened setting in a project file is reported, not just the first', () => {
    addToProject(`  <PropertyGroup>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsNotAsErrors>CS0168</WarningsNotAsErrors>
    <NoWarn>$(NoWarn),CS1591</NoWarn>
    <Nullable>disable</Nullable>
    <AnalysisMode>Default</AnalysisMode>
    <AnalysisModeSecurity>None</AnalysisModeSecurity>
    <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>
    <RunAnalyzers>false</RunAnalyzers>
    <RunSettingsFilePath>coverage.runsettings</RunSettingsFilePath>
    <VSTestSetting>coverage.runsettings</VSTestSetting>
  </PropertyGroup>`);
    const { status, output } = build();
    assert.notEqual(status, 0);
    for (const expected of [
      /TreatWarningsAsErrors is 'false'/, /WarningsNotAsErrors is 'CS0168'/, /NoWarn adds CS1591;/,
      /Nullable is 'disable'/, /AnalysisMode is 'Default'/, /AnalysisMode is lowered for Security\b/,
      /EnforceCodeStyleInBuild is 'false'/, /Analysers are switched off/,
      /RunSettingsFilePath is 'coverage\.runsettings'/, /VSTestSetting is 'coverage\.runsettings'/,
    ]) assert.match(output, expected);
    assert.match(output, /Consumer\.csproj/);
    assert.doesNotMatch(output, /Consumer\.UnitTests\.csproj\]/);
  });

  test('a setting weakened in an imported file with any name is caught', () => {
    fs.writeFileSync(path.join(repo, 'src/Consumer/relaxed.xml'),
      '<Project><PropertyGroup><Nullable>annotations</Nullable></PropertyGroup></Project>');
    addToProject('  <Import Project="relaxed.xml" />');
    const { status, output } = build();
    assert.notEqual(status, 0);
    assert.match(output, /Nullable is 'annotations'; it must be enable/);
  });

  test('a setting weakened on the command line is caught', () => {
    const { status, output } = build('-p:TreatWarningsAsErrors=false');
    assert.notEqual(status, 0);
    assert.match(output, /error FH0001: TreatWarningsAsErrors is 'false'/);
  });

  test('a project that removes the Sonar analyser is caught', () => {
    addToProject('  <ItemGroup><PackageReference Remove="SonarAnalyzer.CSharp" /></ItemGroup>');
    const { status, output } = build();
    assert.notEqual(status, 0);
    assert.match(output, /error FH0001: The Sonar analyser \(SonarAnalyzer\.CSharp\) isn't loaded/);
  });

  test('a project that swaps in its own SonarLint.xml is caught, with or without removing the shared one', () => {
    fs.mkdirSync(path.join(repo, 'src/Consumer/loose'), { recursive: true });
    fs.copyFileSync(sonarLintFile(), path.join(repo, 'src/Consumer/loose/SonarLint.xml'));
    for (const items of [
      '<AdditionalFiles Remove="@(AdditionalFiles)" /><AdditionalFiles Include="loose/SonarLint.xml" />',
      '<AdditionalFiles Include="loose/SonarLint.xml" />',
      '<AdditionalFiles Remove="@(AdditionalFiles)" />',
    ]) {
      addToProject(`  <ItemGroup>${items}</ItemGroup>`);
      const { status, output } = build();
      assert.notEqual(status, 0, items);
      assert.match(output, /error FH0001: The size and complexity thresholds must come only from/, items);
    }
  });

  test('a project that adds an analyser config file of any other name is caught, through either item', () => {
    fs.writeFileSync(path.join(repo, 'src/Consumer/relax.txt'), 'is_global = true\ndotnet_diagnostic.CA1716.severity = none\n');
    for (const item of ['GlobalAnalyzerConfigFiles', 'EditorConfigFiles']) {
      addToProject(`  <ItemGroup><${item} Include="relax.txt" /></ItemGroup>`);
      const { status, output } = build();
      assert.notEqual(status, 0, item);
      assert.match(output, /error FH0001: Rule severities may come only from \.editorconfig and \.globalconfig files; this project adds .*relax\.txt/, item);
    }
  });

  test('a project that drops the root .editorconfig is caught, in a target or by switching discovery off', () => {
    for (const xml of [
      '  <Target Name="Strip" BeforeTargets="CoreCompile"><ItemGroup><EditorConfigFiles Remove="@(EditorConfigFiles)" /></ItemGroup></Target>',
      '  <PropertyGroup><DiscoverEditorConfigFiles>false</DiscoverEditorConfigFiles></PropertyGroup>',
    ]) {
      addToProject(xml);
      const { status, output } = build();
      assert.notEqual(status, 0, xml);
      assert.match(output, /error FH0001: The repo's root \.editorconfig \(.*\) isn't among this project's analyser config files/, xml);
    }
  });

  test('a nested .editorconfig and a .globalconfig are allowed, since both are guardrails by name', () => {
    fs.writeFileSync(path.join(repo, 'src/Consumer/.editorconfig'), '[*.cs]\nindent_size = 4\n');
    fs.writeFileSync(path.join(repo, 'src/Consumer/rules.globalconfig'), 'is_global = true\n');
    addToProject('  <ItemGroup><GlobalAnalyzerConfigFiles Include="rules.globalconfig" /></ItemGroup>');
    try {
      const { status, output } = build();
      assert.equal(status, 0, output);
    } finally {
      fs.rmSync(path.join(repo, 'src/Consumer/.editorconfig'));
      fs.rmSync(path.join(repo, 'src/Consumer/rules.globalconfig'));
    }
  });

  test('a build without the expected SonarLint.xml path fails closed', () => {
    const { status, output } = build('-p:FactorySonarLintFile=');
    assert.notEqual(status, 0);
    assert.match(output, /error FH0002: FactorySonarLintFile is ''/);
  });

  test('a project that stops the target being imported is missing from the report', () => {
    writeProject(originalProject
      .replace('<Project Sdk="Microsoft.NET.Sdk">', '<Project Sdk="Microsoft.NET.Sdk" TreatAsLocalProperty="CustomAfterMicrosoftCommonTargets">')
      .replace('</Project>', '  <PropertyGroup><CustomAfterMicrosoftCommonTargets>none</CustomAfterMicrosoftCommonTargets></PropertyGroup>\n</Project>'));
    const { status, output, report } = build();
    assert.equal(status, 0, output);
    assert.equal(report.passed, false);
    assert.match(report.lines[0], /Consumer\.csproj::No build-settings record/);
    assert.equal(report.lines.length, 2);
  });
});
