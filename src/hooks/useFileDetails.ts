import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GroupSpec } from '../grouping';
import { ColumnPrefs, SortLevel, detailKey, hasMediaProps, needsDetails } from '../columns';
import { FileItem, ItemDetails } from '../types';

// What the file list's extra columns read from Windows: media properties (Dimensions, Length, Album ...) and the
// default app of each file type for the Type column.
export function useFileDetails(rawItems: FileItem[], colPrefs: ColumnPrefs, sortLevels: SortLevel[], groups: GroupSpec[]) {
  const [details, setDetails] = useState<Record<string, ItemDetails>>({}); // media properties, by detailKey
  // Default app of each file type for the Type column ("MP4 (VLC media player)"); '' = none. Asked once per type.
  const [appByExt, setAppByExt] = useState<Record<string, string>>({});

  const showType = colPrefs.visible.includes('ext');
  useEffect(() => {
    if (!showType) return;
    const todo = [...new Set(rawItems.filter((i) => !i.is_dir && i.ext).map((i) => i.ext.toLowerCase()))].filter(
      (e) => appByExt[e] === undefined
    );
    if (todo.length === 0) return;
    invoke<Record<string, string>>('get_default_apps', { exts: todo })
      .then((res) => setAppByExt((prev) => ({ ...prev, ...res })))
      .catch(() => {});
  }, [rawItems, showType, appByExt]);
  // The user may change a default app in Windows while boonsh is open: look again when the window comes back
  useEffect(() => {
    const onFocus = () => setAppByExt({});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Properties for the Dimensions / Length / Album ... columns (and sorting by them) are read from the files
  // by the backend, only for the files that can have them, and only while such a column is shown or sorted on.
  const detailsSeqRef = useRef(0);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const wantDetails = needsDetails(colPrefs, [
    ...sortLevels,
    ...groups.map((g) => ({ column: g.column, order: 'asc' as const })),
  ]);
  useEffect(() => {
    if (!wantDetails) return;
    const todo = rawItems.filter((i) => hasMediaProps(i) && !detailsRef.current[detailKey(i)]);
    if (todo.length === 0) return;
    const seq = ++detailsSeqRef.current;
    (async () => {
      for (let k = 0; k < todo.length; k += 50) {
        if (seq !== detailsSeqRef.current) return; // a newer folder / list took over
        const chunk = todo.slice(k, k + 50);
        try {
          const res = await invoke<ItemDetails[]>('get_file_details', { paths: chunk.map((c) => c.path) });
          if (seq !== detailsSeqRef.current) return;
          setDetails((prev) => {
            const next = { ...prev };
            chunk.forEach((item, n) => {
              if (res[n]) next[detailKey(item)] = res[n];
            });
            return next;
          });
        } catch {
          return;
        }
      }
    })();
  }, [rawItems, wantDetails]);

  return { details, appByExt };
}
