// Measures the line and branch coverage of a solution's product projects, across every test
// project, for the coverage ratchet. Which projects are product projects comes from the
// build-settings records. Fails if a product project has no coverage at all.
//
// Usage: node coverage.mjs measure <build-settings report folder> <test results folder> <figure file>

import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './build-settings-report.mjs';
import { annotation, runIfMain } from './lib/pull-request.mjs';

const UNMEASURED_FIX =
  "No test loads these projects, so their code isn't measured at all, not even as 0%. Add tests " +
  'that use them; for a project that is hard to unit test, an architecture test that loads it is enough.';

const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, n, v]) => [n, v]));

/** The assembly names (lower case) a Cobertura report has a package for. */
export const reportedAssemblies = xml =>
  [...xml.matchAll(/<package\s[^>]*>/g)].map(([tag]) => (attributes(tag).name ?? '').toLowerCase());

/**
 * Every line in a Cobertura report, from the packages named in `assemblies` (lower case), as
 * { file, line, hits, branchesCovered, branches }. Reads each class's own line list, not the
 * per-method copies of it.
 */
export function parseCobertura(xml, assemblies) {
  const lines = [];
  for (const [, packageTag, packageBody] of xml.matchAll(/(<package\s[^>]*>)([\s\S]*?)<\/package>/g)) {
    if (!assemblies.has((attributes(packageTag).name ?? '').toLowerCase())) continue;
    for (const [, classTag, classBody] of packageBody.matchAll(/(<class\s[^>]*>)([\s\S]*?)<\/class>/g)) {
      const file = attributes(classTag).filename ?? '';
      const ownLines = classBody.replace(/<methods>[\s\S]*?<\/methods>/, '');
      for (const [tag] of ownLines.matchAll(/<line\s[^>]*>/g)) {
        const line = attributes(tag);
        const [, covered = 0, total = 0] = /\((\d+)\/(\d+)\)/.exec(line['condition-coverage'] ?? '') ?? [];
        lines.push({ file, line: Number(line.number), hits: Number(line.hits), branchesCovered: Number(covered), branches: Number(total) });
      }
    }
  }
  return lines;
}

/**
 * Merges lines from every report into one figure. A line is covered if any test project covered
 * it. A report only says how many of a line's branches were covered, not which, so a line's
 * branch count is the best any one report managed. That understates coverage when two projects
 * cover different branches of a line, but it does so the same way for the PR and the baseline.
 */
export function figure(lines) {
  const byLine = new Map();
  for (const entry of lines) {
    const key = `${entry.file}\n${entry.line}`;
    const seen = byLine.get(key);
    byLine.set(key, seen ? {
      hits: Math.max(seen.hits, entry.hits),
      branchesCovered: Math.max(seen.branchesCovered, entry.branchesCovered),
      branches: Math.max(seen.branches, entry.branches),
    } : entry);
  }
  const merged = [...byLine.values()];
  return {
    lines: { covered: merged.filter(l => l.hits > 0).length, valid: merged.length },
    branches: { covered: merged.reduce((sum, l) => sum + l.branchesCovered, 0), valid: merged.reduce((sum, l) => sum + l.branches, 0) },
  };
}

/** A percentage; code with no branches counts as fully branch-covered. */
export const rate = ({ covered, valid }) => (valid === 0 ? 100 : (covered / valid) * 100);

const describe = f => `line ${rate(f.lines).toFixed(2)}% (${f.lines.covered}/${f.lines.valid}), ` +
  `branch ${rate(f.branches).toFixed(2)}% (${f.branches.covered}/${f.branches.valid})`;

/**
 * Measures the product projects' coverage from the reports under the results folder. Returns the
 * figure and the product projects no report covers: a project no test loads is left out of the
 * reports, not counted as 0%, so adding an untested project would otherwise leave the figure alone.
 */
export function measure({ records, results }) {
  const productRecords = records.filter(r => !r.isTestProject);
  const product = new Set(productRecords.map(r => r.assemblyName.toLowerCase()));
  if (product.size === 0) throw new Error('No build-settings records for product projects, so there is nothing to measure.');
  const reports = fs.existsSync(results)
    ? fs.readdirSync(results, { recursive: true }).filter(name => name.endsWith('.cobertura.xml'))
      .map(name => fs.readFileSync(path.join(results, name), 'utf8')) : [];
  if (reports.length === 0) throw new Error(`No coverage reports under ${results}.`);
  const reported = new Set(reports.flatMap(reportedAssemblies));
  const unmeasured = productRecords.filter(r => !reported.has(r.assemblyName.toLowerCase()));
  return { figure: figure(reports.flatMap(xml => parseCobertura(xml, product))), unmeasured };
}

/** Fails for each product project no test loaded. Returns { passed, lines } or null. */
export function unmeasuredResult(unmeasured) {
  if (unmeasured.length === 0) return null;
  const name = r => path.basename(r.path).replace(/\.\w+proj$/i, '');
  return {
    passed: false,
    lines: [...unmeasured.map(r => annotation(path.relative(process.cwd(), r.path), `${name(r)} has no coverage: no test loads it.`)), UNMEASURED_FIX],
  };
}

await runIfMain(import.meta.url, async env => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'measure' && args.length === 3) {
    const { figure: result, unmeasured } = measure({ records: readRecords(args[0]), results: args[1] });
    const failed = unmeasuredResult(unmeasured);
    if (failed) return failed;
    fs.writeFileSync(args[2], JSON.stringify({ ...result, commit: env.GITHUB_SHA }, null, 2));
    return { passed: true, lines: [`Coverage: ${describe(result)}.`] };
  }
  throw new Error('Usage: coverage.mjs measure <report folder> <results folder> <figure file>');
});
