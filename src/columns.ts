// File-panel columns and the multi-level ("smart") sort. Pure helpers, no React, so the rules are easy to read.
import type { FileItem, ItemDetails, SortOrder } from './types';

export type ColumnId =
  | 'name'
  | 'modified'
  | 'created'
  | 'ext'
  | 'size'
  | 'location'
  | 'dimensions'
  | 'length'
  | 'album'
  | 'artist'
  | 'actor'
  | 'genre'
  | 'rating';

export type DateMode = 'datetime' | 'date';
export type DateColumn = 'modified' | 'created';

export interface ColumnDef {
  id: ColumnId;
  label: string;
  width: number; // default width in px
  right?: boolean; // right-aligned (numbers)
  detail?: boolean; // read from the file's properties by the backend (see file_props.rs)
}

// Canonical order. "Name" is always first and always shown.
export const COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', width: 320 },
  { id: 'modified', label: 'Date Modified', width: 140 },
  { id: 'created', label: 'Date Created', width: 140 },
  { id: 'ext', label: 'Type', width: 200 },
  { id: 'size', label: 'Size', width: 90, right: true },
  { id: 'location', label: 'Location', width: 240 },
  { id: 'dimensions', label: 'Dimensions', width: 110, detail: true },
  { id: 'length', label: 'Length', width: 80, right: true, detail: true },
  { id: 'album', label: 'Album', width: 160, detail: true },
  { id: 'artist', label: 'Artist', width: 160, detail: true },
  { id: 'actor', label: 'Actor', width: 160, detail: true },
  { id: 'genre', label: 'Genre', width: 110, detail: true },
  { id: 'rating', label: 'Rating', width: 90, detail: true },
];

export const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<ColumnId, ColumnDef>;
export const DEFAULT_VISIBLE: ColumnId[] = ['name', 'modified', 'ext', 'size'];
export const isDateColumn = (id: ColumnId): id is DateColumn => id === 'modified' || id === 'created';
export const isDetailColumn = (id: ColumnId) => !!COLUMN_BY_ID[id]?.detail;

// ---------------------------------------------------------------- preferences

export interface ColumnPrefs {
  order: ColumnId[]; // every column, in display order ("name" first)
  visible: ColumnId[]; // the ones shown ("name" always included)
  dateShow: Record<DateColumn, DateMode>; // show the time too, or the date only
  dateSort: Record<DateColumn, DateMode>; // compare the time too, or the date only
  foldersFirst: boolean;
}

export const DEFAULT_PREFS: ColumnPrefs = {
  order: COLUMNS.map((c) => c.id),
  visible: [...DEFAULT_VISIBLE],
  dateShow: { modified: 'datetime', created: 'datetime' },
  dateSort: { modified: 'datetime', created: 'datetime' },
  foldersFirst: true,
};

const PREFS_KEY = 'boonsh_columns';
const SORT_KEY = 'boonsh_sort';
const ALL_IDS = new Set<string>(COLUMNS.map((c) => c.id));
const asMode = (v: unknown): DateMode => (v === 'date' ? 'date' : 'datetime');

export function normalizePrefs(raw: any): ColumnPrefs {
  const d = DEFAULT_PREFS;
  try {
    const seen = new Set<ColumnId>();
    const order: ColumnId[] = [];
    for (const id of Array.isArray(raw?.order) ? raw.order : []) {
      if (ALL_IDS.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    // columns added in a later version go to the end; "name" is always first
    for (const c of COLUMNS) if (!seen.has(c.id)) order.push(c.id);
    order.splice(order.indexOf('name'), 1);
    order.unshift('name');

    const visible: ColumnId[] = Array.isArray(raw?.visible)
      ? order.filter((id) => id === 'name' || raw.visible.includes(id))
      : [...d.visible];
    return {
      order,
      visible,
      dateShow: { modified: asMode(raw?.dateShow?.modified), created: asMode(raw?.dateShow?.created) },
      dateSort: { modified: asMode(raw?.dateSort?.modified), created: asMode(raw?.dateSort?.created) },
      foldersFirst: raw?.foldersFirst === false ? false : true,
    };
  } catch {
    return { ...d, order: [...d.order], visible: [...d.visible] };
  }
}

export function loadPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function savePrefs(p: ColumnPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable: lasts for this session only
  }
}

/** The shown columns, in display order. */
export function visibleColumns(p: ColumnPrefs): ColumnDef[] {
  return p.order.filter((id) => p.visible.includes(id)).map((id) => COLUMN_BY_ID[id]);
}

// ---------------------------------------------------------------- sort levels

export interface SortLevel {
  column: ColumnId;
  order: SortOrder;
}

export const DEFAULT_SORT: SortLevel[] = [{ column: 'name', order: 'asc' }];

export function loadSort(): SortLevel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (!Array.isArray(raw)) return [...DEFAULT_SORT];
    const seen = new Set<string>();
    const out: SortLevel[] = [];
    for (const l of raw) {
      if (l && ALL_IDS.has(l.column) && !seen.has(l.column)) {
        seen.add(l.column);
        out.push({ column: l.column, order: l.order === 'desc' ? 'desc' : 'asc' });
      }
    }
    return out.length ? out : [...DEFAULT_SORT];
  } catch {
    return [...DEFAULT_SORT];
  }
}

export function saveSort(levels: SortLevel[]) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(levels));
  } catch {
    // storage unavailable: lasts for this session only
  }
}

const flip = (o: SortOrder): SortOrder => (o === 'asc' ? 'desc' : 'asc');
const orDefault = (l: SortLevel[]) => (l.length ? l : [...DEFAULT_SORT]);

/**
 * A click on a column header.
 * Plain click: sort by this column alone (a second click flips the direction), like Explorer.
 * Shift/Ctrl+click: add it as the next level; click again to flip it, once more to take it out.
 */
export function sortClick(levels: SortLevel[], col: ColumnId, additive: boolean): SortLevel[] {
  const i = levels.findIndex((l) => l.column === col);
  if (!additive) {
    if (levels.length === 1 && i === 0) return [{ column: col, order: flip(levels[0].order) }];
    return [{ column: col, order: 'asc' }];
  }
  if (i < 0) return [...levels, { column: col, order: 'asc' }];
  if (levels[i].order === 'asc') return levels.map((l, k) => (k === i ? { ...l, order: 'desc' } : l));
  return orDefault(levels.filter((_, k) => k !== i));
}

/** From the header menu: sort by this column alone, or make it a level (keeping its place if it has one). */
export function sortSet(levels: SortLevel[], col: ColumnId, order: SortOrder, mode: 'only' | 'then'): SortLevel[] {
  if (mode === 'only') return [{ column: col, order }];
  const i = levels.findIndex((l) => l.column === col);
  if (i < 0) return [...levels, { column: col, order }];
  return levels.map((l, k) => (k === i ? { ...l, order } : l));
}

export function sortRemove(levels: SortLevel[], col: ColumnId): SortLevel[] {
  return orDefault(levels.filter((l) => l.column !== col));
}

// ---------------------------------------------------------------- comparing

/** Used for sorting: stable, so the order does not change when the default apps arrive. */
export const typeLabel = (i: FileItem) => (i.is_dir ? 'File Folder' : i.ext.toUpperCase() || 'File');

/**
 * What the Type column shows: "MP4 (VLC media player)", or "ENV File (-)" when nothing opens that type.
 * `apps` maps a lowercase extension to its default app ('' = none); until it is known only "MP4" is shown.
 */
export function typeText(i: FileItem, apps?: Record<string, string>): string {
  if (i.is_dir) return 'File Folder';
  const ext = i.ext.toLowerCase();
  if (!ext) return 'File (-)';
  const app = apps?.[ext];
  if (app === undefined) return ext.toUpperCase();
  return app ? `${ext.toUpperCase()} (${app})` : `${ext.toUpperCase()} File (-)`;
}

export function parentOf(path: string): string {
  const k = path.lastIndexOf('\\');
  if (k < 0) return '';
  const p = path.slice(0, k);
  return /^[A-Za-z]:$/.test(p) ? p + '\\' : p; // "C:" -> "C:\"
}

export const detailKey = (i: FileItem) => `${i.path}|${i.modified_timestamp}`;

/** What a column holds for an item, as the text shown in the table. */
export function cellText(col: ColumnId, i: FileItem, p: ColumnPrefs, d?: ItemDetails, apps?: Record<string, string>): string {
  switch (col) {
    case 'name':
      return i.name;
    case 'modified':
      return p.dateShow.modified === 'date' ? i.modified.slice(0, 10) : i.modified;
    case 'created':
      return p.dateShow.created === 'date' ? i.created.slice(0, 10) : i.created;
    case 'ext':
      return typeText(i, apps);
    case 'size':
      return i.size_formatted;
    case 'location':
      return parentOf(i.path);
    case 'dimensions':
      return d?.dimensions ?? '';
    case 'length':
      return d?.length ?? '';
    case 'album':
      return d?.album ?? '';
    case 'artist':
      return d?.artist ?? '';
    case 'actor':
      return d?.actor ?? '';
    case 'genre':
      return d?.genre ?? '';
    case 'rating':
      return d && d.rating > 0 ? '★'.repeat(d.rating) + '☆'.repeat(5 - d.rating) : '';
  }
}

// null = the item has nothing in this column; those always sort last, in either direction
type SortValue = string | number | null;

function sortValue(col: ColumnId, i: FileItem, p: ColumnPrefs, d?: ItemDetails): SortValue {
  const text = (s: string | undefined) => (s ? s : null);
  const num = (n: number | undefined) => (n ? n : null);
  switch (col) {
    case 'name':
      return i.name;
    case 'ext':
      return typeLabel(i);
    case 'size':
      return i.size;
    case 'modified':
      return p.dateSort.modified === 'date' ? text(i.modified.slice(0, 10)) : num(i.modified_timestamp);
    case 'created':
      return p.dateSort.created === 'date' ? text(i.created.slice(0, 10)) : num(i.created_timestamp);
    case 'location':
      return parentOf(i.path);
    case 'dimensions':
      return num(d?.pixels);
    case 'length':
      return num(d?.length_secs);
    case 'rating':
      return num(d?.rating);
    case 'album':
      return text(d?.album);
    case 'artist':
      return text(d?.artist);
    case 'actor':
      return text(d?.actor);
    case 'genre':
      return text(d?.genre);
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareValues(a: SortValue, b: SortValue, order: SortOrder): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return order === 'asc' ? r : -r;
}

/** Folders first (when asked), then each level in turn, then the name so the order never jumps around. */
export function compareItems(
  a: FileItem,
  b: FileItem,
  levels: SortLevel[],
  prefs: ColumnPrefs,
  details: Record<string, ItemDetails>
): number {
  if (prefs.foldersFirst && a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
  const da = details[detailKey(a)];
  const db = details[detailKey(b)];
  for (const l of levels) {
    const r = compareValues(sortValue(l.column, a, prefs, da), sortValue(l.column, b, prefs, db), l.order);
    if (r !== 0) return r;
  }
  return collator.compare(a.name, b.name);
}

// ---------------------------------------------------------------- detail fetching

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'ico'];
const VIDEO = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'flv', 'mpg', 'mpeg', '3gp'];
const AUDIO = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'];
const MEDIA = new Set([...IMAGE, ...VIDEO, ...AUDIO]);

/** Only these files are asked for properties; the rest would just come back empty. */
export const hasMediaProps = (i: FileItem) => !i.is_dir && MEDIA.has(i.ext.toLowerCase());

/** True when a shown column or a sort level needs the file properties. */
export function needsDetails(prefs: ColumnPrefs, levels: SortLevel[]): boolean {
  return (
    visibleColumns(prefs).some((c) => c.detail) || levels.some((l) => isDetailColumn(l.column))
  );
}
