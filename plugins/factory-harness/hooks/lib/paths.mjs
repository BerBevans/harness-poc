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

/** Collapses `.`, `..` and repeated slashes, so `~/.claude/x/../settings.json` is `~/.claude/settings.json`. */
export function collapseDots(normalisedPath) {
  const absolute = normalisedPath.startsWith('/');
  const kept = [];
  for (const part of normalisedPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') { kept.push(part); continue; }
    const last = kept.at(-1);
    const atRoot = absolute || /^[a-z]:$/.test(last ?? '');
    if (last !== undefined && last !== '..' && !/^[a-z]:$/.test(last)) kept.pop();
    else if (!atRoot) kept.push(part);
  }
  return (absolute ? '/' : '') + kept.join('/');
}

/** Normalises a path, rewrites any spelling of the home directory to the real one, and collapses dots. */
export function expandHome(path, home) {
  const normalised = normalisePath(path);
  const realHome = normalisePath(home).replace(/\/$/, '');
  for (const form of homeForms(home)) {
    if (normalised === form || normalised.startsWith(`${form}/`)) return collapseDots(realHome + normalised.slice(form.length));
  }
  return collapseDots(normalised);
}

/**
 * Every form of a path a rule should check: as written (home expanded, dots collapsed) and, when
 * `context.realpath` resolves it, with symlinks followed. A resolved path under the real location
 * of the home folder or ~/.claude (a symlink itself on some machines) is mapped back to its
 * home-relative spelling, so the rules for ~/.claude still match.
 */
export function pathForms(path, context, cwd) {
  const forms = new Set([expandHome(path, context.home)]);
  if (!context.realpath) return [...forms];
  const raw = String(path).replace(/^(~|\$HOME|\$\{HOME\})(?=[\\/]|$)/, context.home);
  const absolute = /^([a-z]:)?[\\/]/i.test(raw) || !cwd ? raw : `${cwd}/${raw}`;
  const real = context.realpath(absolute);
  if (!real) return [...forms];
  const resolved = collapseDots(normalisePath(real));
  forms.add(resolved);
  for (const root of [context.home, `${context.home}/.claude`]) {
    const realRoot = context.realpath(root);
    if (realRoot && isUnder(resolved, collapseDots(normalisePath(realRoot)))) {
      forms.add(collapseDots(normalisePath(root)) + resolved.slice(collapseDots(normalisePath(realRoot)).length));
    }
  }
  return [...forms];
}

export const baseName = normalisedPath => normalisedPath.slice(normalisedPath.lastIndexOf('/') + 1);

export const segments = normalisedPath => normalisedPath.split('/').filter(Boolean);

export const isUnder = (normalisedPath, normalisedDirectory) =>
  normalisedPath === normalisedDirectory || normalisedPath.startsWith(`${normalisedDirectory.replace(/\/$/, '')}/`);

export const isGeneratedCode = normalisedPath =>
  /\.(g|g\.i|designer)\.cs$/.test(normalisedPath) || segments(normalisedPath).some(s => s === 'obj' || s === 'bin');
