// Blocks new suppressions: in C# code, and as weakening properties in project files.
// It compares added text with removed text, so moving existing code doesn't trip it.
// CI's diff scan imports findNewSuppressions to apply the same rules to a PR.

import { isGeneratedCode } from '../lib/paths.mjs';
import { commandWriteTargets } from '../lib/command.mjs';
import { nextStepAfterBlock } from '../lib/next-step.mjs';

export const CODE_SUPPRESSIONS = [
  { name: '#pragma warning disable', pattern: /#\s*pragma\s+warning\s+disable\b/gi },
  { name: '#nullable disable', pattern: /#\s*nullable\s+disable\b/gi },
  { name: '[SuppressMessage]', pattern: /(?<!\w)SuppressMessage(Attribute)?\s*\(/g },
  { name: '[UnconditionalSuppressMessage]', pattern: /\bUnconditionalSuppressMessage(Attribute)?\s*\(/g },
  { name: 'Stryker disable comment', pattern: /stryker\s+disable\b/gi },
  { name: 'skipped test (Skip =)', pattern: /\bSkip\s*=/g },
  { name: 'explicit-only test (Explicit = true)', pattern: /\bExplicit\s*=\s*true\b/g },
  { name: 'Assert.Skip', pattern: /\bAssert\.Skip(When|Unless)?\s*\(/g },
  { name: 'Skip.If / Skip.When', pattern: /\bSkip\.(If|IfNot|When|Unless)\s*\(/g },
  { name: '[Ignore]', pattern: /[[,]\s*Ignore(Attribute)?\s*[\](,]/g },
  { name: '[Explicit]', pattern: /[[,]\s*Explicit(Attribute)?\s*[\](,]/g },
  // The attributes the coverage collector skips by default. The bare name is matched, so an alias or
  // a fully qualified name is caught too.
  { name: '[ExcludeFromCodeCoverage]', pattern: /\bExcludeFromCodeCoverage(Attribute)?\b/g },
  { name: '[DebuggerNonUserCode]', pattern: /\bDebuggerNonUserCode(Attribute)?\b/g },
  { name: '[DebuggerHidden]', pattern: /\bDebuggerHidden(Attribute)?\b/g },
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
  // Run settings can exclude modules, classes or source files from coverage.
  { name: 'RunSettingsFilePath', pattern: /<\s*RunSettingsFilePath\b/gi },
  { name: 'VSTestSetting', pattern: /<\s*VSTestSetting\b/gi },
];

const isCodeFile = path => path.endsWith('.cs') && !isGeneratedCode(path);
const isProjectFile = path => /\.(csproj|props|targets)$/.test(path);

/** The suppression rules that apply to a file: code rules, project-file rules, or none. */
export const suppressionRulesFor = normalisedPath =>
  isCodeFile(normalisedPath) ? CODE_SUPPRESSIONS
    : isProjectFile(normalisedPath) ? PROJECT_FILE_SUPPRESSIONS
      : [];

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** Names of suppressions that appear more often in the added text than in the removed text. */
export function findNewSuppressions(normalisedPath, addedText, removedText = '') {
  const rules = suppressionRulesFor(normalisedPath);
  return rules.filter(r => count(addedText, r.pattern) > count(removedText, r.pattern)).map(r => r.name);
}

export function check(change, context) {
  const nextStep = nextStepAfterBlock(context.env);
  const blocked = found =>
    `Blocked: this change adds a suppression (${found.join(', ')}). Suppressions and weakened build settings ` +
    'are not allowed; fix the underlying warning or test instead. If you believe a suppression is needed, ' +
    `don't add it. ${nextStep}`;

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
