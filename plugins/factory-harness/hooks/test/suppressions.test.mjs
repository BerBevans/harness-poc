import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, edit, fakeContext, REPO, write } from './helpers.mjs';
import { evaluate } from '../guard.mjs';
import { blockMessage, findNewSuppressions } from '../rules/suppressions.mjs';

const code = `${REPO}\\src\\Tasks\\TaskService.cs`;
const testCode = `${REPO}\\tests\\Tasks.UnitTests\\TaskTests.cs`;
const project = `${REPO}\\src\\Tasks\\Tasks.csproj`;
const addToProject = text => edit(project, '</PropertyGroup>', `${text}\n</PropertyGroup>`);

decisionTable({
  blocked: [
    ['#pragma warning disable', edit(code, 'var x = 1;', '#pragma warning disable CA1822\nvar x = 1;')],
    ['#nullable disable', edit(code, 'namespace Tasks;', '#nullable disable\nnamespace Tasks;')],
    ['[SuppressMessage]', edit(code, 'public void Run()', '[SuppressMessage("Design", "CA1031")]\npublic void Run()')],
    ['fully qualified SuppressMessage', edit(code, 'a', '[System.Diagnostics.CodeAnalysis.SuppressMessage("x", "y")]')],
    ['[UnconditionalSuppressMessage]', edit(code, 'a', '[UnconditionalSuppressMessage("Trimming", "IL2026")]')],
    ['Stryker disable comment', edit(code, 'return a + b;', '// Stryker disable all\nreturn a + b;')],
    ['xUnit Skip', edit(testCode, '[Fact]', '[Fact(Skip = "flaky")]')],
    ['xUnit v3 Explicit', edit(testCode, '[Fact]', '[Fact(Explicit = true)]')],
    ['Assert.Skip', edit(testCode, 'Arrange();', 'Assert.Skip("later");\nArrange();')],
    ['Assert.SkipWhen', edit(testCode, 'a', 'Assert.SkipWhen(true, "later");')],
    ['NUnit or MSTest [Ignore]', edit(testCode, '[Test]', '[Test, Ignore("later")]')],
    ['NUnit [Explicit]', edit(testCode, '[Test]', '[Explicit]\n[Test]')],
    ['[ExcludeFromCodeCoverage]', edit(code, 'public void Run()', '[ExcludeFromCodeCoverage]\npublic void Run()')],
    ['ExcludeFromCodeCoverage with a justification', edit(code, 'a', '[ExcludeFromCodeCoverage(Justification = "glue")]')],
    ['fully qualified ExcludeFromCodeCoverageAttribute', edit(code, 'a', '[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute]')],
    ['ExcludeFromCodeCoverage in an attribute list', edit(code, '[Pure]', '[Pure, ExcludeFromCodeCoverage]')],
    ['alias for ExcludeFromCodeCoverage', edit(code, 'a', 'using NoCover = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;')],
    ['[DebuggerNonUserCode]', edit(code, 'public void Run()', '[DebuggerNonUserCode]\npublic void Run()')],
    ['[DebuggerHidden]', edit(code, 'public void Run()', '[DebuggerHidden]\npublic void Run()')],
    ['Write of a new file with a pragma', write(`${REPO}\\src\\Tasks\\Other.cs`, '#pragma warning disable\nclass A {}')],
    ['NoWarn property', addToProject('<NoWarn>CA1822</NoWarn>')],
    ['NoWarn on a package reference', edit(project, '<ItemGroup>', '<ItemGroup>\n<PackageReference Include="X" NoWarn="NU1608" />')],
    ['WarningsNotAsErrors', addToProject('<WarningsNotAsErrors>CA2007</WarningsNotAsErrors>')],
    ['TreatWarningsAsErrors', addToProject('<TreatWarningsAsErrors>false</TreatWarningsAsErrors>')],
    ['Nullable', addToProject('<Nullable>disable</Nullable>')],
    ['AnalysisMode', addToProject('<AnalysisMode>None</AnalysisMode>')],
    ['AnalysisModeSecurity', addToProject('<AnalysisModeSecurity>None</AnalysisModeSecurity>')],
    ['AnalysisLevel', addToProject('<AnalysisLevel>none</AnalysisLevel>')],
    ['EnforceCodeStyleInBuild', addToProject('<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>')],
    ['RunAnalyzersDuringBuild', addToProject('<RunAnalyzersDuringBuild>false</RunAnalyzersDuringBuild>')],
    ['WarningLevel', addToProject('<WarningLevel>0</WarningLevel>')],
    ['NuGetAudit', addToProject('<NuGetAudit>false</NuGetAudit>')],
    ['NuGetAuditMode', addToProject('<NuGetAuditMode>direct</NuGetAuditMode>')],
    ['CodeAnalysisRuleSet', addToProject('<CodeAnalysisRuleSet>relaxed.ruleset</CodeAnalysisRuleSet>')],
    ['RunSettingsFilePath', addToProject('<RunSettingsFilePath>coverage.runsettings</RunSettingsFilePath>')],
    ['VSTestSetting', addToProject('<VSTestSetting>coverage.runsettings</VSTestSetting>')],
    ['TreatAsLocalProperty', edit(project, '<Project Sdk="Microsoft.NET.Sdk">', '<Project Sdk="Microsoft.NET.Sdk" TreatAsLocalProperty="CustomAfterMicrosoftCommonTargets">')],
    ['property in an imported props file', write(`${REPO}\\build\\relaxed.props`, '<Project><PropertyGroup><NoWarn>CS1591</NoWarn></PropertyGroup></Project>')],
    ['[GeneratedCode] in hand-written code', edit(code, 'a', '[GeneratedCode("tool", "1.0")]')],
    ['[CompilerGenerated]', edit(code, 'a', '[System.Runtime.CompilerServices.CompilerGenerated]')],
    ['ExcludeFromCodeCoverage in a file named like generated code', write(`${REPO}\\src\\Tasks\\Model.g.cs`, '[ExcludeFromCodeCoverage]\nclass A {}')],
    ['pragma in a Designer.cs outside migrations', write(`${REPO}\\src\\Tasks\\Calculator.Designer.cs`, '#pragma warning disable\nclass A {}')],
    ['any other pragma in a migration file', write(`${REPO}\\src\\Data\\Migrations\\X.Designer.cs`, '#pragma warning disable 612, 618, CA1822')],
    ['widening an existing pragma', edit(code, '#pragma warning disable CA1822', '#pragma warning disable CA1822, CA2000, S3776')],
    ['swapping one pragma for another', edit(code, '#pragma warning disable CA1822', '#pragma warning disable S3776')],
    ['NUnit Assert.Ignore', edit(testCode, 'Arrange();', 'Assert.Ignore("later");\nArrange();')],
    ['Assert.Inconclusive', edit(testCode, 'Arrange();', 'Assert.Inconclusive();\nArrange();')],
    ['removing a restore', edit(code, '#pragma warning restore CA1822\n', '')],
    ['SuppressMessage through an alias', edit(code, 'a', 'using Quiet = System.Diagnostics.CodeAnalysis.SuppressMessageAttribute;')],
    ['qualified NUnit Ignore', edit(testCode, '[Test]', '[NUnit.Framework.Ignore("later")]\n[Test]')],
    ['TestCase with Ignore =', edit(testCode, '[TestCase(1)]', '[TestCase(1, Ignore = "flaky")]')],
    ['qualified NUnit Explicit', edit(testCode, '[Test]', '[NUnit.Framework.Explicit]\n[Test]')],
    ['a pragma in a Razor component', write(`${REPO}\\src\\Web\\Pages\\Index.razor`, '@{ #pragma warning disable CS8602 }')],
    ['a Compile item in a project file', edit(project, '<ItemGroup>', '<ItemGroup>\n<Compile Include="..\\docs\\helper.txt" />')],
    ['a Compile Remove in a project file', edit(project, '<ItemGroup>', '<ItemGroup>\n<Compile Remove="Legacy\\**" />')],
    ['shell append of a pragma', bash('echo "#pragma warning disable" >> src/Tasks/TaskService.cs')],
  ],
  allowed: [
    ['moving an existing pragma', edit(code, '#pragma warning disable CA1822\nvoid A() {}', 'void B() {}\n#pragma warning disable CA1822\nvoid A() {}')],
    ['removing a suppression', edit(code, '#pragma warning disable CA1822\n', '')],
    ['#pragma warning restore', edit(code, 'a', '#pragma warning restore CA1822')],
    ['#nullable enable', edit(code, 'a', '#nullable enable')],
    ['LINQ Skip', edit(code, 'items', 'items.Skip(10).Take(5)')],
    ['[DebuggerStepThrough], which coverage still measures', edit(code, 'a', '[DebuggerStepThrough]')],
    ['[DebuggerDisplay]', edit(code, 'a', '[DebuggerDisplay("{Name}")]')],
    ['the EF Core pragma in a migration designer file', write(`${REPO}\\src\\Data\\Migrations\\20261122_Init.Designer.cs`, '// <auto-generated />\n#pragma warning disable 612, 618\nclass A {}')],
    ['the EF Core pragma in a model snapshot', write(`${REPO}\\src\\Data\\Migrations\\AppDbContextModelSnapshot.cs`, '#pragma  warning disable 612, 618')],
    ['an untouched restore', edit(code, 'class A {}', 'class A { }')],
    ['pragma mentioned in markdown', write(`${REPO}\\docs\\notes.md`, 'never use #pragma warning disable')],
    ['package reference in a csproj', edit(project, '<ItemGroup>', '<ItemGroup>\n<PackageReference Include="Vogen" />')],
    ['EF Core fluent Ignore', edit(code, 'a', 'builder.Entity<TaskItem>().Ignore(t => t.Cached);')],
    ['EF Core fluent Ignore on its own line', edit(code, 'a', '    .Ignore(t => t.Cached)')],
    ['grep for pragmas', bash('grep -rn "#pragma warning disable" src')],
    ['rewriting a file that already had a pragma', write(code, '#pragma warning disable CA1822\nclass B {}\n#pragma warning restore CA1822')],
  ],
  context: fakeContext({ files: { [code]: '#pragma warning disable CA1822\nclass A {}\n#pragma warning restore CA1822' } }),
});

test('findNewSuppressions reports each kind found, for the CI diff scan', () => {
  const added = '#pragma warning disable CA1\n#nullable disable';
  assert.deepEqual(findNewSuppressions('src/a.cs', added), ['#pragma warning disable', '#nullable disable']);
});

test('the block message names what each kind of finding needs instead', () => {
  const step = 'Next step.';
  assert.equal(blockMessage(['#pragma warning disable'], step),
    "Blocked: this change adds a suppression (#pragma warning disable). Fix the underlying warning or test instead. If you believe it is needed, don't add it. Next step.");
  assert.match(blockMessage(['[ExcludeFromCodeCoverage]'], step), /^Blocked: this change excludes code from coverage \(\[ExcludeFromCodeCoverage\]\)\. Write tests for that code instead\./);
  assert.match(blockMessage(['TreatAsLocalProperty', 'NoWarn'], step),
    /^Blocked: this change sets a build setting \(TreatAsLocalProperty, NoWarn\) that only the shared Directory\.Build\.props may set\. Remove it from the project file\./);
  assert.doesNotMatch(blockMessage(['NoWarn'], step), /suppression|underlying warning/);
});

test('a block with two kinds gives one sentence each, opening with Blocked once', () => {
  const message = blockMessage(['[DebuggerHidden]', '#nullable disable'], 'Next step.');
  assert.match(message, /^Blocked: this change adds a suppression \(#nullable disable\)\..* This change also excludes code from coverage \(\[DebuggerHidden\]\)\./);
  assert.equal(message.match(/Blocked/g).length, 1);
});

test('the hook blocks a coverage exclusion with the coverage wording', () => {
  const reason = evaluate(write(`${REPO}\\src\\New.cs`, '[ExcludeFromCodeCoverage]\nclass A {}'), fakeContext());
  assert.match(reason, /excludes code from coverage/);
});

test('the first Write of a file with a pragma is blocked when nothing was there before', () => {
  assert.ok(evaluate(write(`${REPO}\\src\\New.cs`, '#pragma warning disable'), fakeContext()));
});
