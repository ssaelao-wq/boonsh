import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FolderTotals, formatSize, lastName, percentOf, sizeKey } from '../folderSizes';
import { FileItem } from '../types';

/** The status bar's size text: "523.4 KB", "12.5 MB", "1.25 GB" */
export const formatTotalSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// ---- Folder sizes (folder_size.rs) ----
// In a folder view, the folders listed, the folder itself and its parent are measured in the background (in
// that order: the folder's own total is then quick, from its measured sub-folders). Each result arrives as a
// `folder-size` event; the folder rows get the size (Size column, sorting) and the status bar the total and
// the share of the parent. A newer request (another folder, a change) stops the older walk.
export function useFolderSizes({
  currentPath,
  currentPathRef,
  parentPath,
  rawItems,
  sizesOn,
  inFolderView,
  basketOpen,
  totalSize,
}: {
  currentPath: string;
  currentPathRef: React.MutableRefObject<string>;
  parentPath: string | null;
  rawItems: FileItem[];
  sizesOn: boolean;
  inFolderView: boolean;
  basketOpen: boolean;
  totalSize: number; // the listing's own total (files only), shown until the folder is measured
}) {
  const [folderSizes, setFolderSizes] = useState<Record<string, FolderTotals>>({});
  const [sizesBusy, setSizesBusy] = useState(false);
  const [sizeTick, setSizeTick] = useState(0);
  const folderSig = useMemo(() => rawItems.filter((i) => i.is_dir).map((i) => i.path).join('|'), [rawItems]);
  const sizeSeqRef = useRef(0);
  // a size change anywhere below the open folder (watch_folder_sizes; the backend has already forgotten the
  // changed folders): measure again, after the walk that is running, so a busy folder does not keep restarting it
  const sizesBusyRef = useRef(false);
  sizesBusyRef.current = sizesBusy;
  const staleWaitingRef = useRef(false);
  useEffect(() => {
    invoke('watch_folder_sizes', { path: sizesOn && inFolderView && currentPath ? currentPath : null }).catch(() => {});
  }, [currentPath, sizesOn, inFolderView]);
  useEffect(() => {
    const unlisten = listen<{ path: string }>('sizes-stale', (e) => {
      if (sizeKey(e.payload.path) !== sizeKey(currentPathRef.current || '')) return;
      if (sizesBusyRef.current) staleWaitingRef.current = true;
      else setSizeTick((t) => t + 1);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  useEffect(() => {
    // results come in quick bursts: put them on screen a few times a second, not once per folder
    let buf: Record<string, FolderTotals> = {};
    let timer: number | null = null;
    const unlisten = listen<{ path: string } & FolderTotals>('folder-size', (e) => {
      const { path, size, files, folders } = e.payload;
      buf[sizeKey(path)] = { size, files, folders };
      if (timer === null)
        timer = window.setTimeout(() => {
          const got = buf;
          buf = {};
          timer = null;
          setFolderSizes((prev) => ({ ...prev, ...got }));
        }, 120);
    });
    return () => {
      unlisten.then((f) => f());
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const seq = ++sizeSeqRef.current;
    if (!sizesOn || !inFolderView || !currentPath) {
      invoke('folder_sizes_stop').catch(() => {});
      setSizesBusy(false);
      return;
    }
    const paths = [...(folderSig ? folderSig.split('|') : []), currentPath, ...(parentPath ? [parentPath] : [])];
    setSizesBusy(true);
    invoke('folder_sizes', { paths })
      .catch(() => {})
      .finally(() => {
        if (seq !== sizeSeqRef.current) return;
        setSizesBusy(false);
        if (staleWaitingRef.current) {
          staleWaitingRef.current = false;
          setSizeTick((t) => t + 1);
        }
      });
  }, [currentPath, parentPath, folderSig, sizesOn, inFolderView, sizeTick]);
  // the folder rows with their measured size ("…" while still measuring); not in a basket (partly linked folders)
  const sizedItems = useMemo(() => {
    if (!sizesOn || basketOpen) return rawItems;
    let changed = false;
    const out = rawItems.map((i) => {
      if (!i.is_dir) return i;
      const t = folderSizes[sizeKey(i.path)];
      if (t) {
        changed = true;
        return { ...i, size: t.size, size_formatted: formatSize(t.size) };
      }
      if (sizesBusy && inFolderView) {
        changed = true;
        return { ...i, size_formatted: '…' };
      }
      return i;
    });
    return changed ? out : rawItems;
  }, [rawItems, folderSizes, sizesOn, sizesBusy, inFolderView, basketOpen]);
  // status bar: the folder's whole size and its share of the parent folder
  const curTotals = currentPath ? folderSizes[sizeKey(currentPath)] : undefined;
  const parentTotals = parentPath ? folderSizes[sizeKey(parentPath)] : undefined;
  const sizeStatus = () => {
    if (!sizesOn || !inFolderView) return { text: formatTotalSize(totalSize), note: '', title: undefined as string | undefined };
    if (!curTotals) return { text: formatTotalSize(totalSize), note: sizesBusy ? 'files only, measuring folders…' : '', title: undefined };
    const pct = parentTotals && parentPath ? percentOf(curTotals.size, parentTotals.size) : null;
    return {
      text: formatTotalSize(curTotals.size),
      note: pct ? `${pct} of ${lastName(parentPath!)}` : parentPath && sizesBusy ? 'measuring the parent folder…' : '',
      title: `Everything inside, sub-folders included: ${curTotals.files.toLocaleString()} files in ${curTotals.folders.toLocaleString()} folders`
        + (pct && parentTotals ? `\n${lastName(parentPath!)}: ${formatTotalSize(parentTotals.size)}` : ''),
    };
  };
  // measure again (Refresh, after the backend forgot what it had)
  const remeasure = () => setSizeTick((t) => t + 1);

  return { sizedItems, sizeStatus, remeasure };
}
