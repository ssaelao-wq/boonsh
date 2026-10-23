/** How long ago a file or folder was last modified: today, within 30 days, older, over a year. Shared by the
 * folder tree (every level gets a colour, carried up from its freshest descendant; see FolderTree.tsx) and the
 * file panel (today only, to match a folder's row to its tree colour; see MainFilePanel.tsx `getFileIcon`). */
export type FileAge = 'today' | 'recent' | 'old' | 'ancient';
export function fileAge(modifiedSecs: number | undefined, now = new Date()): FileAge {
  if (!modifiedSecs) return 'recent'; // not known (e.g. a drive's own folder, in the tree): the usual yellow
  const d = new Date(modifiedSecs * 1000);
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return 'today';
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days > 365) return 'ancient';
  if (days > 30) return 'old';
  return 'recent';
}

/** Local midnight today, in seconds: a date at or after it counts as today (the `since` of `tree_newest`). */
export const startOfToday = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

/** Whether something was modified today (local date), the only tier the file panel colours. */
export const isToday = (modifiedSecs: number | undefined, now = new Date()): boolean => fileAge(modifiedSecs, now) === 'today';
