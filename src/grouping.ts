// Group view for the file panel: header rows ("September 2026", "Images" ...) over the files. Pure helpers.
//
// Grouping is separate from sorting. A column is grouped by "buckets" (Month, Year, File category ...). For the
// date columns several can be ticked and they are combined in the order they were ticked: Year then Month gives
// "2026 May", Month then Year gives "May 2026". The
// layers go in the order of the sort numbers shown in the column headers (a grouped column that is not part of
// the sort comes after the sorted ones). Each layer lists its groups in that column's sort direction; inside the
// innermost group the normal sort decides the order.
import type { FileItem, ItemDetails, SortOrder } from './types';
import { type ColumnId, type ColumnPrefs, COLUMNS, type SortLevel, compareItems, detailKey, parentOf } from './columns';

export type Bucket =
  | 'relative'
  | 'year'
  | 'month'
  | 'week'
  | 'day'
  | 'category'
  | 'extension'
  | 'size'
  | 'letter'
  | 'folder'
  | 'megapixels'
  | 'duration'
  | 'value'
  | 'stars';

export interface GroupSpec {
  column: ColumnId;
  buckets: Bucket[]; // at least one; for the date columns the order of the parts that make up the group name
}

/** The date parts that can be combined (in any order); 'relative' stands alone. */
export const DATE_PARTS: Bucket[] = ['year', 'month', 'week', 'day'];
const isDateColumn = (c: ColumnId) => c === 'modified' || c === 'created';

/**
 * The buckets after a click on `b` in the "Group by" list. Dates: the parts add up in the order ticked and a
 * second click takes one off; Relative date replaces them. Other columns: one choice at a time.
 * An empty result means "stop grouping this column".
 */
export function toggleBucket(col: ColumnId, current: Bucket[] | undefined, b: Bucket): Bucket[] {
  const cur = current ?? [];
  if (!isDateColumn(col) || b === 'relative') return cur.includes(b) ? [] : [b];
  const parts = cur.filter((x) => x !== 'relative');
  return parts.includes(b) ? parts.filter((x) => x !== b) : [...parts, b];
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  relative: 'Relative date (Today, Yesterday ...)',
  year: 'Year',
  month: 'Month',
  week: 'Week',
  day: 'Day',
  category: 'File category (Images, Videos ...)',
  extension: 'File type (each extension)',
  size: 'Size range',
  letter: 'First letter',
  folder: 'Folder',
  megapixels: 'Megapixels',
  duration: 'Duration',
  value: 'Each value',
  stars: 'Stars',
};

/** The ways each column can be grouped, in menu order. */
/** An example of what a bucket shows, for the menu tooltips. */
export const BUCKET_EXAMPLE: Partial<Record<Bucket, string>> = {
  year: '2026',
  month: 'May',
  week: 'Week 40',
  day: '12',
};

export const BUCKETS: Record<ColumnId, Bucket[]> = {
  name: ['letter'],
  modified: ['year', 'month', 'week', 'day', 'relative'],
  created: ['year', 'month', 'week', 'day', 'relative'],
  ext: ['category', 'extension'],
  size: ['size'],
  location: ['folder'],
  dimensions: ['megapixels'],
  length: ['duration'],
  album: ['value'],
  artist: ['value'],
  actor: ['value'],
  genre: ['value'],
  rating: ['stars'],
};

// ---------------------------------------------------------------- group keys

export interface GroupKey {
  id: string; // identifies the group (also what "collapsed" remembers)
  label: string;
  sort: string | number; // how groups of this layer are ordered
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');

function ymd(s: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
const mondayOf = (y: number, m: number, d: number) => {
  const dn = dayNum(y, m, d);
  return dn - ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7);
};

export function todayParts(now = new Date()): [number, number, number] {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()];
}

const RELATIVE = ['Today', 'Yesterday', 'Earlier this week', 'Last week', 'Earlier this month', 'Last month', 'Earlier this year', 'A long time ago'];

function relativeRank(item: [number, number, number], today: [number, number, number]): number {
  const dn = dayNum(...item);
  const t = dayNum(...today);
  if (dn >= t) return 0;
  if (dn === t - 1) return 1;
  const monday = mondayOf(...today);
  if (dn >= monday) return 2;
  if (dn >= monday - 7) return 3;
  const [y, m] = item;
  if (y === today[0] && m === today[1]) return 4;
  const prev = today[1] === 1 ? [today[0] - 1, 12] : [today[0], today[1] - 1];
  if (y === prev[0] && m === prev[1]) return 5;
  if (y === today[0]) return 6;
  return 7;
}

const CATEGORY: Record<string, string[]> = {
  Images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw', 'psd'],
  Videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'flv', 'mpg', 'mpeg', '3gp'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'odt', 'ods', 'odp', 'csv'],
  Archives: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'cab', 'iso'],
  Code: ['rs', 'js', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'json', 'toml', 'yaml', 'yml', 'html', 'css', 'c', 'cpp', 'h', 'cs', 'java', 'go', 'sh', 'bat'],
};
const CATEGORY_ORDER = ['Folders', 'Images', 'Videos', 'Audio', 'Documents', 'Archives', 'Code', 'Other'];
const CATEGORY_OF = new Map<string, string>();
for (const [cat, exts] of Object.entries(CATEGORY)) for (const e of exts) CATEGORY_OF.set(e, cat);

export const categoryOf = (i: FileItem) => (i.is_dir ? 'Folders' : CATEGORY_OF.get(i.ext.toLowerCase()) ?? 'Other');

const KB = 1024;
const SIZES: [number, string][] = [
  [1, 'Empty (0 bytes)'],
  [10 * KB, 'Tiny (under 10 KB)'],
  [KB * KB, 'Small (10 KB to 1 MB)'],
  [100 * KB * KB, 'Medium (1 to 100 MB)'],
  [KB * KB * KB, 'Large (100 MB to 1 GB)'],
  [Infinity, 'Huge (1 GB and more)'],
];

const MEGAPIXELS: [number, string][] = [
  [1e6, 'Under 1 MP'],
  [4e6, '1 to 4 MP'],
  [12e6, '4 to 12 MP'],
  [24e6, '12 to 24 MP'],
  [Infinity, '24 MP and more'],
];

const DURATIONS: [number, string][] = [
  [60, 'Under 1 minute'],
  [300, '1 to 5 minutes'],
  [1800, '5 to 30 minutes'],
  [3600, '30 to 60 minutes'],
  [Infinity, 'Over 1 hour'],
];

const fromTable = (t: [number, string][], v: number): GroupKey => {
  const k = t.findIndex(([max]) => v < max);
  return { id: `b${k}`, label: t[k][1], sort: k };
};

const baseName = (i: FileItem) => i.path.slice(i.path.lastIndexOf('\\') + 1);

/** The group an item belongs to for one column + bucket, or null when it has no value there. */
export function groupKey(
  col: ColumnId,
  buckets: Bucket[],
  i: FileItem,
  d: ItemDetails | undefined,
  today: [number, number, number]
): GroupKey | null {
  const bucket = buckets[0];
  switch (bucket) {
    case 'relative':
    case 'year':
    case 'month':
    case 'week':
    case 'day': {
      const p = ymd(col === 'created' ? i.created : i.modified);
      if (!p) return null;
      if (bucket === 'relative') {
        const r = relativeRank(p, today);
        return { id: `r${r}`, label: RELATIVE[r], sort: -r }; // ascending = oldest first
      }
      return datePartsKey(buckets, p);
    }
    case 'category': {
      const c = categoryOf(i);
      return { id: c, label: c, sort: CATEGORY_ORDER.indexOf(c) };
    }
    case 'extension': {
      if (i.is_dir) return { id: 'folders', label: 'Folders', sort: '' };
      const e = i.ext.toLowerCase();
      return e ? { id: `e.${e}`, label: e.toUpperCase(), sort: e } : { id: 'noext', label: 'No extension', sort: '~' };
    }
    case 'size': {
      if (i.is_dir && i.size === 0) return null;
      return fromTable(SIZES, i.size);
    }
    case 'letter': {
      const ch = (baseName(i).normalize('NFD')[0] ?? '#').toUpperCase();
      if (/[0-9]/.test(ch)) return { id: '0-9', label: '0-9', sort: '1' };
      if (/\p{L}/u.test(ch)) return { id: ch, label: ch, sort: '2' + ch };
      return { id: '#', label: '#', sort: '0' };
    }
    case 'folder': {
      const p = parentOf(i.path);
      return p ? { id: p.toLowerCase(), label: p, sort: p.toLowerCase() } : null;
    }
    case 'megapixels':
      return d && d.pixels > 0 ? fromTable(MEGAPIXELS, d.pixels) : null;
    case 'duration':
      return d && d.length_secs > 0 ? fromTable(DURATIONS, d.length_secs) : null;
    case 'stars': {
      const r = d?.rating ?? 0;
      return r > 0 ? { id: `s${r}`, label: '★'.repeat(r) + '☆'.repeat(5 - r) + ` (${r} star${r === 1 ? '' : 's'})`, sort: r } : null;
    }
    case 'value': {
      const v = col === 'album' ? d?.album : col === 'artist' ? d?.artist : col === 'actor' ? d?.actor : col === 'genre' ? d?.genre : '';
      return v ? { id: v.toLowerCase(), label: v, sort: v.toLowerCase() } : null;
    }
  }
}

// ---------------------------------------------------------------- date parts

/** ISO 8601 week: [the year the week belongs to, week number 1..53]. Weeks start on Monday. */
export function isoWeek(y: number, m: number, d: number): [number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3); // the Thursday of this week
  const isoYear = dt.getUTCFullYear();
  const first = new Date(Date.UTC(isoYear, 0, 4)); // 4 January is always in week 1
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7) + 3);
  return [isoYear, 1 + Math.round((dt.getTime() - first.getTime()) / (7 * 86_400_000))];
}

/**
 * One group name made of the ticked parts in the order they were ticked: [year, month] -> "2026 May",
 * [month, year] -> "May 2026", [month] -> "May" (the same month of every year). Groups are ordered by the parts
 * in that same order, so [month, year] lists all the Mays (by year) before the Junes.
 */
function datePartsKey(parts: Bucket[], p: [number, number, number]): GroupKey {
  const [y, m, d] = p;
  const [isoYear, week] = isoWeek(y, m, d);
  const many = parts.length > 1;
  const id: string[] = [];
  const label: string[] = [];
  const sort: string[] = [];
  for (const part of parts) {
    if (part === 'year') {
      const yy = parts.includes('week') ? isoYear : y; // a week belongs to its ISO year
      id.push(`y${yy}`);
      label.push(`${yy}`);
      sort.push(String(yy).padStart(4, '0'));
    } else if (part === 'month') {
      id.push(`m${m}`);
      label.push(MONTHS[m - 1]);
      sort.push(pad(m));
    } else if (part === 'week') {
      id.push(`w${week}`);
      label.push(`Week ${week}`);
      sort.push(pad(week));
    } else if (part === 'day') {
      id.push(`d${d}`);
      label.push(many ? `${d}` : `Day ${d}`);
      sort.push(pad(d));
    }
  }
  return { id: id.join('.'), label: label.join(' '), sort: sort.join('|') };
}

// ---------------------------------------------------------------- layout

/**
 * One line per innermost group, written as the path through the layers: "2026 July > CSV". When a group higher up
 * is collapsed, the line stands for that whole group and ends at it: "2026 July" (shown with a down arrow).
 */
export interface GroupHeader {
  kind: 'group';
  id: string; // the group this line stands for: the last of `ids`
  depth: number; // its layer, 0 = outermost; labels.length - 1
  labels: string[]; // the group names from the outermost layer down to this one
  ids: string[]; // the group id of each of those layers (what a click on its ">" collapses)
  count: number; // files and folders in the group, also while it is collapsed
  bytes: number; // total size of the files in it
  collapsed: boolean;
}
export interface ItemRow {
  kind: 'item';
  item: FileItem;
}
export type Row = GroupHeader | ItemRow;

export interface Layout {
  rows: Row[]; // what the Details view draws
  flat: FileItem[]; // the items in view order, without those hidden in a collapsed group
}

const SEP = '\u0001';
const NONE_ID = '\u0000none';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Layers in the order of the sort numbers; a grouped column outside the sort comes after the sorted ones. */
export function orderedGroups(groups: GroupSpec[], levels: SortLevel[]): { spec: GroupSpec; order: SortOrder }[] {
  const canon = (c: ColumnId) => COLUMNS.findIndex((x) => x.id === c);
  return groups
    .map((spec) => {
      const i = levels.findIndex((l) => l.column === spec.column);
      return { spec, order: (i >= 0 ? levels[i].order : 'asc') as SortOrder, rank: i >= 0 ? i : 1000 + canon(spec.column) };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ spec, order }) => ({ spec, order }));
}

export function layoutItems(
  items: FileItem[],
  groups: GroupSpec[],
  levels: SortLevel[],
  prefs: ColumnPrefs,
  details: Record<string, ItemDetails>,
  collapsed: Set<string>,
  today = todayParts()
): Layout {
  const plain = () => {
    const flat = [...items].sort((a, b) => compareItems(a, b, levels, prefs, details));
    return { rows: flat.map((item): Row => ({ kind: 'item', item })), flat };
  };
  if (groups.length === 0 || items.length === 0) return plain();

  // the key of every item in every layer
  let layers = orderedGroups(groups, levels);
  let keys: (GroupKey | null)[][] = items.map((it) => {
    const d = details[detailKey(it)];
    return layers.map((l) => groupKey(l.spec.column, l.spec.buckets, it, d, today));
  });
  // a layer with a single group would only add an empty-looking header: leave it out
  const keep = layers.map((_, k) => new Set(keys.map((row) => row[k]?.id ?? NONE_ID)).size > 1);
  if (!keep.some(Boolean)) return plain();
  layers = layers.filter((_, k) => keep[k]);
  keys = keys.map((row) => row.filter((_, k) => keep[k]));
  // a column that became a layer has done its sorting job: inside the groups only the other sort levels apply
  const inner = levels.filter((l) => !layers.some((g) => g.spec.column === l.column));

  const idx = items.map((_, n) => n);
  idx.sort((a, b) => {
    for (let k = 0; k < layers.length; k++) {
      const ka = keys[a][k];
      const kb = keys[b][k];
      if (!ka || !kb) {
        if (ka || kb) return ka ? -1 : 1; // no value: last, whatever the direction
        continue;
      }
      const r =
        typeof ka.sort === 'number' && typeof kb.sort === 'number' ? ka.sort - kb.sort : collator.compare(String(ka.sort), String(kb.sort));
      if (r !== 0) return layers[k].order === 'asc' ? r : -r;
    }
    return compareItems(items[a], items[b], inner, prefs, details);
  });

  const pathIds = (n: number) => {
    const out: string[] = [];
    let acc = '';
    keys[n].forEach((k) => {
      acc = acc === '' ? (k?.id ?? NONE_ID) : acc + SEP + (k?.id ?? NONE_ID);
      out.push(acc);
    });
    return out;
  };
  const stats = new Map<string, { count: number; bytes: number }>();
  const paths = items.map((_, n) => pathIds(n));
  idx.forEach((n) => {
    for (const id of paths[n]) {
      const s = stats.get(id) ?? { count: 0, bytes: 0 };
      s.count++;
      if (!items[n].is_dir) s.bytes += items[n].size;
      stats.set(id, s);
    }
  });

  const header = (n: number, depth: number): GroupHeader => {
    const s = stats.get(paths[n][depth])!;
    return {
      kind: 'group',
      id: paths[n][depth],
      depth,
      labels: keys[n].slice(0, depth + 1).map((k) => k?.label ?? '(none)'),
      ids: paths[n].slice(0, depth + 1),
      count: s.count,
      bytes: s.bytes,
      collapsed: collapsed.has(paths[n][depth]),
    };
  };
  const rows: Row[] = [];
  const flat: FileItem[] = [];
  let last = ''; // the group the previous line stood for
  for (const n of idx) {
    const path = paths[n];
    const c = path.findIndex((id) => collapsed.has(id)); // the highest collapsed group this item sits in
    if (c >= 0) {
      if (last !== path[c]) {
        last = path[c];
        rows.push(header(n, c)); // one line for the whole collapsed group
      }
      continue;
    }
    const leaf = path[path.length - 1];
    if (last !== leaf) {
      last = leaf;
      rows.push(header(n, path.length - 1));
    }
    rows.push({ kind: 'item', item: items[n] });
    flat.push(items[n]);
  }
  return { rows, flat };
}

/**
 * The files of the group at `level` of a header line ("2026 July" is level 0 of "2026 July > CSV"): every file
 * shown in the lines that belong to that same group. Empty for a level the line does not have (or a collapsed one).
 */
export function itemsInGroup(rows: Row[], headerIndex: number, level: number): FileItem[] {
  const head = rows[headerIndex];
  if (!head || head.kind !== 'group' || level >= head.ids.length || head.collapsed) return [];
  const want = head.ids[level];
  // the header lines in order; a header owns the file rows that follow it, up to the next header
  const lines: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === 'group') lines.push(i);
  });
  const same = (n: number) => (rows[lines[n]] as GroupHeader).ids[level] === want;
  let from = lines.indexOf(headerIndex);
  let to = from;
  while (from > 0 && same(from - 1)) from--;
  while (to < lines.length - 1 && same(to + 1)) to++;
  const end = to + 1 < lines.length ? lines[to + 1] : rows.length;
  return rows.slice(lines[from], end).flatMap((r) => (r.kind === 'item' ? [r.item] : []));
}

/** The outermost groups: collapsing all of them leaves one line per top group. */
export const topGroupIds = (rows: Row[]) => [
  ...new Set(rows.flatMap((r) => (r.kind === 'group' ? [r.ids[0]] : []))),
];

export function formatBytes(n: number): string {
  if (n < KB) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / KB;
  let k = 0;
  while (v >= KB && k < u.length - 1) {
    v /= KB;
    k++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[k]}`;
}

// ---------------------------------------------------------------- saved choice

const KEY = 'boonsh_group';

export function loadGroups(): GroupSpec[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: GroupSpec[] = [];
    // saved by the first version: one 'bucket'; its month / week / day meant a whole date, so they become parts
    const OLD: Partial<Record<string, Bucket[]>> = {
      month: ['year', 'month'],
      week: ['year', 'week'],
      day: ['year', 'month', 'day'],
    };
    for (const g of raw) {
      const col = g?.column as ColumnId;
      if (!BUCKETS[col] || seen.has(col)) continue;
      let buckets: Bucket[] = Array.isArray(g.buckets) ? g.buckets : g.bucket ? (isDateColumn(col) && OLD[g.bucket]) || [g.bucket] : [];
      buckets = buckets.filter((b, k) => BUCKETS[col].includes(b) && buckets.indexOf(b) === k);
      if (!isDateColumn(col)) buckets = buckets.slice(0, 1);
      if (buckets.includes('relative')) buckets = ['relative'];
      if (buckets.length === 0) continue;
      seen.add(col);
      out.push({ column: col, buckets });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveGroups(g: GroupSpec[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // storage unavailable: lasts for this session only
  }
}
