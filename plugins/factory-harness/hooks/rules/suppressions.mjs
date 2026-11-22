// Blocks new suppressions: in C# code, and as weakening properties in project files.
// It compares the lines each rule matches in the added text with those in the removed text, so
// moving an existing line doesn't trip it, but widening one (`disable X` to `disable X, Y`) or
// swapping one suppression for another does. CI's diff scan uses the same rules.
//
// Generated-looking names (*.g.cs, *.Designer.cs) are scanned too: the agent picks the name and the
// compiler builds the file. Committed build output under obj/ is a guardrail path instead.

import { commandWriteTargets } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

// The attributes the coverage collector skips by default. The bare name is matched, so an alias or
// a fully qualified name is caught too.
const COVERAGE_EXCLUSIONS = [
  { name: '[ExcludeFromCodeCoverage]', pattern: /\bExcludeFromCodeCoverage(Attribute)?\b/g },
  { name: '[DebuggerNonUserCode]', pattern: /\bDebuggerNonUserCode(Attribute)?\b/g },
  { name: '[DebuggerHidden]', pattern: /\bDebuggerHidden(Attribute)?\b/g },
];

export const CODE_SUPPRESSIONS = [
  { name: '#pragma warning disable', pattern: /#\s*pragma\s+warning\s+disable\b/gi },
  { name: '#nullable disable', pattern: /#\s*nullable\s+disable\b/gi },
  // Bare names with word boundaries, so an alias (`using Q = ...SuppressMessageAttribute;`), a
  // qualified name or a named property is caught too.
  { name: '[SuppressMessage]', pattern: /\bSuppressMessage(Attribute)?\b/g },
  { name: '[UnconditionalSuppressMessage]', pattern: /\bUnconditionalSuppressMessage(Attribute)?\b/g },
  // Analysers treat code marked generated as generated, and skip it.
  { name: '[GeneratedCode]', pattern: /\bGeneratedCode(Attribute)?\b/g },
  { name: '[CompilerGenerated]', pattern: /\bCompilerGenerated(Attribute)?\b/g },
  { name: 'Stryker disable comment', pattern: /stryker\s+disable\b/gi },
  { name: 'skipped test (Skip =)', pattern: /\bSkip\s*=/g },
  { name: 'explicit-only test (Explicit = true)', pattern: /\bExplicit\s*=\s*true\b/g },
  { name: 'Assert.Skip', pattern: /\bAssert\.Skip(When|Unless)?\s*\(/g },
  { name: 'Assert.Ignore / Assert.Inconclusive', pattern: /\bAssert\.(Ignore|Inconclusive)\s*\(/g },
  { name: 'Skip.If / Skip.When', pattern: /\bSkip\.(If|IfNot|When|Unless)\s*\(/g },
  // In attribute position only (after [ or a comma, maybe qualified, or opening a line), or as the
  // full attribute name in an alias, so EF Core's builder.Ignore(...) isn't caught.
  { name: '[Ignore]', pattern: /[[,]\s*(?:[\w.]+\.)?Ignore(Attribute)?\b|^Ignore(Attribute)?\b|\bIgnoreAttribute\b|\bIgnore\s*=/g },
  { name: '[Explicit]', pattern: /[[,]\s*(?:[\w.]+\.)?Explicit(Attribute)?\b|^Explicit(Attribute)?\b|\bExplicitAttribute\b/g },
  ...COVERAGE_EXCLUSIONS,
];

export const PROJECT_FILE_SUPPRESSIONS = [
  { name: 'NoWarn', pattern: /<\s*NoWarn\b|\bNoWarn\s*=/gi },
  { name: 'WarningsNotAsErrors', pattern: /<\s*WarningsNotAsErrors\b/gi },
  { name: 'TreatWarningsAsErrors', pattern: /<\s*TreatWarningsAsErrors\b/gi },
  { name: 'Nullable', pattern: /<\s*Nullable\b/gi },
  { name: 'AnalysisMode', pattern: /<\s*AnalysisMode\w*\b/gi },
  { name: 'AnalysisLevel', pattern: /<\s*AnalysisLevel\w*\b/gi },
  { name: 'EnforceCodeStyleInBuild', pattern: /<\s*EnforceCodeStyleInBuild\b/gi },
  { name: 'RunAnalyzers', pattern: /<\s*RunAnalyzers\w*\b/gi },
  { name: 'WarningLevel', pattern: /<\s*WarningLevel\b/gi },
  { name: 'NuGetAudit', pattern: /<\s*NuGetAudit\w*\b/gi },
  { name: 'CodeAnalysisRuleSet', pattern: /<\s*CodeAnalysisRuleSet\b/gi },
  { name: 'EnableNETAnalyzers', pattern: /<\s*EnableNETAnalyzers\b/gi },
  { name: 'CodeAnalysisTreatWarningsAsErrors', pattern: /<\s*CodeAnalysisTreatWarningsAsErrors\b/gi },
  // A test filter or runner arguments can leave tests out of the run.
  { name: 'VSTestTestCaseFilter', pattern: /<\s*VSTestTestCaseFilter\b/gi },
  { name: 'VSTestCLIRunSettings', pattern: /<\s*VSTestCLIRunSettings\b/gi },
  { name: 'TestingPlatformCommandLineArguments', pattern: /<\s*TestingPlatformCommandLineArguments\b/gi },
  // Run settings can exclude modules, classes or source files from coverage.
  { name: 'RunSettingsFilePath', pattern: /<\s*RunSettingsFilePath\b/gi },
  { name: 'VSTestSetting', pattern: /<\s*VSTestSetting\b/gi },
  // Lets a project override properties set on the command line, such as the hook-up of the build
  // settings targets.
  { name: 'TreatAsLocalProperty', pattern: /\bTreatAsLocalProperty\s*=/gi },
  // The rules here read only .csproj, .props and .targets files, and MSBuild imports a file of any
  // name, so an import's Project attribute must name one .props or .targets file. The attributes are
  // walked one by one, so text inside another attribute's value can't satisfy it, and a ; (which
  // MSBuild splits on) isn't allowed. An import split across lines is blocked; it fails safe.
  {
    name: 'Import of a file not named .props or .targets',
    pattern: /<\s*Import\b(?!(?:\s+(?!Project\b)[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s+Project\s*=\s*(?:"[^";]*\.(?:props|targets)"|'[^';]*\.(?:props|targets)'))/gi,
  },
  // SDK projects compile every .cs file already. An explicit Compile item can add a file that isn't
  // .cs (so the scan never reads it as code) or remove code from the build.
  { name: 'Compile item', pattern: /<\s*Compile\b/gi },
];

// Removing a restore widens a suppression to the end of the file, so a restore that disappears counts.
export const RESTORE = {
  name: 'removed restore', pattern: /#\s*pragma\s+warning\s+restore\b|#\s*nullable\s+(restore|enable)\b/gi,
};

// The one suppression a generated file may hold: EF Core writes it into every migration designer
// file and model snapshot. Only that exact line, only in those files.
const EF_MIGRATION_FILE = /(^|\/)migrations\/.*(\.designer\.cs|modelsnapshot\.cs)$/;
const EF_PRAGMA = '#pragma warning disable 612, 618';

const COVERAGE_EXCLUSION_NAMES = new Set(COVERAGE_EXCLUSIONS.map(rule => rule.name));
const BUILD_SETTING_NAMES = new Set(PROJECT_FILE_SUPPRESSIONS.map(rule => rule.name));

/** What a found rule does: 'build-setting', 'coverage-exclusion' or 'suppression'. */
export const kindOf = name =>
  BUILD_SETTING_NAMES.has(name) ? 'build-setting'
    : COVERAGE_EXCLUSION_NAMES.has(name) ? 'coverage-exclusion'
      : 'suppression';

const BLOCK_REASONS = {
  'suppression': names => `adds a suppression (${names}). Fix the underlying warning or test instead.`,
  'coverage-exclusion': names => `excludes code from coverage (${names}). Write tests for that code instead.`,
  'build-setting': names =>
    `sets a build setting (${names}) that only the shared Directory.Build.props may set. Remove it from the project file.`,
};

/** The block message for the rules found, one sentence per kind. */
export function blockMessage(found, nextStep) {
  const reasons = Object.entries(BLOCK_REASONS)
    .map(([kind, reason]) => [reason, found.filter(name => kindOf(name) === kind)])
    .filter(([, names]) => names.length > 0)
    .map(([reason, names], i) => `${i === 0 ? 'Blocked: this change' : 'This change also'} ${reason(names.join(', '))}`);
  return `${reasons.join(' ')} If you believe it is needed, don't add it. ${nextStep}`;
}

// Razor sources compile to C# in the same assembly.
const isCodeFile = path => /\.(cs|razor|cshtml)$/.test(path);
const isProjectFile = path => /\.(csproj|props|targets)$/.test(path);

/** The suppression rules that apply to a file: code rules, project-file rules, or none. */
export const suppressionRulesFor = normalisedPath =>
  isCodeFile(normalisedPath) ? CODE_SUPPRESSIONS
    : isProjectFile(normalisedPath) ? PROJECT_FILE_SUPPRESSIONS
      : [];

export const normaliseLine = line => line.trim().replace(/\s+/g, ' ');

/** Whether a normalised line counts for `rule` in this file. The EF Core pragma doesn't, in migration files. */
export function lineMatcher(rule, normalisedPath) {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
  const efFile = EF_MIGRATION_FILE.test(normalisedPath);
  return line => pattern.test(line) && !(efFile && line === EF_PRAGMA);
}

const matchingLines = (text, rule, normalisedPath) =>
  text.split('\n').map(normaliseLine).filter(lineMatcher(rule, normalisedPath));

/** The items in `from` with no equal line left in `minus`, each paired off once: a multiset difference. */
export function unmatched(from, minus, lineOf = item => item) {
  const left = new Map();
  for (const line of minus) left.set(line, (left.get(line) ?? 0) + 1);
  return from.filter(item => {
    const n = left.get(lineOf(item)) ?? 0;
    if (n > 0) left.set(lineOf(item), n - 1);
    return n === 0;
  });
}

/** The rules a file's change breaks: new or changed suppression lines, or a restore that went. */
export function findNewSuppressions(normalisedPath, addedText, removedText = '') {
  const rules = suppressionRulesFor(normalisedPath);
  const added = rule => matchingLines(addedText, rule, normalisedPath);
  const removed = rule => matchingLines(removedText, rule, normalisedPath);
  const found = rules.filter(rule => unmatched(added(rule), removed(rule)).length > 0).map(rule => rule.name);
  if (rules === CODE_SUPPRESSIONS && unmatched(removed(RESTORE), added(RESTORE)).length > 0) found.push(RESTORE.name);
  return found;
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const blocked = found => blockMessage(found, nextStep);

  if (change.isWrite) {
    for (const path of change.paths) {
      const found = findNewSuppressions(path, change.addedText, change.removedText);
      if (found.length > 0) return blocked(found);
    }
  }

  if (change.command) {
    for (const target of commandWriteTargets(change.command)) {
      const found = findNewSuppressions(target.replace(/\\/g, '/').toLowerCase(), change.command);
      if (found.length > 0) return blocked(found);
    }
  }

  return null;
}
