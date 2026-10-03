// Quick Access rules (the bar above the folder tree). Pure helpers, no React.
import type { QuickAccessItem } from './types';

export const QA_MAX = 6; // the bar holds at most this many items
export const QA_KEY = 'boonsh_quick_access';

export const samePath = (a: string, b: string) =>
  a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');

/**
 * What the bar shows on first start: Home, Desktop, Downloads, Documents and the C: drive.
 * `all` is the list from the backend (those four folders, then every drive).
 */
export function defaultQuickAccess(all: QuickAccessItem[]): QuickAccessItem[] {
  const pick = (type: string) => all.find((i) => i.icon_type === type);
  const drives = all.filter((i) => i.icon_type === 'drive');
  const c = drives.find((d) => samePath(d.path, 'C:\\')) ?? drives[0];
  return [pick('home'), pick('desktop'), pick('downloads'), pick('documents'), c].filter(
    (i): i is QuickAccessItem => !!i
  );
}

/**
 * The rows of the Settings list: the C: drive, Home, Desktop, Downloads, Documents, the other drives, then any
 * folders the user added with right-click, Add to Quick Access (those are in the bar but are not built in).
 */
export function settingsRows(candidates: QuickAccessItem[], shown: QuickAccessItem[]): QuickAccessItem[] {
  const drives = candidates.filter((i) => i.icon_type === 'drive');
  const c = drives.find((d) => samePath(d.path, 'C:\\')) ?? drives[0];
  const folders = ['home', 'desktop', 'downloads', 'documents']
    .map((t) => candidates.find((i) => i.icon_type === t))
    .filter((i): i is QuickAccessItem => !!i);
  const rows = [...(c ? [c] : []), ...folders, ...drives.filter((d) => d !== c)];
  const custom = shown.filter((s) => !rows.some((r) => samePath(r.path, s.path)));
  return [...rows, ...custom];
}

export const isShown = (shown: QuickAccessItem[], item: QuickAccessItem) =>
  shown.some((s) => samePath(s.path, item.path));

/** What is saved: a list (also an empty one, when the user turned everything off), or null when nothing is. */
export function parseSaved(raw: string | null): QuickAccessItem[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v
      .filter((i) => i && typeof i.path === 'string' && typeof i.label === 'string')
      .map((i) => ({ label: i.label, path: i.path, icon_type: typeof i.icon_type === 'string' ? i.icon_type : 'folder' }))
      .slice(0, QA_MAX);
  } catch {
    return null;
  }
}
