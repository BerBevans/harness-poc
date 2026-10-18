// Turns a PreToolUse input into the shape every rule checks: what tool, which paths,
// which command, and what text is being added or removed.

import { expandHome } from './paths.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const isText = value => typeof value === 'string' && value.length > 0;

/**
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string}} input
 * @param {{home: string, readFile: (path: string) => string | null}} context
 */
export function describeChange(input, context) {
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};

  const rawPaths = [
    args.file_path,
    args.notebook_path,
    args.path,
    tool === 'Glob' ? args.pattern : null,
    tool === 'Grep' ? args.glob : null,
  ].filter(isText);

  let addedText = '';
  let removedText = '';
  if (tool === 'Edit') {
    addedText = args.new_string ?? '';
    removedText = args.old_string ?? '';
  } else if (tool === 'Write') {
    addedText = args.content ?? '';
    removedText = isText(args.file_path) ? context.readFile(args.file_path) ?? '' : '';
  } else if (tool === 'NotebookEdit') {
    addedText = args.new_source ?? '';
  }

  return {
    tool,
    command: SHELL_TOOLS.has(tool) && isText(args.command) ? args.command : null,
    paths: rawPaths.map(p => expandHome(p, context.home)),
    isWrite: WRITE_TOOLS.has(tool),
    addedText: String(addedText),
    removedText: String(removedText),
    cwd: input?.cwd ?? null,
  };
}
