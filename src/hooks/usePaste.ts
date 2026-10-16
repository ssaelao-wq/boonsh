import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Clash, PasteChoice, PasteProgress, PasteResult, addSample } from '../paste';
import { PasteJob } from '../components/PasteProgress';
import { lastName } from '../folderSizes';

/** The in-app file clipboard (Ctrl+X / Ctrl+C). `basket`: copied inside that basket, so a paste into a folder takes
 *  only its linked items (basket.rs paste_out) and a cut there moves the links along. */
export interface FileClipboard {
  mode: 'copy' | 'cut';
  paths: string[];
  basket?: string;
}

// Cut / Copy / Paste of files (paste.rs). A paste first asks paste_check for names already taken in the folder;
// the user decides each one (PasteConflictDialog), then the paste runs as a job with progress cards, Pause and
// Cancel (PasteProgress). Copies wait in a queue in paste.rs, one at a time (Start now skips the wait). In an open basket a paste adds links instead (addToBasket).
export function usePaste({
  currentPathRef,
  basketViewRef,
  addToBasket,
  reload,
  notify,
}: {
  currentPathRef: React.MutableRefObject<string>;
  basketViewRef: React.MutableRefObject<{ path: string } | null>;
  addToBasket: (basket: string, paths: string[]) => Promise<void>;
  /** the paste into `dest` is done: show it with these items selected (if the user is still there) */
  reload: (dest: string, selectPaths: string[]) => void;
  notify: (message: string) => void;
}) {
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [clashPrompt, setClashPrompt] = useState<{
    clashes: Clash[];
    destName: string;
    resolve: (choices: Record<string, PasteChoice> | null) => void;
  } | null>(null);
  const [jobs, setJobs] = useState<PasteJob[]>([]);
  const lastJobRef = useRef(0);
  const askingRef = useRef(false);

  useEffect(() => {
    const unlisten = listen<PasteProgress>('paste-progress', (e) => {
      const p = e.payload;
      setJobs((prev) =>
        prev.map((j) =>
          j.id === p.job
            ? {
                ...j,
                progress: p,
                samples: p.phase === 'copy' && !j.paused ? addSample(j.samples, { t: Date.now(), bytes: p.done_bytes }) : j.samples,
              }
            : j
        )
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const askClashes = (clashes: Clash[], destName: string) =>
    new Promise<Record<string, PasteChoice> | null>((resolve) => setClashPrompt({ clashes, destName, resolve }));

  // Copy or move `src` into `dest`: asks about the clashes, then runs as a job (queue, progress card). Resolves
  // with the result, or null when the user cancelled at the clash dialog. Nothing is overwritten unless the user
  // chose Replace for it. Used by Paste and by two-pane F5 / F6 / drops.
  const transfer = async (src: FileClipboard, dest: string): Promise<PasteResult | null> => {
    if (askingRef.current) return null; // one clash pop-up at a time
    let choices: Record<string, PasteChoice> = {};
    askingRef.current = true;
    try {
      const clashes = await invoke<Clash[]>('paste_check', { paths: src.paths, destDir: dest });
      if (clashes.length > 0) {
        const answer = await askClashes(clashes, lastName(dest));
        setClashPrompt(null);
        if (!answer) return null; // Cancel paste
        choices = answer;
      }
    } finally {
      askingRef.current = false;
    }
    const job = Math.max(Date.now(), lastJobRef.current + 1);
    lastJobRef.current = job;
    const n = src.paths.length;
    const label = `${src.mode === 'cut' ? 'Moving' : 'Copying'} ${n} item${n === 1 ? '' : 's'} to ${lastName(dest)}`;
    setJobs((prev) => [...prev, { id: job, label, progress: null, samples: [], paused: false, cancelling: false, startingNow: false }]);
    let res: PasteResult;
    try {
      const args = { paths: src.paths, destDir: dest, mode: src.mode, choices, job };
      res = src.basket
        ? await invoke<PasteResult>('basket_paste_out', { basket: src.basket, ...args })
        : await invoke<PasteResult>('paste_items', args);
    } catch (err) {
      reload(dest, []);
      throw err;
    } finally {
      setJobs((prev) => prev.filter((j) => j.id !== job));
    }
    reload(dest, res.pasted);
    const done = res.pasted.length;
    if (res.cancelled) notify(`Paste cancelled: ${done} of ${n} item${n === 1 ? '' : 's'} pasted.`);
    else if (res.skipped > 0) notify(`Pasted ${done} item${done === 1 ? '' : 's'}, skipped ${res.skipped}.`);
    return res;
  };

  /** The error for the items of a paste that failed (null when none did) */
  const pasteError = (res: PasteResult) =>
    res.errors.length > 0 ? new Error(`Some items could not be pasted:\n${res.errors.join('\n')}`) : null;

  // Paste into the current folder; resolves with the new paths (the AI Assistant uses it too) and throws with the
  // items that failed.
  const pasteItems = async (): Promise<string[]> => {
    const cb = clipboard;
    const dest = currentPathRef.current;
    if (!cb || !dest || askingRef.current) return [];
    if (basketViewRef.current) {
      await addToBasket(basketViewRef.current.path, cb.paths);
      return [];
    }
    // moved items can't be pasted again; what a Cancel or an error left behind still can
    const keepUnmoved = (res: PasteResult) => {
      const moved = new Set(res.moved.map(([from]) => from.toLowerCase()));
      const left = cb.paths.filter((p) => !moved.has(p.toLowerCase()));
      setClipboard(left.length ? { ...cb, paths: left } : null);
    };
    const res = await transfer(cb, dest);
    if (!res) return [];
    if (cb.mode === 'cut') {
      if (res.cancelled || res.errors.length > 0) keepUnmoved(res);
      else setClipboard(null);
    }
    const err = pasteError(res);
    if (err) throw err;
    return res.pasted;
  };

  const cancelJob = (id: number) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, cancelling: true } : j)));
    invoke('paste_cancel', { job: id }).catch(() => {});
  };

  // Pause / Resume; the speed starts over after a pause so it is not dragged down by the time spent waiting
  const pauseJob = (id: number, paused: boolean) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, paused, samples: [] } : j)));
    invoke('paste_pause', { job: id, paused }).catch(() => {});
  };

  // A queued paste runs at once, beside the one that is copying
  const startJobNow = (id: number) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, startingNow: true } : j)));
    invoke('paste_start_now', { job: id }).catch(() => {});
  };

  return { clipboard, setClipboard, pasteItems, transfer, pasteError, clashPrompt, jobs, cancelJob, pauseJob, startJobNow };
}
