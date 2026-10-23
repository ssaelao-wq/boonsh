// Command palette (Ctrl+Shift+P, components/CommandPalette.tsx): one list of actions, saved commands, Global Vars,
// CONSTs, Quick Access, recent folders, drives and command line tabs, filtered by a fuzzy match. Pure helpers.

export type PaletteKind = 'action' | 'command' | 'var' | 'const' | 'quick' | 'recent' | 'drive' | 'tab' | 'path' | 'search';

export interface PaletteItem {
  /** stable id (the recently-picked list is kept by id) */
  id: string;
  kind: PaletteKind;
  title: string;
  /** a second, dimmer line: a path, the command text, a value */
  detail?: string;
  /** more words to match that are not shown */
  keywords?: string;
  /** the keyboard shortcut, shown on the right */
  shortcut?: string;
  run: () => void;
}

export const KIND_LABEL: Record<PaletteKind, string> = {
  action: 'Action',
  command: 'Command',
  var: 'Global Var',
  const: 'CONST',
  quick: 'Quick Access',
  recent: 'Recent folder',
  drive: 'Drive',
  tab: 'Tab',
  path: 'Folder',
  search: 'Search',
};

/** A query that starts with one of these shows only those kinds (the character itself is not matched) */
export const PREFIXES: { char: string; kinds: PaletteKind[]; hint: string }[] = [
  { char: '>', kinds: ['action'], hint: 'actions' },
  { char: '/', kinds: ['quick', 'recent', 'drive', 'path'], hint: 'folders' },
  { char: '$', kinds: ['command'], hint: 'saved commands' },
  { char: '{', kinds: ['var', 'const'], hint: 'variables' },
];

export interface Match {
  score: number;
  /** positions in the title to highlight */
  hits: number[];
}

const SEPARATORS = ' \\/-_.:{}()[],+';

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (SEPARATORS.includes(prev)) return true;
  // camelCase: a capital after a small letter
  return prev >= 'a' && prev <= 'z' && text[i] >= 'A' && text[i] <= 'Z';
}

/** How well `token` (lower case, no spaces) matches `text`: a substring scores best (more at the start of a word),
 *  else the letters in order with gaps (word starts and runs count more). null = no match. */
export function matchToken(token: string, text: string): Match | null {
  if (!token) return { score: 0, hits: [] };
  const lower = text.toLowerCase();
  // the best substring: a word start beats an earlier position inside a word
  let best: Match | null = null;
  for (let pos = lower.indexOf(token); pos >= 0; pos = lower.indexOf(token, pos + 1)) {
    const score = 100 + token.length * 10 + (pos === 0 ? 40 : 0) + (isWordStart(text, pos) ? 30 : 0) - Math.min(pos, 30);
    if (!best || score > best.score) best = { score, hits: Array.from({ length: token.length }, (_, k) => pos + k) };
  }
  if (best) return best;
  // letters in order: for each letter take the next word start if there is one before the next plain match
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of token) {
    let at = -1;
    let plain = -1;
    for (let i = from; i < lower.length; i++) {
      if (lower[i] !== ch) continue;
      if (plain < 0) plain = i;
      if (isWordStart(text, i)) {
        at = i;
        break;
      }
    }
    if (plain < 0) return null;
    // a word start far away is not worth skipping a run for
    if (at < 0 || (hits.length > 0 && plain === hits[hits.length - 1] + 1)) at = plain;
    const run = hits.length > 0 && at === hits[hits.length - 1] + 1;
    score += 10 + (run ? 15 : 0) + (isWordStart(text, at) ? 20 : 0) - Math.min(at - from, 10);
    hits.push(at);
    from = at + 1;
  }
  // scaled to stay below every substring match (100 and up): letters spread over several words must never beat
  // the word itself ("light" in "Switch to the light theme" vs "Split the command line Left-Right")
  return { score: Math.max(1, (99 * score) / (45 * token.length)), hits };
}

/** The kinds a query asks for (by its first character) and the query without that character */
export function splitPrefix(query: string): { kinds: PaletteKind[] | null; text: string } {
  const q = query.trimStart();
  const p = PREFIXES.find((x) => q.startsWith(x.char));
  if (!p) return { kinds: null, text: q.trim() };
  let text = q.slice(1);
  if (p.char === '{') text = text.replace(/[{}]/g, ''); // `{SELEC}` finds SELEC
  return { kinds: p.kinds, text: text.trim() };
}

/** How well a whole query matches an item: every word must match the title, the detail or the keywords (the title
 *  counts most). null = no match. */
export function matchItem(words: string[], item: PaletteItem): Match | null {
  let score = 0;
  const hits: number[] = [];
  const extra = `${item.detail ?? ''} ${item.keywords ?? ''} ${KIND_LABEL[item.kind]}`;
  for (const w of words) {
    const t = matchToken(w, item.title);
    if (t) {
      score += t.score;
      hits.push(...t.hits);
      continue;
    }
    const e = matchToken(w, extra);
    if (!e) return null;
    score += e.score / 3;
  }
  return { score, hits: [...new Set(hits)].sort((a, b) => a - b) };
}

export interface Ranked {
  item: PaletteItem;
  hits: number[];
}

/** The items for a query, best first. An empty query lists the recently picked ones first, then all in order.
 *  `recent`: ids picked lately, newest first (they get a bonus). `limit`: at most this many. */
export function rankItems(items: PaletteItem[], query: string, recent: string[] = [], limit = 100): Ranked[] {
  const { kinds, text } = splitPrefix(query);
  const pool = kinds ? items.filter((i) => kinds.includes(i.kind)) : items;
  const recentRank = new Map(recent.map((id, k) => [id, k]));
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const picked = recent.map((id) => pool.find((i) => i.id === id)).filter((i): i is PaletteItem => !!i);
    const rest = pool.filter((i) => !recentRank.has(i.id));
    return [...picked, ...rest].slice(0, limit).map((item) => ({ item, hits: [] }));
  }
  const scored: { item: PaletteItem; m: Match; order: number }[] = [];
  pool.forEach((item, order) => {
    const m = matchItem(words, item);
    if (!m) return;
    const r = recentRank.get(item.id);
    const bonus = r === undefined ? 0 : Math.max(0, 40 - r * 2);
    scored.push({ item, m: { ...m, score: m.score + bonus }, order });
  });
  scored.sort((a, b) => b.m.score - a.m.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => ({ item: s.item, hits: s.m.hits }));
}

/** The text split into plain and highlighted runs, for drawing */
export function highlightRuns(text: string, hits: number[]): { text: string; hit: boolean }[] {
  const set = new Set(hits);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}

/** A query that is a folder path (`D:\Work`, `\\server\share`, `.\sub`, `..`), made absolute against `cwd`; else null */
export function pathFromQuery(query: string, cwd: string): string | null {
  let q = query.trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\');
  if (!q) return null;
  if (/^[a-zA-Z]:$/.test(q)) q += '\\';
  const absolute = /^[a-zA-Z]:\\/.test(q) || q.startsWith('\\\\');
  const relative = q === '.' || q === '..' || q.startsWith('.\\') || q.startsWith('..\\');
  if (!absolute && !relative) return null;
  if (absolute) return q.length > 3 ? q.replace(/\\+$/, '') : q;
  if (!cwd) return null;
  const parts = cwd.replace(/\\+$/, '').split('\\');
  for (const piece of q.split('\\')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(piece);
  }
  const out = parts.join('\\');
  return /^[a-zA-Z]:$/.test(out) ? out + '\\' : out;
}

// ---- recently picked (localStorage `boonsh_palette_recent`, newest first) ----
export const RECENT_KEY = 'boonsh_palette_recent';
export const RECENT_MAX = 30;

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(list: string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
}

export function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage blocked: the order lasts until boonsh closes
  }
}
