import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FileItem, FileListResult } from '../types';
import { DualSettings, Side, clampRatio, loadDual, otherSide, sameFolder, saveDual } from '../dualPane';
import { cacheGDriveFolderNames } from '../gdrive';

/** The pane that is not active: a folder listing with its own selection */
export interface OtherPane {
  path: string;
  items: FileItem[];
  selected: string[];
}

/** What the active pane holds when the user switches away from it */
export interface ActiveSnapshot {
  path: string;
  items: FileItem[];
  selected: string[];
  /** a plain folder listing (not search results, a basket or This PC): its items can be shown as they are */
  plain: boolean;
}

// Two file panes. The ACTIVE pane is App's own file panel state (so search, baskets, the terminal, preview, keys
// and menus all work there unchanged); the other pane is a snapshot with its own listing, watched in slot 1 of
// dir_watch.rs. Switching (a click in the other pane, Tab) swaps them: App opens the other pane's folder with its
// selection and the folder that was active becomes the other pane. The panes keep their sides on screen.
export function useDualPane({
  getActive,
  navigate,
}: {
  getActive: () => ActiveSnapshot;
  /** open `path` in the active pane, selecting `select` (resolves false when it cannot be opened) */
  navigate: (path: string, select: string[]) => Promise<boolean>;
}) {
  const [settings, setSettings] = useState<DualSettings>(loadDual);
  const [activeSide, setActiveSide] = useState<Side>('left');
  const [other, setOther] = useState<OtherPane | null>(null);
  const otherRef = useRef(other);
  otherRef.current = other;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeSideRef = useRef(activeSide);
  activeSideRef.current = activeSide;

  const update = (next: DualSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveDual(next);
  };

  // List `path` into the other pane. `select`: these items (else the ones still there stay selected). A folder that
  // cannot be opened falls back to `fallback` (the active pane's folder) so the pane is never empty.
  const loadOther = async (path: string, select?: string[], fallback?: string) => {
    try {
      const res = await invoke<FileListResult>('list_directory', { targetPath: path });
      cacheGDriveFolderNames(res.items);
      const byPath = new Set(res.items.map((i) => i.path));
      const keep = (select ?? (otherRef.current && sameFolder(otherRef.current.path, res.current_path) ? otherRef.current.selected : []))
        .filter((p) => byPath.has(p));
      setOther({ path: res.current_path, items: res.items, selected: keep });
      if (!sameFolder(settingsRef.current.path, res.current_path)) update({ ...settingsRef.current, path: res.current_path });
      return true;
    } catch {
      if (fallback && !sameFolder(fallback, path)) return loadOther(fallback, [], undefined);
      return false;
    }
  };

  // on at start (saved), or turned on: show the saved folder, else the active one
  useEffect(() => {
    if (settings.on && !otherRef.current) {
      const here = getActive().path;
      if (here) loadOther(settings.path || here, undefined, here);
    }
  });

  const toggleDual = () => {
    if (settingsRef.current.on) {
      update({ ...settingsRef.current, on: false });
      setOther(null);
      setActiveSide('left');
    } else {
      update({ ...settingsRef.current, on: true });
    }
  };

  // auto refresh of the other pane (the active pane uses slot 0)
  const otherPath = settings.on ? other?.path ?? null : null;
  useEffect(() => {
    invoke('watch_directory', { path: otherPath, slot: 1 }).catch(() => {});
  }, [otherPath]);
  useEffect(() => {
    const unlisten = listen<{ path: string }>('dir-changed', (e) => {
      const o = otherRef.current;
      if (o && settingsRef.current.on && sameFolder(e.payload.path, o.path)) loadOther(o.path);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** Re-list the other pane (after a copy into it, F5) */
  const reloadOther = (select?: string[]) => {
    const o = otherRef.current;
    if (o) loadOther(o.path, select);
  };

  // Switch to `side`. Calls made during the same event (the pane's right-click and the row's right-click) are
  // merged: the last selection / folder given wins. `path`: open this folder there instead (a double-click on a
  // folder in the other pane).
  const pendingRef = useRef<{ side: Side; select?: string[]; path?: string } | null>(null);
  const switchingRef = useRef(false);
  const switchTo = (side: Side, opts: { select?: string[]; path?: string } = {}) => {
    if (!settingsRef.current.on) return;
    if (switchingRef.current) {
      if (opts.path) navigate(opts.path, []); // a double-click while the switch runs: open it once there
      return;
    }
    if (side === activeSideRef.current && !pendingRef.current) return;
    const p = pendingRef.current;
    pendingRef.current = { side, select: opts.select ?? p?.select, path: opts.path ?? p?.path };
    if (p) return;
    setTimeout(async () => {
      const want = pendingRef.current;
      pendingRef.current = null;
      const o = otherRef.current;
      if (!want || !o || want.side === activeSideRef.current) return;
      switchingRef.current = true;
      try {
        const snap = getActive();
        const ok = await navigate(want.path ?? o.path, want.path ? [] : want.select ?? o.selected);
        if (!ok) {
          loadOther(o.path); // gone meanwhile: the list shows what is left
          return;
        }
        activeSideRef.current = want.side;
        setActiveSide(want.side);
        if (snap.plain) {
          setOther({ path: snap.path, items: snap.items, selected: snap.selected });
          update({ ...settingsRef.current, path: snap.path });
        } else {
          setOther({ path: snap.path, items: [], selected: [] });
          loadOther(snap.path, snap.selected);
        }
      } finally {
        switchingRef.current = false;
      }
    }, 0);
  };

  const toggleActive = () => switchTo(otherSide(activeSideRef.current));

  const setRatio = (r: number) => {
    const ratio = clampRatio(r);
    settingsRef.current = { ...settingsRef.current, ratio };
    setSettings(settingsRef.current);
  };
  const saveRatio = () => saveDual(settingsRef.current);

  return {
    dual: settings.on,
    ratio: settings.ratio,
    activeSide,
    other: settings.on ? other : null,
    toggleDual,
    switchTo,
    toggleActive,
    reloadOther,
    setRatio,
    saveRatio,
  };
}
