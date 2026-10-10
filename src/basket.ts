// Baskets (src-tauri/src/basket.rs): a `<name>.basket` file that holds links to files and folders anywhere.
// Helpers for showing them. Baskets in command placeholders are filled in by src-tauri/src/cmdvars.rs.

import { FileItem } from './types';

export const BASKET_EXT = 'basket';

export const isBasketPath = (p: string) => /\.basket$/i.test(p);
export const isBasket = (i: FileItem) => !i.is_dir && i.ext.toLowerCase() === BASKET_EXT;

/** "C:\x\Tax 2026.basket" -> "Tax 2026" */
export function basketName(path: string): string {
  const file = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return file.replace(/\.basket$/i, '');
}

/** What the file panel shows as the name: a basket without its extension. */
export const shownName = (i: FileItem) => (isBasket(i) ? basketName(i.name) : i.name);

/** A basket's own folder. */
export function parentDir(path: string): string {
  const k = path.replace(/[\\/]+$/, '').lastIndexOf('\\');
  if (k < 0) return path;
  const p = path.slice(0, k);
  return /^[A-Za-z]:$/.test(p) ? p + '\\' : p;
}

/** "3 links added, 1 was already in the basket" (+ what was skipped). */
export function addMessage(r: { added: number; already: number; refused: string[] }): string {
  const parts = [`${r.added} link${r.added === 1 ? '' : 's'} added`];
  if (r.already) parts.push(`${r.already} ${r.already === 1 ? 'was' : 'were'} already in the basket`);
  let msg = parts.join(', ') + '.';
  if (r.refused.length) msg += `\n\nSkipped:\n${r.refused.slice(0, 8).join('\n')}${r.refused.length > 8 ? '\n...' : ''}`;
  return msg;
}
