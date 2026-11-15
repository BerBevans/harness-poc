// How a specced issue's body is laid out: the spec, then the owner's original request in a collapsed
// section between markers. The spec agent's posting step writes it, and the implementer's spec copy
// and the PR size check read the spec back from it, so all three agree on where the spec ends.

export const START = '<!-- factory:original-request -->';
export const END = '<!-- /factory:original-request -->';
const ORIGINAL_REQUEST_OPENING = `<details>\n<summary>Original request</summary>\n\n${START}`;

/** The issue body: the spec, then the original request between the markers. */
export const composeBody = (spec, originalRequest) =>
  `${spec}\n\n${ORIGINAL_REQUEST_OPENING}\n${originalRequest}\n${END}\n</details>\n`;

/** Text as it is compared: LF line endings, no trailing whitespace, one final newline. */
export const normaliseSpec = text => `${text.replace(/\r\n?/g, '\n').trimEnd()}\n`;

/** The spec from an issue body, normalised, or null for an issue the spec agent hasn't written. */
export function specFromBody(body) {
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  const end = text.indexOf(ORIGINAL_REQUEST_OPENING);
  if (end < 0) return null;
  const spec = text.slice(0, end);
  return spec.trim() === '' ? null : normaliseSpec(spec);
}
