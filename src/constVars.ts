// CONST global variables: a name with a fixed text value, written {NAME} in commands (for example {IP} =
// 202.283.242.97). Unlike the path variables of globalVars.ts, both the definition and the value are saved and stay
// until the user deletes them.

export interface ConstVar {
  id: string;
  name: string; // UPPER_CASE, used as {NAME} in commands
  value: string; // the text typed in place of {NAME}
  description: string;
}

const STORAGE_KEY = 'boonsh_const_vars';

export const newConstId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `const-${crypto.randomUUID()}`
    : `const-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function loadConstVars(): ConstVar[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const seen = new Set<string>();
    const out: ConstVar[] = [];
    for (const v of saved) {
      if (!v || typeof v.name !== 'string' || typeof v.value !== 'string') continue;
      const name = v.name.toUpperCase();
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({
        id: typeof v.id === 'string' ? v.id : newConstId(),
        name,
        value: v.value,
        description: typeof v.description === 'string' ? v.description : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveConstVars(defs: ConstVar[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defs));
  } catch {
    // Storage unavailable: changes last for this session only
  }
}

// NAME -> value, the shape expandTemplate takes
export const constMap = (defs: ConstVar[]): Record<string, string> =>
  Object.fromEntries(defs.map((d) => [d.name, d.value]));
