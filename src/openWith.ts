// "Open with" apps the user picked through boonsh, ranked by how often they were used.
// Pure helpers plus a small localStorage store (key `boonsh_open_with`).

export interface OpenWithApp {
  path: string; // full path of the exe
  name: string; // friendly name for the menu
  total: number; // times used for any file
  byExt: Record<string, number>; // times used per extension (lowercase, no dot)
}

export const OPEN_WITH_SHOWN = 3; // the menu lists at most this many apps
const KEY = 'boonsh_open_with';
const MAX_STORED = 30;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

export function loadOpenWith(): OpenWithApp[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((a) => a && typeof a.path === 'string' && typeof a.name === 'string')
      .map((a) => ({
        path: a.path,
        name: a.name,
        total: Number(a.total) || 0,
        byExt: a.byExt && typeof a.byExt === 'object' ? a.byExt : {},
      }));
  } catch {
    return [];
  }
}

export function saveOpenWith(apps: OpenWithApp[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(apps));
  } catch {
    /* storage unavailable: the list just is not remembered */
  }
}

/** Programs used for this file type, most used first (a type with no history gets none). */
export function topApps(apps: OpenWithApp[], ext: string, count = OPEN_WITH_SHOWN): OpenWithApp[] {
  const used = (a: OpenWithApp) => a.byExt[ext] ?? 0;
  return apps
    .filter((a) => used(a) > 0)
    .sort((x, y) => used(y) - used(x) || y.total - x.total || x.name.localeCompare(y.name))
    .slice(0, count);
}

/** Counts one use of `path` for `ext`; returns the new list (the least used entries drop off after MAX_STORED). */
export function recordUse(apps: OpenWithApp[], path: string, name: string, ext: string): OpenWithApp[] {
  const list = apps.map((a) => ({ ...a, byExt: { ...a.byExt } }));
  let app = list.find((a) => same(a.path, path));
  if (!app) {
    app = { path, name, total: 0, byExt: {} };
    list.push(app);
  }
  app.name = name || app.name;
  app.total += 1;
  if (ext) app.byExt[ext] = (app.byExt[ext] ?? 0) + 1;
  return list.sort((a, b) => b.total - a.total).slice(0, MAX_STORED);
}

export function removeApp(apps: OpenWithApp[], path: string): OpenWithApp[] {
  return apps.filter((a) => !same(a.path, path));
}
