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

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Whitespace-separated tokens of a template, keeping quoted spans together, with their whitespace.
function splitTokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let wasSpace: boolean | null = null;
  for (const ch of text) {
    if (!quote && /\s/.test(ch)) {
      if (wasSpace === false) {
        out.push(cur);
        cur = '';
      }
      cur += ch;
      wasSpace = true;
      continue;
    }
    if (wasSpace === true) {
      out.push(cur);
      cur = '';
    }
    wasSpace = false;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// True when the text mentions one of the defined variables (set or not).
export function hasPlaceholder(text: string, names: string[]): boolean {
  const known = new Set(names.map((n) => n.toUpperCase()));
  for (const m of text.matchAll(PLACEHOLDER)) if (known.has(m[1].toUpperCase())) return true;
  return false;
}

// Expand {NAME} variables that have a value; unset or unknown ones stay as typed so the user can see them.
// A token that is exactly {SELEC} becomes one quoted path per selected item. A path embedded in a larger
// token ("{DEST}/a.jpg") is substituted, then the whole token is quoted if it needs it. If the user already
// wrote quotes around the token, values are inserted as-is.
// CONST variables (`consts`, NAME -> text) are filled in as written, never quoted or made relative.
export function expandTemplate(
  template: string,
  vars: PathVars,
  base: string,
  consts: Record<string, string> = {}
): string {
  const constOf = (name: string): string | undefined => consts[name.toUpperCase()];
  const valueOf = (name: string) => (vars[name.toUpperCase()] ?? []).map((p) => displayPath(p, base));

  return splitTokens(template)
    .map((tok) => {
      if (!tok.includes('{')) return tok;
      const exact = tok.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (exact) {
        const c = constOf(exact[1]);
        if (c !== undefined) return c;
        const vals = valueOf(exact[1]);
        return vals.length ? vals.map(quotePath).join(' ') : tok;
      }
      let changed = false;
      let out = tok.replace(PLACEHOLDER, (m, name) => {
        const c = constOf(name);
        if (c !== undefined) return c;
        const vals = valueOf(name);
        if (!vals.length) return m;
        changed = true;
        return vals.join(' ');
      });
      if (changed && !/["']/.test(out) && !SAFE.test(out)) out = quotePath(out);
      return out;
    })
    .join('');
}

// Right-click menu text: "." for the current folder, otherwise the shown path; "+N more" for several items.
export function summarizeValue(paths: string[], base: string): string {
  if (paths.length === 0) return '';
  const first = displayPath(paths[0], base);
  return paths.length > 1 ? `${first} (+${paths.length - 1} more)` : first;
}
