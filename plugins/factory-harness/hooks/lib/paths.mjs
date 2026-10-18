// Path helpers. Every comparison works on normalised paths: forward slashes, lower case.
// Lower-casing on case-sensitive file systems only ever blocks more, never less.

export const normalisePath = path => String(path).replace(/\\/g, '/').toLowerCase();

// Every way a command might spell the home directory: C:/Users/x, /c/Users/x, ~, $HOME, %USERPROFILE%...
export function homeForms(home) {
  const normalised = normalisePath(home).replace(/\/$/, '');
  const forms = new Set([normalised, '~', '$home', '${home}', '%userprofile%', '$env:userprofile', '${env:userprofile}']);
  const drive = /^([a-z]):\/(.*)$/.exec(normalised);
  if (drive) forms.add(`/${drive[1]}/${drive[2]}`);
  return [...forms];
}

/** Normalises a path and rewrites any spelling of the home directory to the real one. */
export function expandHome(path, home) {
  const normalised = normalisePath(path);
  const realHome = normalisePath(home).replace(/\/$/, '');
  for (const form of homeForms(home)) {
    if (normalised === form || normalised.startsWith(`${form}/`)) return realHome + normalised.slice(form.length);
  }
  return normalised;
}

export const baseName = normalisedPath => normalisedPath.slice(normalisedPath.lastIndexOf('/') + 1);

export const segments = normalisedPath => normalisedPath.split('/').filter(Boolean);

export const isUnder = (normalisedPath, normalisedDirectory) =>
  normalisedPath === normalisedDirectory || normalisedPath.startsWith(`${normalisedDirectory.replace(/\/$/, '')}/`);

export const isGeneratedCode = normalisedPath =>
  /\.(g|g\.i|designer)\.cs$/.test(normalisedPath) || segments(normalisedPath).some(s => s === 'obj' || s === 'bin');
