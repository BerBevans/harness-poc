// Shared test data for the CI checks.

// One example of every guardrail path the decisions doc lists. The path check and the CODEOWNERS
// template are both tested against it, so a new guardrail added here must be covered by both.
export const GUARDRAIL_EXAMPLES = [
  '.editorconfig', 'src/Tasks/.editorconfig', 'src/relaxed.globalconfig',
  'Directory.Build.props', 'src/Directory.Build.targets', 'Directory.Packages.props',
  'NuGet.Config', 'global.json', '.config/dotnet-tools.json', 'stryker-config.json',
  'tests/coverage.runsettings', '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/settings.json',
  'tests/Tasks.ArchitectureTests/LayerTests.cs',
];

// Files that are neither guardrails nor human-owned docs.
export const ORDINARY_EXAMPLES = ['src/Tasks/TaskList.cs', 'tests/Tasks.UnitTests/TaskListTests.cs', 'README.md', 'docs/github.md'];

export const changed = (...filenames) => filenames.map(filename => ({ filename, status: 'modified' }));

// A fake API that serves `files` in pages of 100, and records the URLs it was asked for.
export function fakeApi(files, { status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: status === 200, status, json: async () => files.slice((page - 1) * 100, page * 100) };
  };
  return { urls, fetchImpl };
}

