import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, decisionTable, edit, fakeContext, REPO, write } from './helpers.mjs';
import { evaluate } from '../guard.mjs';
import { findNewSuppressions } from '../rules/suppressions.mjs';

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
    ['property in an imported props file', write(`${REPO}\\build\\relaxed.props`, '<Project><PropertyGroup><NoWarn>CS1591</NoWarn></PropertyGroup></Project>')],
    ['shell append of a pragma', bash('echo "#pragma warning disable" >> src/Tasks/TaskService.cs')],
  ],
  allowed: [
    ['moving an existing pragma', edit(code, '#pragma warning disable CA1822\nvoid A() {}', 'void B() {}\n#pragma warning disable CA1822\nvoid A() {}')],
    ['removing a suppression', edit(code, '#pragma warning disable CA1822\n', '')],
    ['#pragma warning restore', edit(code, 'a', '#pragma warning restore CA1822')],
    ['#nullable enable', edit(code, 'a', '#nullable enable')],
    ['LINQ Skip', edit(code, 'items', 'items.Skip(10).Take(5)')],
    ['[DebuggerStepThrough], which coverage still measures', edit(code, 'a', '[DebuggerStepThrough]')],
    ['[GeneratedCode] in hand-written code, which coverage still measures', edit(code, 'a', '[GeneratedCode("tool", "1.0")]')],
    ['[DebuggerDisplay]', edit(code, 'a', '[DebuggerDisplay("{Name}")]')],
    ['ExcludeFromCodeCoverage in generated code', write(`${REPO}\\src\\Tasks\\Model.g.cs`, '[ExcludeFromCodeCoverage]\nclass A {}')],
    ['pragma in generated code', write(`${REPO}\\src\\Tasks\\Model.g.cs`, '#pragma warning disable\nclass A {}')],
    ['pragma under obj', write(`${REPO}\\src\\Tasks\\obj\\Debug\\Generated.cs`, '#pragma warning disable')],
    ['pragma mentioned in markdown', write(`${REPO}\\docs\\notes.md`, 'never use #pragma warning disable')],
    ['package reference in a csproj', edit(project, '<ItemGroup>', '<ItemGroup>\n<PackageReference Include="Vogen" />')],
    ['grep for pragmas', bash('grep -rn "#pragma warning disable" src')],
    ['rewriting a file that already had a pragma', write(code, '#pragma warning disable CA1822\nclass B {}')],
  ],
  context: fakeContext({ files: { [code]: '#pragma warning disable CA1822\nclass A {}' } }),
});

test('findNewSuppressions reports each kind found, for the CI diff scan', () => {
  const added = '#pragma warning disable CA1\n#nullable disable';
  assert.deepEqual(findNewSuppressions('src/a.cs', added), ['#pragma warning disable', '#nullable disable']);
});

test('the first Write of a file with a pragma is blocked when nothing was there before', () => {
  assert.ok(evaluate(write(`${REPO}\\src\\New.cs`, '#pragma warning disable'), fakeContext()));
});
