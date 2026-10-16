// Folder sizes (everything inside, all sub-folders) measured in the background by folder_size.rs and reported
// through the `folder-size` event. Pure helpers; the state lives in App.tsx.

export interface FolderTotals {
  size: number;
  files: number;
  folders: number;
}

/** The backend's cache key: lower case, `\` only, no trailing `\`. */
export const sizeKey = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The same text as a file's size in the Size column (fs_ops.rs `format_size`). */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "12.3%" of `whole`; very small shares show as "<0.1%". Null when there is nothing to compare with. */
export function percentOf(part: number, whole: number): string | null {
  if (!(whole > 0)) return null;
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

/** The last name of a path, for "12.3% of Users" (a drive shows as "C:"). */
export function lastName(path: string): string {
  const parts = path.replace(/\\+$/, '').split('\\');
  return parts[parts.length - 1] || path;
}
