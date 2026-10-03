// Pure helpers of the video player (kept out of the component so they can be checked with node).

/** Extensions the preview treats as video. WebView2 plays MP4/M4V/MOV (H.264) and WebM; the others are tried and,
 *  when the built-in player cannot decode them, the player says so. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp', 'ts'];

export const isVideoExt = (ext: string): boolean => VIDEO_EXTENSIONS.includes(ext.toLowerCase());

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt'];

/** 83.4 -> "1:23", 3725 -> "1:02:05". */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 83.4 -> "00-01-23", for file names (no colons). */
export function timeForFileName(seconds: number): string {
  const total = Math.max(0, Math.floor(isFinite(seconds) ? seconds : 0));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}-${p(Math.floor((total % 3600) / 60))}-${p(total % 60)}`;
}

/** Turns SubRip (.srt) text into WebVTT, which is what a <track> element reads. A .vtt text passes through. */
export function srtToVtt(text: string): string {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(clean)) return clean + '\n';
  const body = clean.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body + '\n';
}

/** Keeps a point inside the video. */
export const clampTime = (t: number, duration: number): number =>
  Math.min(Math.max(t, 0), isFinite(duration) && duration > 0 ? duration : Math.max(t, 0));

/** The A-B loop has three steps: first click sets A, second sets B (and the loop starts), third clears both. */
export type AbState = { a: number | null; b: number | null };

export function abClick(state: AbState, now: number): AbState {
  if (state.a === null) return { a: now, b: null };
  if (state.b === null) {
    // B must come after A; a click at or before A moves A instead
    return now > state.a + 0.2 ? { a: state.a, b: now } : { a: now, b: null };
  }
  return { a: null, b: null };
}

/** Where to jump back to when playback passes B (null = no loop active). */
export function abLoopTarget(state: AbState, now: number): number | null {
  if (state.a !== null && state.b !== null && now >= state.b) return state.a;
  return null;
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
