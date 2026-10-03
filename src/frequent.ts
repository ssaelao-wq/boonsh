// "Frequently Accessed" folders: how often each folder became the current folder. Pure helpers, no React.

export interface FrequentEntry {
  path: string; // as last seen (original letter case)
  count: number;
  last: number; // ms since 1970 of the latest visit; breaks ties between equal counts
}

export type FrequentStats = Record<string, FrequentEntry>; // keyed by keyOf(path)

export interface FrequentSettings {
  enabled: boolean; // show the panel (the counting goes on while it is hidden)
  count: number; // how many folders the panel lists
}

export const MIN_COUNT = 3;
export const MAX_COUNT = 10;
export const MAX_TRACKED = 300; // the least-used / oldest are forgotten beyond this
export const DEFAULT_SETTINGS: FrequentSettings = { enabled: true, count: MIN_COUNT };

const STATS_KEY = 'boonsh_frequent';
const SETTINGS_KEY = 'boonsh_frequent_settings';

/** Case-insensitive, no trailing slash ("C:\" and "c:" are the same folder). */
export const keyOf = (path: string) => path.toLowerCase().replace(/[\\/]+$/, '');

/** "D:\a\b\" -> "D:\a\b"; a drive root stays "C:\". */
function tidy(path: string): string {
  const p = path.replace(/[\\/]+$/, '');
  return /^[A-Za-z]:$/.test(p) ? p + '\\' : p;
}

/** The name shown in the panel: the last folder name, or the drive for a root. */
export function folderLabel(path: string): string {
  const p = tidy(path);
  if (/^[A-Za-z]:\\$/.test(p)) return p;
  const k = p.lastIndexOf('\\');
  return k >= 0 && k < p.length - 1 ? p.slice(k + 1) : p;
}

export function recordVisit(stats: FrequentStats, path: string, now = Date.now()): FrequentStats {
  const key = keyOf(path);
  if (!key) return stats;
  const prev = stats[key];
  const next: FrequentStats = { ...stats, [key]: { path: tidy(path), count: (prev?.count ?? 0) + 1, last: now } };
  const keys = Object.keys(next);
  if (keys.length > MAX_TRACKED) {
    keys
      .sort((a, b) => next[a].count - next[b].count || next[a].last - next[b].last)
      .slice(0, keys.length - MAX_TRACKED)
      .forEach((k) => delete next[k]);
  }
  return next;
}

/** Forget a folder: its count goes back to 0 and builds up again from the next visit. */
export function removeVisit(stats: FrequentStats, path: string): FrequentStats {
  const key = keyOf(path);
  if (!(key in stats)) return stats;
  const { [key]: _gone, ...rest } = stats;
  return rest;
}

/** The `n` most visited folders (ties: the most recent first). */
export function topFolders(stats: FrequentStats, n: number): FrequentEntry[] {
  return Object.values(stats)
    .sort((a, b) => b.count - a.count || b.last - a.last || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, n));
}

export function normalizeSettings(raw: any): FrequentSettings {
  const n = Number(raw?.count);
  return {
    enabled: raw?.enabled === false ? false : true,
    count: Number.isInteger(n) && n >= MIN_COUNT && n <= MAX_COUNT ? n : DEFAULT_SETTINGS.count,
  };
}

export function normalizeStats(raw: any): FrequentStats {
  const out: FrequentStats = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const e of Object.values(raw) as any[]) {
    if (e && typeof e.path === 'string' && e.path && Number.isFinite(e.count) && e.count > 0) {
      out[keyOf(e.path)] = { path: tidy(e.path), count: Math.floor(e.count), last: Number(e.last) || 0 };
    }
  }
  return out;
}

export function loadStats(): FrequentStats {
  try {
    return normalizeStats(JSON.parse(localStorage.getItem(STATS_KEY) || 'null'));
  } catch {
    return {};
  }
}

export function saveStats(s: FrequentStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: lasts for this session only
  }
}

export function loadSettings(): FrequentSettings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: FrequentSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: lasts for this session only
  }
}
