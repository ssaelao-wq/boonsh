import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DriveInfo } from '../drives';
import { QuickAccessItem } from '../types';
import { QA_MAX, QA_KEY, defaultQuickAccess, isShown, parseSaved, samePath } from '../quickAccess';
import {
  FrequentStats,
  FrequentSettings,
  loadStats,
  saveStats,
  loadSettings as loadFrequentSettings,
  saveSettings as saveFrequentSettings,
  recordVisit,
  removeVisit,
} from '../frequent';

// Smaller pieces of the window that keep their own state: the window title and start-up focus, the splitters,
// Quick Access, Frequently Accessed and the drive list.

/** The window title follows the focused item (else the folder); at start the window is brought to the front. */
export function useWindowSetup(currentPath: string, selectedPath: string | undefined) {
  // Dynamically update window title with full directory/file pathname
  useEffect(() => {
    let titleStr = 'boonsh';
    if (selectedPath) {
      titleStr = `boonsh - ${selectedPath}`;
    } else if (currentPath) {
      titleStr = `boonsh - ${currentPath}`;
    }
    document.title = titleStr;
    // Title only: the window size is the user's choice after startup
    try {
      getCurrentWindow().setTitle(titleStr).catch(() => {});
    } catch {
      // Fallback for non-tauri dev env
    }
  }, [currentPath, selectedPath]);

  // Initial window focus and bring-to-front on startup/relaunch
  useEffect(() => {
    try {
      // Invoke native Rust Win32 window focus API
      invoke('force_window_to_front').catch(() => {});

      const win = getCurrentWindow();
      const forceForeground = async () => {
        try {
          await win.show();
          await win.setAlwaysOnTop(true);
          await win.unminimize();
          await win.setFocus();
          await win.maximize();
        } catch {
          // Fallback if setAlwaysOnTop fails
          win.unminimize().catch(() => {});
          win.setFocus().catch(() => {});
          win.maximize().catch(() => {});
        }
      };

      forceForeground();

      // Repeated focus steps to guarantee window focus over foreground apps
      const t1 = setTimeout(() => {
        invoke('force_window_to_front').catch(() => {});
        win.setFocus().catch(() => {});
      }, 100);

      const t2 = setTimeout(() => {
        invoke('force_window_to_front').catch(() => {});
        win.setFocus().catch(() => {});
      }, 300);

      const t3 = setTimeout(() => {
        win.setAlwaysOnTop(false).catch(() => {});
        win.setFocus().catch(() => {});
      }, 500);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    } catch {}
  }, []);
}

/** Resizable split handles: the panel sizes and the drag in progress (plain mouse handlers on the app). */
export function useSplitters(showFilePanel: boolean) {
  const appRef = useRef<HTMLDivElement>(null);
  const [leftWidthPct, setLeftWidthPct] = useState<number>(55);
  const [treeWidthPx, setTreeWidthPx] = useState<number>(210);
  const [previewHeightPx, setPreviewHeightPx] = useState<number>(240);
  const [assistantHeightPx, setAssistantHeightPx] = useState<number>(300);
  const [isDraggingV, setIsDraggingV] = useState<boolean>(false);
  const [isDraggingTree, setIsDraggingTree] = useState<boolean>(false);
  const [isDraggingH, setIsDraggingH] = useState<boolean>(false);
  const [isDraggingAi, setIsDraggingAi] = useState<boolean>(false);

  // With the file panel hidden the command line separator sizes the folder tree; when the file panel comes back
  // the tree goes back within the tree separator's own limit (40%) so the file panel has room
  useEffect(() => {
    if (!showFilePanel || !appRef.current) return;
    const max = appRef.current.getBoundingClientRect().width * 0.4;
    setTreeWidthPx((w) => Math.min(w, Math.max(150, max)));
  }, [showFilePanel]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!appRef.current) return;
    const bounds = appRef.current.getBoundingClientRect();

    if (isDraggingV) {
      const mouseX = e.clientX - bounds.left;
      const newPct = (mouseX / bounds.width) * 100;
      if (newPct > 15 && newPct < 85) {
        // Without the file panel the left column is just the folder tree, whose width is in pixels
        if (showFilePanel) setLeftWidthPct(newPct);
        else if (mouseX > 100) setTreeWidthPx(mouseX);
      }
    } else if (isDraggingTree) {
      const mouseX = e.clientX - bounds.left;
      if (mouseX > 100 && mouseX < bounds.width * 0.4) {
        setTreeWidthPx(mouseX);
      }
    } else if (isDraggingAi) {
      const h = bounds.bottom - e.clientY - 24; // subtract status bar
      if (h > 140 && h < bounds.height - 180) {
        setAssistantHeightPx(h);
      }
    } else if (isDraggingH) {
      const mouseY = bounds.bottom - e.clientY - 24; // subtract status bar
      if (mouseY > 100 && mouseY < bounds.height - 150) {
        setPreviewHeightPx(mouseY);
      }
    }
  };

  const handleMouseUp = () => {
    setIsDraggingV(false);
    setIsDraggingTree(false);
    setIsDraggingH(false);
    setIsDraggingAi(false);
  };

  return {
    appRef,
    leftWidthPct,
    treeWidthPx,
    previewHeightPx,
    assistantHeightPx,
    isDraggingV,
    isDraggingTree,
    isDraggingH,
    isDraggingAi,
    startV: () => setIsDraggingV(true),
    startTree: () => setIsDraggingTree(true),
    startH: () => setIsDraggingH(true),
    startAi: () => setIsDraggingAi(true),
    handleMouseMove,
    handleMouseUp,
  };
}

/** Quick Access: what the bar shows is saved (max QA_MAX items). Nothing saved yet = Home, Desktop, Downloads,
 *  Documents and the C: drive. A saved empty list is a real choice (everything unchecked in Settings). */
export function useQuickAccess(showSettings: boolean) {
  const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([]);
  const [qaCandidates, setQaCandidates] = useState<QuickAccessItem[]>([]); // the built-in choices: folders + drives
  const loadQaCandidates = () =>
    invoke<QuickAccessItem[]>('get_quick_access')
      .then((qa) => {
        setQaCandidates(qa);
        return qa;
      })
      .catch((err) => {
        console.error('Quick access error:', err);
        return [] as QuickAccessItem[];
      });
  useEffect(() => {
    const saved = parseSaved(localStorage.getItem(QA_KEY));
    if (saved) setQuickAccess(saved);
    loadQaCandidates().then((qa) => {
      if (saved) return;
      const initial = defaultQuickAccess(qa);
      setQuickAccess(initial);
      localStorage.setItem(QA_KEY, JSON.stringify(initial));
    });
  }, []);
  // drives can come and go: look again whenever Settings opens
  useEffect(() => {
    if (showSettings) loadQaCandidates();
  }, [showSettings]);

  const saveQuickAccess = (list: QuickAccessItem[]) => {
    setQuickAccess(list);
    localStorage.setItem(QA_KEY, JSON.stringify(list));
  };

  const handleAddQuickAccess = (item: { label: string; path: string; icon_type?: string }) => {
    if (quickAccess.length >= QA_MAX) {
      alert(`Quick Access is limited to a maximum of ${QA_MAX} items. Remove one in Settings, Quick Access, or by right-click.`);
      return;
    }
    if (isShown(quickAccess, { label: item.label, path: item.path, icon_type: '' })) {
      alert('This item is already in Quick Access.');
      return;
    }
    saveQuickAccess([...quickAccess, { label: item.label, path: item.path, icon_type: item.icon_type || 'folder' }]);
  };

  const handleRemoveQuickAccess = (path: string) => {
    saveQuickAccess(quickAccess.filter((q) => !samePath(q.path, path)));
  };

  return { quickAccess, qaCandidates, saveQuickAccess, handleAddQuickAccess, handleRemoveQuickAccess };
}

/** Frequently Accessed folders: visit counts (always counted, even while the panel is hidden) and its settings.
 *  Every time a different folder becomes the current one it counts as one visit; refresh and search keep the
 *  path, so they do not count. */
/** `skipNextRef`: set before a folder change that is not a visit (switching between two panes) */
export function useFrequent(currentPath: string, skipNextRef?: React.MutableRefObject<boolean>) {
  const [freqStats, setFreqStats] = useState<FrequentStats>(loadStats);
  const [freqSettings, setFreqSettings] = useState<FrequentSettings>(loadFrequentSettings);
  const freqStatsRef = useRef(freqStats);
  freqStatsRef.current = freqStats;
  const updateFreqStats = (next: FrequentStats) => {
    setFreqStats(next);
    saveStats(next);
  };
  const updateFreqSettings = (next: FrequentSettings) => {
    setFreqSettings(next);
    saveFrequentSettings(next);
  };
  useEffect(() => {
    if (!currentPath) return;
    if (skipNextRef?.current) {
      skipNextRef.current = false;
      return;
    }
    const next = recordVisit(freqStatsRef.current, currentPath);
    freqStatsRef.current = next;
    updateFreqStats(next);
  }, [currentPath]);
  // a folder that can no longer be opened (deleted, drive gone) should not stay in Frequently Accessed
  const forgetFolder = (path: string) => {
    const next = removeVisit(freqStatsRef.current, path);
    if (next !== freqStatsRef.current) {
      freqStatsRef.current = next;
      updateFreqStats(next);
    }
  };
  return { freqStats, freqSettings, updateFreqStats, updateFreqSettings, forgetFolder };
}

/** The drives with their space (drives.rs): the Folder Tree's drive rows and the This PC view. Loaded at start,
 *  on window focus and each time the view opens. */
export function useDrives() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [thisPC, setThisPCState] = useState(false);
  const thisPCRef = useRef(false);
  thisPCRef.current = thisPC;
  const setThisPC = (on: boolean) => {
    thisPCRef.current = on;
    setThisPCState(on);
  };
  const loadDrives = () => {
    invoke<DriveInfo[]>('get_drives')
      .then(setDrives)
      .catch(() => {});
  };
  useEffect(() => {
    loadDrives();
    window.addEventListener('focus', loadDrives);
    return () => window.removeEventListener('focus', loadDrives);
  }, []);
  return { drives, loadDrives, thisPC, setThisPC, thisPCRef };
}
