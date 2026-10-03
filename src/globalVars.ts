// Definitions of the global variables ({SELEC}, {DEST}, and the user's own). Only the definitions are saved;
// the values (paths) live in memory in App.tsx and are gone when the app closes.

export type VarTakes = 'selection' | 'item';

export interface GlobalVarDef {
  id: string;
  name: string; // UPPER_CASE, used as {NAME} in commands
  takes: VarTakes; // 'selection' = every selected item, 'item' = only the right-clicked one
  description: string;
}

const STORAGE_KEY = 'boonsh_global_vars';

export const DEFAULT_GLOBAL_VARS: GlobalVarDef[] = [
  { id: 'var-selec', name: 'SELEC', takes: 'selection', description: 'Input files / folders' },
  { id: 'var-dest', name: 'DEST', takes: 'item', description: 'Destination file / folder' },
];

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_NAME_LENGTH = 30;

export const newVarId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `var-${crypto.randomUUID()}`
    : `var-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const cloneDefaults = (): GlobalVarDef[] => DEFAULT_GLOBAL_VARS.map((v) => ({ ...v }));

// Returns an error message for a bad name, or '' when it is fine. `ignoreId` is the variable being edited.
export function validateVarName(name: string, defs: GlobalVarDef[], ignoreId?: string): string {
  const n = name.trim();
  if (!n) return 'Name is required.';
  if (n.length > MAX_NAME_LENGTH) return `Name can be at most ${MAX_NAME_LENGTH} characters.`;
  if (!NAME_PATTERN.test(n)) return 'Use letters, digits and _ only, and start with a letter or _.';
  if (defs.some((d) => d.id !== ignoreId && d.name.toUpperCase() === n.toUpperCase())) {
    return `A variable named {${n.toUpperCase()}} already exists.`;
  }
  return '';
}

export function loadGlobalVars(): GlobalVarDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return cloneDefaults();
    const seen = new Set<string>();
    const out: GlobalVarDef[] = [];
    for (const v of saved) {
      if (!v || typeof v.name !== 'string' || !NAME_PATTERN.test(v.name)) continue;
      const name = v.name.toUpperCase();
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        id: typeof v.id === 'string' ? v.id : newVarId(),
        name,
        takes: v.takes === 'selection' ? 'selection' : 'item',
        description: typeof v.description === 'string' ? v.description : '',
      });
    }
    return out;
  } catch {
    return cloneDefaults();
  }
}

export function saveGlobalVars(defs: GlobalVarDef[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defs));
  } catch {
    // Storage unavailable: changes last for this session only
  }
}

export function resetGlobalVars(): GlobalVarDef[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  return cloneDefaults();
}

// Replace {OLD} with {NEW} (any letter case) in command text; used when a variable is renamed.
export function renameInText(text: string, from: string, to: string): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => (n.toUpperCase() === from.toUpperCase() ? `{${to}}` : m));
}
