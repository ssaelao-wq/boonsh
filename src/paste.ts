// Paste with name-clash choices and progress (paste.rs). Wire types and pure helpers; the flow is in
// hooks/usePaste.ts, the windows in components/PasteConflictDialog.tsx and components/PasteProgress.tsx.
import { formatSize } from './folderSizes';

export type PasteChoice = 'replace' | 'keep' | 'skip';

/** A name already taken in the folder (or by an earlier item of the same paste: `in_paste`) */
export interface Clash {
  source: string;
  target: string;
  name: string;
  source_is_dir: boolean;
  target_is_dir: boolean;
  source_size: number; // files only
  target_size: number;
  source_modified: number; // Unix seconds, 0 = unknown
  target_modified: number;
  in_paste: boolean;
}

export interface PasteResult {
  pasted: string[];
  moved: [string, string][];
  skipped: number;
  errors: string[];
  cancelled: boolean;
}

/** The `paste-progress` event */
export interface PasteProgress {
  job: number;
  phase: 'queued' | 'count' | 'copy' | 'done';
  /** queued: how many pastes run or wait before this one */
  ahead: number;
  done_bytes: number;
  total_bytes: number;
  done_items: number;
  total_items: number;
  current: string;
}

/** The name Keep Both gives when the next number is free: readme.txt -> readme-02.txt (a folder keeps its dots) */
export function keepBothName(name: string, isDir: boolean, n = 2): string {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const num = String(n).padStart(2, '0');
  return dot > 0 ? `${name.slice(0, dot)}-${num}${name.slice(dot)}` : `${name}-${num}`;
}

/** The choices for every clash: the ones answered one by one, then `rest` for the remaining ones */
export function fillChoices(clashes: Clash[], answered: PasteChoice[], rest: PasteChoice | null): Record<string, PasteChoice> {
  const out: Record<string, PasteChoice> = {};
  clashes.forEach((c, i) => {
    const choice = answered[i] ?? rest;
    if (choice) out[c.source] = choice;
  });
  return out;
}

/** 0..1 for the bar: by bytes once they are known, else by items; null = still measuring (no bar length yet) */
export function progressFraction(p: PasteProgress | null): number | null {
  if (!p || p.phase === 'count' || p.phase === 'queued') return null;
  if (p.phase === 'done') return 1;
  if (p.total_bytes > 0) return Math.min(1, p.done_bytes / p.total_bytes);
  return p.total_items > 0 ? Math.min(1, p.done_items / p.total_items) : null;
}

/** "12.4 MB/s" */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatSize(Math.max(0, Math.round(bytesPerSec)))}/s`;
}

/** "about 5 s left", "about 3 min left", "about 1 h 20 min left" */
export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '';
  const s = Math.ceil(seconds);
  if (s < 60) return `about ${s} s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** Bytes done at a moment of the copy (for the speed) */
export interface SpeedSample {
  t: number; // ms
  bytes: number;
}

/** How far back the speed looks: long enough to be steady, short enough to follow a slower drive or a pause */
export const SPEED_WINDOW_MS = 5000;

/** `samples` plus a new one, dropping those older than the window (one older sample is kept as its start) */
export function addSample(samples: SpeedSample[], s: SpeedSample, windowMs = SPEED_WINDOW_MS): SpeedSample[] {
  const all = [...samples, s];
  let from = 0;
  while (from + 1 < all.length && s.t - all[from + 1].t >= windowMs) from++;
  return all.slice(from);
}

/** Bytes per second over the samples; null until they span a second */
export function speedOf(samples: SpeedSample[]): number | null {
  if (samples.length < 2) return null;
  const a = samples[0];
  const b = samples[samples.length - 1];
  const ms = b.t - a.t;
  return ms >= 1000 ? ((b.bytes - a.bytes) * 1000) / ms : null;
}

/** The status text under the bar: "1.20 GB of 4.00 GB · 45.0 MB/s · about 1 min left". `speed` in bytes/s
 *  (null = not known yet). */
export function progressText(p: PasteProgress | null, speed: number | null, paused = false): string {
  if (p?.phase === 'queued') return `Waiting: ${p.ahead} paste${p.ahead === 1 ? '' : 's'} before this one`;
  if (!p || p.phase === 'count') return paused ? 'Paused' : 'Measuring what to copy…';
  const items = `${p.done_items} of ${p.total_items} item${p.total_items === 1 ? '' : 's'}`;
  const parts = [p.total_bytes > 0 ? `${formatSize(p.done_bytes)} of ${formatSize(p.total_bytes)}` : items];
  if (paused) parts.push('Paused');
  else if (p.total_bytes > 0 && speed !== null && p.phase !== 'done') {
    parts.push(formatSpeed(speed));
    const eta = speed > 0 ? formatEta((p.total_bytes - p.done_bytes) / speed) : '';
    if (eta) parts.push(eta);
  }
  return parts.join(' · ');
}

/** The local date and time of a Unix time, '' when unknown */
export function formatWhen(unixSecs: number): string {
  if (!unixSecs) return '';
  return new Date(unixSecs * 1000).toLocaleString();
}
