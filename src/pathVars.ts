// Global path variables such as {SELEC} / {DEST}: session-only values shared between the file panel and the terminal.
// Pure helpers (no React) so the rules are easy to read and test.

export type PathVarName = string;

// Values of the global variables, keyed by UPPER_CASE name (the definitions are in globalVars.ts).
// Each value is a list of absolute paths; a variable with no entry (or an empty list) is not set.
export type PathVars = Record<string, string[]>;

export const EMPTY_PATH_VARS: PathVars = {};

const trimSlashes = (p: string) => p.replace(/[\\/]+$/, '');
const fold = (p: string) => p.toLowerCase().replace(/\//g, '\\');

// Inside (or equal to) the current folder -> ".\sub\file" (or "."); anywhere else -> the absolute path.
export function displayPath(path: string, base: string): string {
  if (!base) return path;
  const b = fold(trimSlashes(base));
  const p = fold(trimSlashes(path));
  if (p === b) return '.';
  if (p.startsWith(b + '\\')) return '.\\' + trimSlashes(path).slice(trimSlashes(base).length + 1).replace(/\//g, '\\');
  return path;
}

const SAFE = /^[A-Za-z0-9_\-.\\/:~@+=,%#]+$/;

// Double quotes for PowerShell; $ and ` are escaped so a name like "a$b" stays literal.
export function quotePath(p: string): string {
  if (SAFE.test(p)) return p;
  return `"${p.replace(/[`$]/g, '`$&')}"`;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

// True when the text mentions one of the defined variables (set or not).
export function hasPlaceholder(text: string, names: string[]): boolean {
  const known = new Set(names.map((n) => n.toUpperCase()));
  for (const m of text.matchAll(PLACEHOLDER)) if (known.has(m[1].toUpperCase())) return true;
  return false;
}

// Filling the variables into a command (and the quoting rules) is done in Rust: src-tauri/src/cmdvars.rs.

// Right-click menu text: "." for the current folder, otherwise the shown path; "+N more" for several items.
export function summarizeValue(paths: string[], base: string): string {
  if (paths.length === 0) return '';
  const first = displayPath(paths[0], base);
  return paths.length > 1 ? `${first} (+${paths.length - 1} more)` : first;
}
