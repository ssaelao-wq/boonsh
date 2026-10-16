// Split Screen layout (pure). A tab splits once Left-Right or Top-Bottom into halves `a` (left / top) and `b`
// (right / bottom); each half can be split once more the other way (`a1` / `a2`, `b1` / `b2`: the first is the
// top or left one), so a tab has at most four screens.

export type SplitDir = 'lr' | 'tb';
export type SplitCell = 'a' | 'b' | 'a1' | 'a2' | 'b1' | 'b2';

export const CELL_ORDER: SplitCell[] = ['a', 'a1', 'a2', 'b', 'b1', 'b2'];
export const cellRank = (c: SplitCell | undefined) => (c ? CELL_ORDER.indexOf(c) : -1);

// Only a half that has not been split yet can be split, and always across the first split
export const canSplitCell = (c: SplitCell | undefined): c is 'a' | 'b' => c === 'a' || c === 'b';
export const crossDir = (d: SplitDir): SplitDir => (d === 'lr' ? 'tb' : 'lr');

export const DIR_LABEL: Record<SplitDir, string> = { lr: 'Left-Right', tb: 'Top-Bottom' };

export function paneName(dir: SplitDir, cell: SplitCell): string {
  const names: Record<SplitDir, Record<SplitCell, string>> = {
    lr: { a: 'Left', b: 'Right', a1: 'Top-Left', a2: 'Bottom-Left', b1: 'Top-Right', b2: 'Bottom-Right' },
    tb: { a: 'Top', b: 'Bottom', a1: 'Top-Left', a2: 'Top-Right', b1: 'Bottom-Left', b2: 'Bottom-Right' },
  };
  return names[dir][cell];
}

// One screen closes: how the others move. null = only one screen is left (the tab is no longer split).
// A closed quarter gives its half back to its partner; a closed half gives the whole box to the other half, and
// when that half was split, its two screens become the new halves (so the first split now runs the other way).
export function closeCell(
  dir: SplitDir,
  cells: SplitCell[],
  gone: SplitCell
): { dir: SplitDir; moves: Partial<Record<SplitCell, SplitCell>> } | null {
  const left = cells.filter((c) => c !== gone);
  if (left.length <= 1) return null;
  const half = gone[0] as 'a' | 'b';
  if (gone.length === 2) {
    const sibling = `${half}${gone[1] === '1' ? '2' : '1'}` as SplitCell;
    return { dir, moves: { [sibling]: half } };
  }
  const other = half === 'a' ? 'b' : 'a';
  // the other half is split (it cannot be whole here: then only one screen would be left)
  return { dir: crossDir(dir), moves: { [`${other}1`]: 'a', [`${other}2`]: 'b' } };
}

// ---- Geometry: an edge is a share of the box plus a pixel offset (for the gap around the separators) ----
export interface Edge {
  f: number;
  px: number;
}
export interface Rect {
  x0: Edge;
  x1: Edge;
  y0: Edge;
  y1: Edge;
}
export interface SplitRatios {
  main: number; // where the first split sits
  a: number; // where half a is split (when it is)
  b: number;
}

const START: Edge = { f: 0, px: 0 };
const END: Edge = { f: 1, px: 0 };

// The range of one side of a split at `ratio` (side 0 = left / top), leaving `gap` px on each side of the line
function side(ratio: number, which: 0 | 1, gap: number): [Edge, Edge] {
  return which === 0 ? [START, { f: ratio, px: -gap }] : [{ f: ratio, px: gap }, END];
}

export function cellRect(dir: SplitDir, cell: SplitCell, r: SplitRatios, gap: number): Rect {
  const half = cell[0] as 'a' | 'b';
  const along = side(r.main, half === 'a' ? 0 : 1, gap);
  const across: [Edge, Edge] = cell.length === 2 ? side(r[half], cell[1] === '1' ? 0 : 1, gap) : [START, END];
  return dir === 'lr'
    ? { x0: along[0], x1: along[1], y0: across[0], y1: across[1] }
    : { x0: across[0], x1: across[1], y0: along[0], y1: along[1] };
}

// The separators to draw: `vertical` lines sit at an x position (dragged sideways), the others at a y position
export interface Divider {
  key: 'main' | 'a' | 'b';
  vertical: boolean;
  at: number; // the ratio the line sits at
  from: Edge; // where it starts and ends along its own length
  to: Edge;
}
export function dividers(dir: SplitDir, cells: SplitCell[], r: SplitRatios, gap: number): Divider[] {
  const out: Divider[] = [{ key: 'main', vertical: dir === 'lr', at: r.main, from: START, to: END }];
  for (const half of ['a', 'b'] as const) {
    if (!cells.includes(`${half}1` as SplitCell)) continue;
    const [from, to] = side(r.main, half === 'a' ? 0 : 1, gap);
    out.push({ key: half, vertical: dir !== 'lr', at: r[half], from, to });
  }
  return out;
}

export const edgeCss = (e: Edge, extraPx = 0) => `calc(${e.f * 100}% + ${e.px + extraPx}px)`;
export const spanCss = (a: Edge, b: Edge, extraPx = 0) => `calc(${(b.f - a.f) * 100}% + ${b.px - a.px + extraPx}px)`;
