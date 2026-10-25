import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileItem } from './types';
import { isBasket } from './basket';

// File icons as Explorer shows them, drawn by Windows (shell_icons.rs): the icon of the program that opens the
// file type (a .pdf opened by Brave shows Brave's icon), so one icon per extension. These types have an icon
// of their own per file (a program's icon, a shortcut's target, the picture in an .ico), so they go by path.
const OWN_ICON = new Set(['exe', 'lnk', 'ico', 'cur', 'ani', 'url', 'website', 'msc', 'cpl', 'scr', 'appref-ms']);
const CHUNK = 40;

export const iconKey = (item: FileItem): string => {
  const ext = item.ext.toLowerCase();
  return OWN_ICON.has(ext) ? `path:${item.path.toLowerCase()}` : `ext:${ext}`;
};

/** Items that keep boonsh's own drawing: folders, baskets and gone / new basket entries. */
const ownDrawing = (item: FileItem) => item.is_dir || !!item.state || isBasket(item);

// `<pixels>|<key>` -> PNG data URL ('' = Windows had none). Shared by every folder for the whole session.
const cache = new Map<string, string>();
// keys to ask again (the user may change a default app while boonsh is open), shown as they are meanwhile
const stale = new Set<string>();

/** Icon lookup for `items` drawn at `cssSize` px: asks Windows for what is missing, in the background. */
export function useFileIcons(items: FileItem[], cssSize: number, on: boolean): (item: FileItem) => string | undefined {
  const [, redraw] = useState(0);
  const [focusGen, setFocusGen] = useState(0);
  const px = Math.round(cssSize * Math.max(1, window.devicePixelRatio || 1));

  useEffect(() => {
    const onFocus = () => {
      for (const k of cache.keys()) stale.add(k);
      setFocusGen((g) => g + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    if (!on) return;
    const want = new Map<string, string>(); // key -> a file to ask about
    for (const item of items) {
      if (ownDrawing(item)) continue;
      const key = iconKey(item);
      const ck = `${px}|${key}`;
      if ((!cache.has(ck) || stale.has(ck)) && !want.has(key)) want.set(key, item.path);
    }
    if (want.size === 0) return;
    let cancelled = false;
    (async () => {
      const list = [...want].map(([key, path]) => ({ key, path }));
      for (let i = 0; i < list.length && !cancelled; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        let res: Record<string, string>;
        try {
          res = await invoke<Record<string, string>>('get_file_icons', { requests: part, size: px });
        } catch {
          return; // outside Tauri, or the backend failed: boonsh's own icons stay
        }
        let changed = false;
        for (const r of part) {
          const ck = `${px}|${r.key}`;
          const url = res[r.key] ?? '';
          stale.delete(ck);
          if (cache.get(ck) !== url) {
            cache.set(ck, url);
            changed = true;
          }
        }
        if (changed && !cancelled) redraw((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, px, on, focusGen]);

  return (item) => (on && !ownDrawing(item) ? cache.get(`${px}|${iconKey(item)}`) || undefined : undefined);
}

// Explorer's thumbnails (a frame of the movie) for video files in the Thumbnails view, instead of the player's
// icon. Keyed by path + Date Modified, so a replaced file gets a new picture. '' = Windows could not make one.
const thumbs = new Map<string, string>();
const THUMB_CHUNK = 8; // a first-time video frame is slow; small chunks show the pictures as they come
const thumbKey = (px: number, item: FileItem) => `${px}|${item.path.toLowerCase()}|${item.modified_timestamp ?? 0}`;

/** Thumbnail lookup for the `wanted` items, fitted in `cssSize` px: asks Windows in the background. */
export function useThumbnails(
  items: FileItem[],
  wanted: (item: FileItem) => boolean,
  cssSize: number,
  on: boolean
): (item: FileItem) => string | undefined {
  const [, redraw] = useState(0);
  const px = Math.round(cssSize * Math.max(1, window.devicePixelRatio || 1));

  useEffect(() => {
    if (!on) return;
    const want = items.filter((i) => !ownDrawing(i) && wanted(i) && !thumbs.has(thumbKey(px, i)));
    if (want.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < want.length && !cancelled; i += THUMB_CHUNK) {
        const part = want.slice(i, i + THUMB_CHUNK);
        let res: Record<string, string>;
        try {
          res = await invoke<Record<string, string>>('get_thumbnails', { paths: part.map((p) => p.path), size: px });
        } catch {
          return; // outside Tauri, or the backend failed: the icons stay
        }
        for (const item of part) thumbs.set(thumbKey(px, item), res[item.path] ?? '');
        if (!cancelled) redraw((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, px, on]);

  return (item) => (on && !ownDrawing(item) && wanted(item) ? thumbs.get(thumbKey(px, item)) || undefined : undefined);
}
