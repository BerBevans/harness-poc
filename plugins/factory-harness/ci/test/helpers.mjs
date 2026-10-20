// Shared test data for the CI checks.

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

