import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { HeaderBar } from './components/HeaderBar';
import { SearchBar } from './components/SearchBar';
import { QuickAccessBar } from './components/QuickAccessBar';
import { FolderTree } from './components/FolderTree';
import { MainFilePanel } from './components/MainFilePanel';
import { PreviewPanel } from './components/PreviewPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { StatusBar } from './components/StatusBar';
import { ThisPCView } from './components/ThisPCView';
import { SettingsPanel } from './components/SettingsPanel';
import { FrequentPanel } from './components/FrequentPanel';
import { AssistantPanel } from './components/AssistantPanel';
import { PasteConflictDialog } from './components/PasteConflictDialog';
import { PasteProgress } from './components/PasteProgress';
import type { Section as SettingsSection } from './components/SettingsPanel';
import { AssistantHost } from './assistant';
import { layoutItems, topGroupIds } from './grouping';
import { QA_MAX, defaultQuickAccess, samePath } from './quickAccess';
import { BulkRenameDialog } from './components/BulkRenameDialog';
import { resetGlobalVars } from './globalVars';
import {
  RenameBatch,
  RenameOp,
  RulesForm,
  UndoResult,
  MAX_BATCHES,
  loadRenameHistory,
  saveRenameHistory,
} from './bulkRename';
import { addMessage, basketName, isBasket, parentDir } from './basket';
import { FileItem, FileListResult, TermTab } from './types';
import { topFolders } from './frequent';
import { DEFAULT_PREFS, sortClick, sortSet, sortRemove } from './columns';
import { useTerminalTabs } from './hooks/useTerminalTabs';
import { useCommandLine } from './hooks/useCommandLine';
import { useViewSettings } from './hooks/useViewSettings';
import { useFileDetails } from './hooks/useFileDetails';
import { useFolderSizes, formatTotalSize } from './hooks/useFolderSizes';
import { useDrives, useFrequent, useQuickAccess, useSplitters, useWindowSetup } from './hooks/usePanels';
import { usePaste } from './hooks/usePaste';
import { useDualPane } from './hooks/useDualPane';
import { CommandPalette } from './components/CommandPalette';
import { PaletteItem, loadRecent, pathFromQuery, pushRecent, saveRecent, splitPrefix } from './palette';
import type { CommandItem } from './commands';
import { lastName } from './folderSizes';
import { Side, sameFolder, transferProblem, transferQuestion } from './dualPane';
import { useUpdater } from './hooks/useUpdater';
import { UpdateNotice } from './components/UpdateNotice';

// The app's state lives here and in the hooks of src/hooks (one per area: command line tabs, commands and
// variables, view settings, file details, folder sizes, paste, smaller panels). What stays here is the core that
// ties them together: the folder on screen, the selection, navigation, baskets, search and the layout.
export function App() {
  const [currentPath, setCurrentPath] = useState<string>('');
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [rawItems, setRawItems] = useState<FileItem[]>([]);
  // The latest real listing of a folder (never search results): the folder tree takes that folder's sub-folders
  // from it, so a folder renamed, added or deleted there shows in the tree too.
  const [treeListing, setTreeListing] = useState<{ path: string; items: FileItem[] } | null>(null);
  // selectedItem = focused item (preview, title, status); selectedPaths = full multi-selection
  const [selectedItem, setSelectedItem] = useState<FileItem | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null); // Shift+Click range start
  // An open basket (basket.rs): the file panel lists its links instead of the folder. `trail` = the linked folders
  // opened inside it (empty = its top level). The current folder stays the basket's own folder, so the command
  // line stays there too (a basket is not a folder on disk).
  const [basketView, setBasketViewState] = useState<{ path: string; trail: string[] } | null>(null);
  const basketViewRef = useRef(basketView);
  const setBasketView = (v: { path: string; trail: string[] } | null) => {
    basketViewRef.current = v;
    setBasketViewState(v);
  };
  const [basketCounts, setBasketCounts] = useState<{ links: number; gone: number; new: number } | null>(null);
  const [totalFiles, setTotalFiles] = useState<number>(0);
  const [totalFolders, setTotalFolders] = useState<number>(0);
  const [totalSize, setTotalSize] = useState<number>(0);

  // UI Modes, Toggles & Theme (Persisted in localStorage), sort, columns and grouping
  const {
    theme,
    setTheme,
    viewMode,
    setViewMode,
    sortLevels,
    updateSort,
    colPrefs,
    updatePrefs,
    groups,
    updateGroups,
    groupColumn,
    collapsed,
    setCollapsed,
    toggleGroup,
    setDateMode,
    hideColumn,
  } = useViewSettings();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [includeSubfolders, setIncludeSubfolders] = useState<boolean>(true);
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [showFilePanel, setShowFilePanel] = useState<boolean>(true); // Controls Middle File Panel
  // The search bar at the bottom of the file panel (header's Toggle Search Bar). Closing it clears the search;
  // opening it also shows the file panel if that was hidden, since the bar lives there.
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const toggleSearch = () => {
    if (showSearch && showFilePanel) {
      setShowSearch(false);
      if (searchQuery) setSearchQuery('');
    } else {
      setShowSearch(true);
      setShowFilePanel(true);
    }
  };
  // A query set from outside (the AI Assistant) opens the search bar so the user sees it
  useEffect(() => {
    if (searchQuery && !showSearch) setShowSearch(true);
  }, [searchQuery]);
  const [showTerminal, setShowTerminal] = useState<boolean>(true); // command line panel (hidden, not closed: the shell keeps running)
  // AI Assistant panel, under the command line panel (remembered between runs)
  const [showAssistant, setShowAssistant] = useState<boolean>(() => localStorage.getItem('boonsh_ai_panel') === '1');
  const toggleAssistant = (on = !showAssistant) => {
    setShowAssistant(on);
    localStorage.setItem('boonsh_ai_panel', on ? '1' : '0');
  };
  // "Ask AI" in the command line's right-click menu: show the panel and hand it the selected text
  const [askAiRequest, setAskAiRequest] = useState<{ id: number; text: string; send: boolean } | null>(null);
  const askAi = (text: string, send: boolean) => {
    toggleAssistant(true);
    setAskAiRequest((prev) => ({ id: (prev?.id ?? 0) + 1, text, send }));
  };
  const rightShown = showTerminal || showAssistant; // the right column holds the command line and the assistant
  const [shellEngine] = useState<string>('PowerShell 7');

  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [settingsStart, setSettingsStart] = useState<SettingsSection>('commands');
  const openSettings = (section: SettingsSection = 'commands') => {
    setSettingsStart(section);
    setShowSettings(true);
  };
  // Command template (with {SELEC}/{DEST}) sitting untouched at the prompt. While it is set, the typed line can be
  // rewritten when a variable or the folder changes. The terminal clears it as soon as the user types.
  const pendingCmdRef = useRef<string | null>(null);

  const {
    appRef,
    leftWidthPct,
    treeWidthPx,
    previewHeightPx,
    assistantHeightPx,
    isDraggingV,
    isDraggingTree,
    isDraggingH,
    isDraggingAi,
    startV,
    startTree,
    startH,
    startAi,
    handleMouseMove,
    handleMouseUp,
  } = useSplitters(showFilePanel);
  const { quickAccess, qaCandidates, saveQuickAccess, handleAddQuickAccess, handleRemoveQuickAccess } = useQuickAccess(showSettings);
  const skipVisitRef = useRef(false); // a switch between two panes is not a visit
  const { freqStats, freqSettings, updateFreqStats, updateFreqSettings, forgetFolder } = useFrequent(currentPath, skipVisitRef);
  // ---- This PC (drives.rs, ThisPCView) ----
  // After a click on "This PC" (or Up at the top of a drive), the This PC view in place of the file list. The
  // folder (and the terminal) stay where they were; file keys and Paste do nothing there.
  const { drives, loadDrives, thisPC, setThisPC, thisPCRef } = useDrives();
  useWindowSetup(currentPath, selectedItem?.path);
  const normalizePath = (p: string) => p.toLowerCase().replace(/\\+$/, '');

  const selectSingle = (item: FileItem | null) => {
    setSelectedItem(item);
    setSelectedPaths(item ? new Set([item.path]) : new Set());
    selectionAnchorRef.current = item ? item.path : null;
  };

  // Fetch Directory Contents
  const lastRequestedPathRef = useRef<string | null>(null);
  // selectPaths: select these items after loading (e.g. freshly pasted files) instead of the first item
  // Resolves true when the folder was loaded, false when it could not be opened.
  const fetchDirectory = (targetPath?: string, selectPaths?: string[]): Promise<boolean> => {
    if (targetPath) lastRequestedPathRef.current = targetPath;
    return invoke<FileListResult>('list_directory', { targetPath: targetPath || null })
      .then((res) => {
        lastRequestedPathRef.current = res.current_path;
        if (basketViewRef.current) {
          // a folder listing replaces an open basket (navigation, refresh of the folder ...)
          setBasketView(null);
          setBasketCounts(null);
        }
        setCurrentPath(res.current_path);
        setParentPath(res.parent_path);
        setRawItems(res.items);
        setThisPC(false); // a folder opened: leave the This PC view
        setTreeListing({ path: res.current_path, items: res.items });
        setTotalFiles(res.total_files);
        setTotalFolders(res.total_folders);
        setTotalSize(res.total_size);
        const wanted = new Set((selectPaths ?? []).map(normalizePath));
        const matches = res.items.filter((i) => wanted.has(normalizePath(i.path)));
        if (matches.length > 0) {
          setSelectedItem(matches[0]);
          setSelectedPaths(new Set(matches.map((i) => i.path)));
          selectionAnchorRef.current = matches[0].path;
        } else {
          selectSingle(res.items.length > 0 ? res.items[0] : null);
        }
        return true;
      })
      .catch((err) => {
        console.error('List directory error:', err);
        // a folder that can no longer be opened (deleted, drive gone) should not stay in Frequently Accessed
        // a folder that can no longer be opened (deleted, drive gone) should not stay in Frequently Accessed
        if (targetPath) forgetFolder(targetPath);
        return false;
      });
  };

  useEffect(() => {
    fetchDirectory();
  }, []);
  // The file panel follows the tab: show the folder the tab's shell is in
  const followTab = (t: TermTab) => {
    if (t.cwd && normalizePath(t.cwd) !== normalizePath(currentPathRef.current)) fetchDirectory(t.cwd);
  };

  const {
    tabs,
    activeTabId,
    tabsRef,
    activeTabIdRef,
    atPromptRef,
    heldCdRef,
    updateTabs,
    ptyWrite,
    newTab,
    splitTab,
    splitPane,
    selectTab,
    removeTab,
    closeTab,
    closePane,
    closeAllTabs,
    switchTabLevel,
    spawnFailed,
    renameTab,
    recolorTab,
    moveTab,
  } = useTerminalTabs({ currentPathRef, pendingCmdRef, onFollow: followTab });
  // The folder the active screen's shell is in: command templates are expanded against it (`.\name` paths), which
  // is not always the file panel's folder (switching between two panes does not move the shell)
  const shellCwdRef = {
    get current() {
      return tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.cwd || currentPathRef.current;
    },
    set current(_v: string) {},
  };
  const {
    commandGroups,
    handleCommandGroupsChange,
    resetCommands,
    globalVars,
    pathVars,
    pathVarsRef,
    constVars,
    handleGlobalVarsChange,
    handleConstVarsChange,
    assignPathVar,
    rewritePromptLine,
    expandCommand,
    pickCommand,
  } = useCommandLine({ ptyWrite, currentPathRef: shellCwdRef, pendingCmdRef });
  // History Commands: put an earlier command of the active screen on its prompt line (replacing what is typed
  // there) for the user to review and run. Not while a program runs: the keys would go to that program.
  const typeFromHistory = async (text: string) => {
    const id = activeTabIdRef.current;
    if (!id) return;
    if (atPromptRef.current[id] === false) {
      alert('A program is still running in this screen. Wait for the prompt, then pick the command again.');
      return;
    }
    pendingCmdRef.current = null;
    await rewritePromptLine(text);
  };

  // Bi-directional navigation: Navigate GUI & send cd command to the active tab's PowerShell
  // selectPaths: select these after opening (Open file location from a basket)
  const handleNavigate = (path: string, selectPaths?: string[]): Promise<boolean> => {
    const id = activeTabIdRef.current;
    // The shell follows only once the folder has opened: a folder that was renamed or deleted meanwhile (an old
    // name in the folder tree) would otherwise just give a "path does not exist" error at the prompt.
    return fetchDirectory(path, selectPaths).then((ok) => {
      if (ok && id && activeTabIdRef.current === id) shellFollow(id, path);
      return ok;
    });
  };

  const shellFollow = (id: string, path: string) => {
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, cwd: path } : t)));
    if (atPromptRef.current[id] === false) {
      heldCdRef.current[id] = path;
      return;
    }
    heldCdRef.current[id] = null;
    // A command still waiting at the prompt is cleared first (else the cd would be glued onto it) and typed
    // again afterwards, with its paths made relative to the new folder.
    const template = pendingCmdRef.current;
    if (template === null) {
      ptyWrite(`cd "${path}"\r`).catch(() => {});
      return;
    }
    (async () => {
      await rewritePromptLine(`cd "${path}"\r`);
      await ptyWrite(await expandCommand(template, pathVarsRef.current, path));
    })().catch(() => {});
  };

  // Shell -> GUI: a tab's prompt reported its cwd (e.g. after a typed `cd`).
  // Skip when it matches the last requested folder so a GUI-initiated cd doesn't refetch/reset selection.
  const handleShellCwdChange = (id: string, path: string) => {
    // The program ended and the prompt is back in the old folder: take the shell to the folder the GUI is in now
    const held = heldCdRef.current[id] ?? null;
    if (held !== null) {
      heldCdRef.current[id] = null;
      if (normalizePath(path) !== normalizePath(held)) {
        invoke('pty_write', { id, data: `cd "${held}"\r` }).catch(() => {});
      }
      return;
    }
    // Remember where this tab is, so switching back to it shows that folder
    const before = tabsRef.current.find((t) => t.id === id)?.cwd ?? '';
    if (tabsRef.current.some((t) => t.id === id && t.cwd !== path)) {
      updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, cwd: path } : t)));
    }
    if (id !== activeTabIdRef.current) return; // a tab in the background does not move the file panel
    // Only a shell that moved (a typed cd) moves the file panel: with two panes the shell stays in its folder when
    // the user switches panes, so a prompt in the same folder as before must not pull the active pane back.
    if (before && normalizePath(path) === normalizePath(before)) return;
    const last = lastRequestedPathRef.current;
    if (last === null || normalizePath(path) !== normalizePath(last)) {
      fetchDirectory(path);
    }
  };

  const handleOpenFile = (file: FileItem) => {
    if (file.state) return; // a gone or new item in a basket: nothing to open until the user decides
    if (isBasket(file)) {
      openBasket(file.path);
      return;
    }
    selectSingle(file);
    invoke('open_in_default_app', { path: file.path }).catch((err) => {
      console.error('Failed to open file in default app:', err);
    });
  };

  // ---- Cut / Copy / Paste (paste.rs, hooks/usePaste.ts) ----
  const { clipboard, setClipboard, pasteItems, transfer, pasteError, clashPrompt, jobs: pasteJobs, cancelJob, pauseJob, startJobNow } = usePaste({
    currentPathRef,
    basketViewRef,
    addToBasket: (basket, paths) => addToBasket(basket, paths),
    // show the pasted items selected, unless the user has gone to another folder meanwhile (a long copy)
    reload: (dest, selectPaths) => {
      if (!basketViewRef.current && normalizePath(currentPathRef.current) === normalizePath(dest)) fetchDirectory(dest, selectPaths);
      reloadOtherPane(dest, selectPaths);
    },
    notify: (message) => setRenameToast({ message, undoable: false }),
  });
  // ---- Baskets (basket.rs / basket.ts) ----
  // Open a basket: its own folder becomes the current folder (so the command line is there), then its links show.
  const openBasket = async (path: string) => {
    const dir = parentDir(path);
    if (normalizePath(dir) !== normalizePath(currentPathRef.current)) {
      if (!(await handleNavigate(dir))) return;
    }
    setSearchQuery('');
    setBasketView({ path, trail: [] });
  };
  // A linked folder inside the open basket (still in basket mode), or a real folder outside one
  const openDirectory = (path: string) => {
    const bv = basketViewRef.current;
    if (bv) setBasketView({ ...bv, trail: [...bv.trail, path] });
    else handleNavigate(path);
  };
  const leaveBasket = () => {
    setBasketView(null);
    setBasketCounts(null);
    fetchDirectory(currentPathRef.current);
  };
  // Up: one linked folder back, then out of the basket into its folder
  const basketUp = () => {
    const bv = basketViewRef.current;
    if (!bv) return;
    if (bv.trail.length > 0) setBasketView({ ...bv, trail: bv.trail.slice(0, -1) });
    else leaveBasket();
  };

  // Show the open basket (or the linked folder opened inside it). quiet = keep the selection (auto refresh).
  const loadBasket = async (v = basketViewRef.current, selectPaths?: string[], quiet = false) => {
    if (!v) return;
    try {
      const res = await invoke<{ items: FileItem[]; links: number; gone: number; new: number }>('basket_view', {
        basket: v.path,
        folder: v.trail[v.trail.length - 1] ?? null,
      });
      if (basketViewRef.current !== v) return; // the user moved on meanwhile
      setRawItems(res.items);
      setBasketCounts({ links: res.links, gone: res.gone, new: res.new });
      const byPath = new Map(res.items.map((i) => [i.path, i]));
      const wanted = (selectPaths ?? []).filter((p) => byPath.has(p));
      if (wanted.length > 0) {
        setSelectedItem(byPath.get(wanted[0]) ?? null);
        setSelectedPaths(new Set(wanted));
        selectionAnchorRef.current = wanted[0];
      } else if (quiet) {
        setSelectedPaths((prev) => {
          const kept = [...prev].filter((p) => byPath.has(p));
          return kept.length === prev.size ? prev : new Set(kept);
        });
        setSelectedItem((prev) => (prev ? byPath.get(prev.path) ?? null : null));
      } else {
        selectSingle(res.items.find((i) => !i.state) ?? null);
      }
    } catch (err) {
      // the basket file itself is gone or unreadable: back to its folder
      if (basketViewRef.current === v) {
        leaveBasket();
        if (!quiet) alert(String(err));
      }
    }
  };
  const refreshView = () => {
    if (thisPCRef.current) {
      loadDrives();
      return;
    }
    if (basketViewRef.current) {
      if (searchQueryRef.current.trim()) setSearchRefreshTick((t) => t + 1);
      else loadBasket();
    } else {
      fetchDirectory(currentPathRef.current);
      // Refresh measures the folders again from scratch (changes deep inside are not watched)
      const path = currentPathRef.current;
      if (path) invoke('folder_sizes_forget', { path, levels: 0xffffffff }).catch(() => {}).finally(remeasure);
    }
  };

  const loadBasketRef = useRef(loadBasket);
  loadBasketRef.current = loadBasket;

  const basketToast = (message: string) => setRenameToast({ message, undoable: false });

  // Add links to a basket (paste, drag and drop, Link). A cut is cancelled: nothing moves into a basket.
  const addToBasket = async (basket: string, paths: string[]) => {
    try {
      const r = await invoke<{ added: number; already: number; refused: string[] }>('basket_add', { basket, paths });
      if (r.refused.length) alert(addMessage(r));
      else basketToast(`${basketName(basket)}: ${addMessage(r)}`);
    } catch (err) {
      alert(String(err));
    }
    if (clipboard?.mode === 'cut') setClipboard(null);
    if (basketViewRef.current) loadBasket(undefined, undefined, true);
    else reloadQuietly(); // the basket's link count
  };
  const pasteIntoBasket = (basket: string) => {
    if (clipboard) addToBasket(basket, clipboard.paths);
  };

  const basketCall = async (cmd: string, args: Record<string, unknown>, selectPaths?: string[]) => {
    const bv = basketViewRef.current;
    if (!bv) return;
    try {
      await invoke(cmd, { basket: bv.path, ...args });
    } catch (err) {
      alert(String(err));
    }
    loadBasket(bv, selectPaths, true);
  };
  // Remove links (Delete key, Clear): the files stay where they are
  const removeFromBasket = (items: FileItem[]) => {
    if (items.length) basketCall('basket_remove', { paths: items.map((i) => i.path) });
  };
  const linkInBasket = (items: FileItem[]) => {
    if (items.length) basketCall('basket_add', { paths: items.map((i) => i.path) }, items.map((i) => i.path));
  };
  // The real files go to the Recycle Bin (only their linked parts), and their links go
  const deleteBasketFiles = (items: FileItem[]) => {
    const linked = items.filter((i) => !i.state);
    if (!linked.length) return;
    const places = [...new Set(linked.map((i) => parentDir(i.path)))];
    const where = places.slice(0, 3).join(', ') + (places.length > 3 ? ` and ${places.length - 3} more` : '');
    const what = linked.length === 1 ? `'${linked[0].name}'` : `${linked.length} items`;
    if (!confirm(`Move ${what} from ${where} to the Recycle Bin?\n\nThese are the real files, not only the links.`)) return;
    basketCall('basket_delete_files', { paths: linked.map((i) => i.path) });
  };
  // Point a gone link at where the item is now (the user picks it)
  const relinkInBasket = async (item: FileItem) => {
    const picked = await invoke<string | null>(item.is_dir ? 'pick_folder' : 'pick_file', {
      title: `Where is ${item.name} now?`,
      ...(item.is_dir ? {} : { filter: 'All files (*.*)|*.*' }),
    }).catch((err) => {
      alert(String(err));
      return null;
    });
    if (picked) basketCall('basket_relink', { oldPath: item.path, newPath: picked }, [picked]);
  };
  // New -> Basket in the file panel (the current folder) or the folder tree (the folder right-clicked there):
  // the new basket is shown selected in that folder with its Rename box open
  const createBasket = (folder?: string) => {
    const dir = folder || currentPathRef.current;
    if (!dir) return;
    invoke<string>('basket_create', { parentDir: dir })
      .then((path) => fetchDirectory(dir, [path]).then(() => setRenameTrigger((t) => t + 1)))
      .catch((err) => alert(String(err)));
  };
  // Single rename from the file panel: in a basket the link follows the item
  const handleRenamed = (from: string, to: string) => {
    const bv = basketViewRef.current;
    if (bv) {
      invoke('basket_update_paths', { basket: bv.path, pairs: [[from, to]] })
        .catch((err) => alert(String(err)))
        .finally(() => loadBasket(bv, [to], true));
    } else refreshAfterRename([to]);
  };

  // Search / filter (query language in src-tauri/src/search.rs). Debounced; only the latest request's
  // result is applied, so a slow deep search can't overwrite a newer one.
  const [searchError, setSearchError] = useState<string>('');
  const [searchNotice, setSearchNotice] = useState<string>(''); // part of the query was skipped (not an error)
  const [searching, setSearching] = useState<boolean>(false); // folder-size scans can take a while
  const [searchRefreshTick, setSearchRefreshTick] = useState<number>(0); // bump to re-run the current search
  const searchSeqRef = useRef(0);
  // input:<places> reads the current folder (relative places) and Global Var values; re-run the search when they change
  const searchInputKey = /input:/i.test(searchQuery) ? JSON.stringify([currentPath, pathVars]) : '';
  // An open basket (and the level inside it) is listed and searched instead of the folder
  const basketKey = basketView ? [basketView.path, ...basketView.trail].join('|') : '';
  const prevBasketKeyRef = useRef(basketKey);
  const skipSearchReloadRef = useRef(false); // a pane switch clears the search and opens the folder itself
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    const q = searchQuery.trim();
    // leaving a basket loads the folder itself (leaveBasket / navigation), so that change alone loads nothing here
    const basketChanged = prevBasketKeyRef.current !== basketKey;
    prevBasketKeyRef.current = basketKey;
    const bv = basketViewRef.current;
    if (!currentPath) return;
    if (q.length === 0) {
      setSearchError('');
      setSearchNotice('');
      setSearching(false);
      if (skipSearchReloadRef.current) skipSearchReloadRef.current = false;
      else if (bv) loadBasket(bv);
      else if (!basketChanged) fetchDirectory(currentPath);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      const request = bv
        ? invoke<FileItem[]>('basket_search', {
            basket: bv.path,
            folder: bv.trail[bv.trail.length - 1] ?? null,
            query: q,
            includeSubfolders,
          }).then((items) => ({ items, notice: '' }))
        : invoke<{ items: FileItem[]; notice: string }>('search_files', {
            dir: currentPath,
            query: q,
            includeSubfolders,
            vars: pathVarsRef.current,
          });
      request
        .then((res) => {
          if (seq !== searchSeqRef.current) return;
          setSearchError('');
          setSearchNotice(res.notice);
          setRawItems(res.items);
        })
        .catch((err) => {
          if (seq !== searchSeqRef.current) return;
          setSearchError(String(err));
        })
        .finally(() => {
          if (seq === searchSeqRef.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, includeSubfolders, searchRefreshTick, searchInputKey, basketKey]);

  // Auto refresh (dir_watch.rs): another program added, changed or removed something in the open folder. Reload
  // the list quietly: selection, focus and scroll stay, unchanged items keep their objects (so the preview and the
  // details columns are not redone). Skipped while a search is shown: its results are not this folder's listing.
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const reloadQuietly = () => {
    const path = currentPathRef.current;
    if (!path || searchQueryRef.current.trim()) return;
    if (basketViewRef.current) {
      loadBasket(undefined, undefined, true); // e.g. a basket-add command changed the basket file
      return;
    }
    invoke<FileListResult>('list_directory', { targetPath: path })
      .then((res) => {
        if (normalizePath(res.current_path) !== normalizePath(currentPathRef.current) || searchQueryRef.current.trim()) return;
        const same = (a: FileItem, b: FileItem) =>
          a.name === b.name && a.size === b.size && a.modified_timestamp === b.modified_timestamp && a.is_hidden === b.is_hidden;
        const byPath = new Map(res.items.map((i) => [i.path, i]));
        setRawItems((prev) => {
          const old = new Map(prev.map((i) => [i.path, i]));
          let changed = prev.length !== res.items.length;
          const next = res.items.map((i) => {
            const o = old.get(i.path);
            if (o && same(o, i)) return o;
            changed = true;
            return i;
          });
          return changed ? next : prev;
        });
        setTreeListing({ path: res.current_path, items: res.items });
        setTotalFiles(res.total_files);
        setTotalFolders(res.total_folders);
        setTotalSize(res.total_size);
        setSelectedPaths((prev) => {
          const kept = [...prev].filter((p) => byPath.has(p));
          return kept.length === prev.size ? prev : new Set(kept);
        });
        setSelectedItem((prev) => {
          const now = prev ? byPath.get(prev.path) : undefined;
          if (!prev || !now) return null;
          return same(prev, now) ? prev : now;
        });
      })
      .catch(() => {}); // the folder itself is gone: leave the list as it is (F5 or navigation shows the error)
  };
  const reloadQuietlyRef = useRef(reloadQuietly);
  reloadQuietlyRef.current = reloadQuietly;
  useEffect(() => {
    invoke('watch_directory', { path: currentPath || null }).catch(() => {});
  }, [currentPath]);
  useEffect(() => {
    const unlisten = listen<{ path: string }>('dir-changed', (e) => {
      if (normalizePath(e.payload.path) === normalizePath(currentPathRef.current)) reloadQuietlyRef.current();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const openThisPC = () => {
    if (basketViewRef.current) {
      setBasketView(null);
      setBasketCounts(null);
    }
    if (searchQueryRef.current.trim()) setSearchQuery('');
    selectSingle(null);
    setThisPC(true);
    loadDrives();
  };
  const thisPCShown = thisPC && !searchQuery.trim();

  const inFolderView = !basketView && !searchQuery.trim();
  const { sizedItems, sizeStatus, remeasure } = useFolderSizes({
    currentPath,
    currentPathRef,
    parentPath,
    rawItems,
    sizesOn: colPrefs.folderSizes,
    inFolderView,
    basketOpen: !!basketView,
    totalSize,
  });
  const { details, appByExt } = useFileDetails(rawItems, colPrefs, sortLevels, groups);
  // Sort Items logic (see columns.ts): folders first (optional), each sort level in turn, then the name
  const layout = useMemo(
    () => layoutItems(sizedItems, groups, sortLevels, colPrefs, details, collapsed),
    [sizedItems, groups, sortLevels, colPrefs, details, collapsed]
  );
  // the items in view order, without those folded away inside a collapsed group (selection works on these)
  const sortedItems = layout.flat;

  // ---- Two file panes (hooks/useDualPane.ts) ----
  const {
    dual,
    ratio: dualRatio,
    activeSide,
    other: otherPane,
    toggleDual,
    switchTo,
    toggleActive,
    reloadOther,
    setRatio: setDualRatio,
    saveRatio: saveDualRatio,
  } = useDualPane({
    getActive: () => ({
      path: currentPathRef.current,
      items: rawItems,
      selected: [...selectedPaths],
      plain: !basketViewRef.current && !searchQueryRef.current.trim() && !thisPCRef.current,
    }),
    navigate: async (path, select) => {
      if (searchQueryRef.current.trim()) {
        skipSearchReloadRef.current = true;
        setSearchQuery('');
      }
      skipVisitRef.current = true;
      // the terminal stays where it is (the user's choice): no cd on a switch
      const ok = await fetchDirectory(path, select);
      if (!ok) skipVisitRef.current = false;
      return ok;
    },
  });
  const otherLayout = useMemo(
    () => layoutItems(otherPane?.items ?? [], groups, sortLevels, colPrefs, details, collapsed),
    [otherPane?.items, groups, sortLevels, colPrefs, details, collapsed]
  );
  // a paste / F5 / F6 into the folder the other pane shows: list it again with the new items selected
  function reloadOtherPane(dest: string, selectPaths: string[]) {
    if (otherPane && sameFolder(otherPane.path, dest)) reloadOther(selectPaths);
  }
  // F5 / F6 (and a drop): copy or move to the other pane. In an open basket only its linked items go.
  const sendToOtherPane = async (move: boolean, paths = selectedItems.filter((i) => !i.state).map((i) => i.path), ask = true) => {
    if (!otherPane || thisPCRef.current) return;
    const problem = transferProblem(paths, currentPathRef.current, otherPane.path, move);
    if (problem) {
      alert(problem);
      return;
    }
    if (ask && !window.confirm(transferQuestion(paths, otherPane.path, move))) return;
    const bv = basketViewRef.current;
    try {
      const res = await transfer({ mode: move ? 'cut' : 'copy', paths, basket: bv?.path }, otherPane.path);
      const err = res && pasteError(res);
      if (err) alert(err.message);
    } catch (err) {
      alert(String(err));
    }
  };
  // A drop of boonsh items on a pane: copy there (Shift: move). Nothing happens on its own folder.
  const dropOnPane = (side: Side, e: React.DragEvent) => {
    if (e.defaultPrevented) return; // a basket row took it
    const raw = e.dataTransfer.getData('application/x-boonsh-paths');
    if (!raw) return;
    e.preventDefault();
    const paths = JSON.parse(raw) as string[];
    const dest = side === activeSide ? currentPathRef.current : otherPane?.path ?? '';
    if (!dest || paths.length === 0 || paths.every((p) => sameFolder(parentDir(p), dest))) return;
    if (side === activeSide) {
      if (basketViewRef.current) addToBasket(basketViewRef.current.path, paths);
      else if (!thisPCRef.current) {
        transfer({ mode: e.shiftKey ? 'cut' : 'copy', paths }, dest)
          .then((res) => {
            const err = res && pasteError(res);
            if (err) alert(err.message);
          })
          .catch((err) => alert(String(err)));
      }
      return;
    }
    const problem = transferProblem(paths, parentDir(paths[0]), dest, e.shiftKey);
    if (problem) {
      alert(problem);
      return;
    }
    transfer({ mode: e.shiftKey ? 'cut' : 'copy', paths }, dest)
      .then((res) => {
        const err = res && pasteError(res);
        if (err) alert(err.message);
      })
      .catch((err) => alert(String(err)));
  };
  const dualBoxRef = useRef<HTMLDivElement>(null);
  const startDualDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = dualBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => setDualRatio((ev.clientX - box.left) / box.width);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveDualRatio();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // linked items may have been moved or added elsewhere meanwhile: check the open basket again when the window
  // comes back
  useEffect(() => {
    const onFocus = () => {
      if (basketViewRef.current && !searchQueryRef.current.trim()) loadBasketRef.current(undefined, undefined, true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  // --- Multi-selection (Click / Ctrl+Click / Shift+Click / Ctrl+A) ---
  const selectedItems = sortedItems.filter((i) => selectedPaths.has(i.path));

  const handleItemClick = (item: FileItem, mods: { ctrlKey: boolean; shiftKey: boolean }) => {
    const anchor = selectionAnchorRef.current;
    const anchorIdx = anchor ? sortedItems.findIndex((i) => i.path === anchor) : -1;
    if (mods.shiftKey && anchorIdx >= 0) {
      const idx = sortedItems.findIndex((i) => i.path === item.path);
      const [from, to] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
      const range = sortedItems.slice(from, to + 1).map((i) => i.path);
      setSelectedPaths(new Set(mods.ctrlKey ? [...selectedPaths, ...range] : range));
      setSelectedItem(item); // anchor stays put so the range can be extended/shrunk
    } else if (mods.ctrlKey) {
      const next = new Set(selectedPaths);
      if (next.has(item.path)) {
        next.delete(item.path);
        const other = sortedItems.find((i) => next.has(i.path)) ?? null;
        setSelectedItem(other);
      } else {
        next.add(item.path);
        setSelectedItem(item);
      }
      setSelectedPaths(next);
      selectionAnchorRef.current = item.path;
    } else {
      selectSingle(item);
    }
  };

  // Right-click keeps an existing multi-selection if the item is part of it (like Explorer)
  const handleItemContextSelect = (item: FileItem) => {
    if (!selectedPaths.has(item.path)) selectSingle(item);
  };

  const selectAll = () => {
    if (sortedItems.length === 0) return;
    setSelectedPaths(new Set(sortedItems.map((i) => i.path)));
    if (!selectedItem) setSelectedItem(sortedItems[0]);
    selectionAnchorRef.current = sortedItems[0].path;
  };

  // --- Cut / Copy / Paste / Delete on the selection ---
  const clipboardSelection = (mode: 'copy' | 'cut') => {
    // in a basket only linked items can be copied (a gone or new one is not part of any action)
    const items = basketView ? selectedItems.filter((i) => !i.state) : selectedItems;
    if (items.length === 0) return;
    setClipboard({ mode, paths: items.map((i) => i.path), basket: basketView?.path });
  };

  // ---- Updates (updater.ts): the installer closes boonsh, which ends the programs running in its tabs ----
  const updater = useUpdater(() => {
    const running = tabsRef.current.filter((t) => atPromptRef.current[t.id] === false).length;
    return (
      running === 0 ||
      window.confirm(
        `Installing the update closes boonsh. ${running === 1 ? 'A program is' : `${running} programs are`} still running in the command line and will be stopped. Install now?`
      )
    );
  });

  const pasteClipboard = () => {
    pasteItems().catch((err) => alert(err instanceof Error ? err.message : String(err)));
  };

  // --- Zip: compress selection / extract selected .zip files (long-running; shown in status bar) ---
  const [busyMessage, setBusyMessage] = useState<string>('');
  const isZip = (i: FileItem) => !i.is_dir && i.ext.toLowerCase() === 'zip';
  const selectedZips = selectedItems.filter(isZip);

  // Resolves with the new zip's path
  const compressItems = async (items: FileItem[]): Promise<string> => {
    if (busyMessage) throw new Error('boonsh is still busy with another zip job.');
    const dest = currentPath;
    setBusyMessage(`Compressing ${items.length} item(s)...`);
    try {
      const zipPath = await invoke<string>('compress_to_zip', { paths: items.map((i) => i.path), destDir: dest });
      fetchDirectory(dest, [zipPath]);
      return zipPath;
    } finally {
      setBusyMessage('');
    }
  };
  const compressSelection = () => {
    if (selectedItems.length === 0 || !currentPath || busyMessage) return;
    const bv = basketViewRef.current;
    if (bv) {
      // only the linked items, in one zip named after the basket, next to it
      const linked = selectedItems.filter((i) => !i.state);
      if (!linked.length) return;
      setBusyMessage(`Compressing ${linked.length} item(s)...`);
      invoke<string>('basket_zip', { basket: bv.path, paths: linked.map((i) => i.path), destDir: currentPath })
        .then((zip) => basketToast(`Saved ${zip.split('\\').pop()} next to the basket.`))
        .catch((err) => alert(`Compress failed: ${err}`))
        .finally(() => setBusyMessage(''));
      return;
    }
    compressItems(selectedItems).catch((err) => alert(`Compress failed: ${err}`));
  };

  // Extracts each zip into a new folder; a zip that fails is reported through onError and the rest go on
  const extractZips = async (zips: FileItem[], onError: (msg: string) => void): Promise<number> => {
    if (busyMessage) throw new Error('boonsh is still busy with another zip job.');
    const dest = currentPath;
    const created: string[] = [];
    for (const zip of zips) {
      setBusyMessage(`Extracting ${zip.name}...`);
      try {
        created.push(await invoke<string>('extract_zip', { path: zip.path, destDir: dest }));
      } catch (err) {
        onError(`Extract failed for '${zip.name}': ${err}`);
      }
    }
    setBusyMessage('');
    fetchDirectory(dest, created);
    return created.length;
  };
  const extractSelectedZips = () => {
    if (selectedZips.length === 0 || !currentPath || busyMessage) return;
    extractZips(selectedZips, (msg) => alert(msg)).catch((err) => alert(err));
  };

  // --- Bulk rename (dialog in BulkRenameDialog.tsx, engine in bulk_rename.rs) and its undo history ---
  const [bulkRenamePaths, setBulkRenamePaths] = useState<string[] | null>(null);
  const [bulkRenameFolders, setBulkRenameFolders] = useState<number>(0); // folders among them (for "Include sub-folders")
  // Rules the AI Assistant filled in for the dialog (null = the dialog's usual empty start)
  const [bulkRenameForm, setBulkRenameForm] = useState<{ form: RulesForm; includeSub: boolean } | null>(null);
  const [renameTrigger, setRenameTrigger] = useState<number>(0); // F2 on one item: asks the file panel to open Rename
  const [renameHistory, setRenameHistory] = useState<RenameBatch[]>(loadRenameHistory); // newest first
  const [renameToast, setRenameToast] = useState<{ message: string; undoable: boolean } | null>(null);

  useEffect(() => {
    if (!renameToast) return;
    const t = setTimeout(() => setRenameToast(null), 15000);
    return () => clearTimeout(t);
  }, [renameToast]);

  // After a rename or undo: reload what's on screen (the search again if one is active)
  const refreshAfterRename = (selectPaths?: string[]) => {
    if (searchQuery.trim()) setSearchRefreshTick((t) => t + 1);
    else if (basketViewRef.current) loadBasket(basketViewRef.current, selectPaths, true);
    else fetchDirectory(currentPath, selectPaths);
  };
  // Renames made while a basket is open: its links follow them (the single renames in order, temporary names
  // included, so folder and content renames line up)
  const followRenames = async (ops: RenameOp[]) => {
    const bv = basketViewRef.current;
    if (!bv || ops.length === 0) return;
    await invoke('basket_update_paths', { basket: bv.path, pairs: ops.map((o) => [o.from, o.to]) }).catch((err) =>
      alert(String(err))
    );
  };

  const openBulkRename = () => {
    // 2 or more items, or one folder (to rename what is inside it, with "Include sub-folders")
    const items = basketView ? selectedItems.filter((i) => !i.state) : selectedItems;
    const ok = items.length >= 2 || (items.length === 1 && items[0].is_dir);
    if (!ok || busyMessage) return;
    setBulkRenameForm(null);
    setBulkRenamePaths(items.map((i) => i.path)); // in the panel's sort order: numbering follows it
    setBulkRenameFolders(items.filter((i) => i.is_dir).length);
  };

  const handleBulkRenamed = async (r: { renamed: number; ops: RenameOp[]; newPaths: string[] }) => {
    const batch: RenameBatch = { id: String(Date.now()), time: Date.now(), count: r.renamed, ops: r.ops };
    const history = [batch, ...renameHistory].slice(0, MAX_BATCHES);
    setRenameHistory(history);
    saveRenameHistory(history);
    setBulkRenamePaths(null);
    setRenameToast({ message: `Renamed ${r.renamed} item${r.renamed === 1 ? '' : 's'}.`, undoable: true });
    await followRenames(r.ops);
    refreshAfterRename(r.newPaths);
  };

  const undoLastBulkRename = (askFirst: boolean) => {
    const batch = renameHistory[0];
    if (!batch || busyMessage) return;
    if (askFirst && !confirm(`Undo the last bulk rename (${batch.count} items)?`)) return;
    setRenameToast(null);
    invoke<UndoResult>('bulk_rename_undo', { ops: batch.ops })
      .then(async (res) => {
        const rest = renameHistory.slice(1);
        setRenameHistory(rest);
        saveRenameHistory(rest);
        // undo replays the batch backwards with the ends swapped; an open basket's links follow it the same way
        await followRenames([...batch.ops].reverse().map((o) => ({ from: o.to, to: o.from })));
        refreshAfterRename();
        if (res.failed.length > 0) {
          const lines = res.failed.slice(0, 5).map((f) => `${f.to}: ${f.error}`);
          alert(
            `Undo restored part of the batch. ${res.failed.length} rename(s) could not be undone:\n\n${lines.join('\n')}` +
              (res.failed.length > 5 ? '\n...' : '')
          );
        } else {
          setRenameToast({ message: `Undone: ${batch.count} item${batch.count === 1 ? '' : 's'} restored.`, undoable: false });
        }
      })
      .catch((err) => alert(`Undo failed: ${err}`));
  };

  // Asks first; resolves false when the user says no
  const deleteItems = async (items: FileItem[]): Promise<boolean> => {
    const msg =
      items.length === 1 ? `Move '${items[0].name}' to Recycle Bin?` : `Move these ${items.length} items to Recycle Bin?`;
    if (!confirm(msg)) return false;
    await invoke('delete_items', { paths: items.map((i) => i.path) });
    fetchDirectory(currentPath);
    return true;
  };
  const deleteSelection = () => {
    if (selectedItems.length === 0) return;
    // in a basket, Delete removes the links only (the files stay; nothing to confirm)
    if (basketView) removeFromBasket(selectedItems);
    else deleteItems(selectedItems).catch((err) => alert(err));
  };

  // --- AI Assistant: the app's state and actions it may use (see assistant.ts). Rebuilt on every render and
  // read through a ref, so each tool call sees the state left by the one before it.
  const assistantHostRef = useRef<AssistantHost | null>(null);
  assistantHostRef.current = {
    currentPath,
    items: sortedItems,
    selected: selectedItems,
    sortLevels,
    groups,
    colPrefs,
    viewMode,
    theme,
    panels: { preview: showPreview, filePanel: showFilePanel, terminal: showTerminal },
    searchQuery,
    includeSubfolders,
    commandGroups,
    globalVars,
    pathVars,
    quickAccess,
    freqSettings,
    canUndoBulkRename: renameHistory.length > 0,
    hasClipboard: !!clipboard,
    navigate: handleNavigate,
    select: (paths) => {
      const first = sortedItems.find((i) => paths.includes(i.path)) ?? null;
      setSelectedItem(first);
      setSelectedPaths(new Set(paths));
      selectionAnchorRef.current = first?.path ?? null;
    },
    openItem: handleOpenFile,
    setSort: updateSort,
    setGroups: updateGroups,
    setPrefs: updatePrefs,
    setViewMode,
    setTheme,
    setPanels: (p) => {
      if (p.preview !== undefined) setShowPreview(p.preview);
      if (p.filePanel !== undefined) setShowFilePanel(p.filePanel);
      if (p.terminal !== undefined) setShowTerminal(p.terminal);
    },
    setSearch: (q, sub) => {
      setSearchQuery(q);
      if (sub !== undefined) setIncludeSubfolders(sub);
    },
    rename: async (item, newName) => {
      const to = await invoke<string>('rename_item', { oldPath: item.path, newName });
      refreshAfterRename([to]);
      return to;
    },
    createItem: async (kind, name) => {
      const path = await invoke<string>(kind === 'folder' ? 'create_new_folder' : 'create_new_file', { parentDir: currentPath, name });
      fetchDirectory(currentPath, [path]);
      return path;
    },
    openBulkRename: (items, form, includeSub) => {
      if (busyMessage) throw new Error('boonsh is busy with a zip job; try again when it is done.');
      setBulkRenameForm({ form, includeSub });
      setBulkRenamePaths(items.map((i) => i.path));
      setBulkRenameFolders(items.filter((i) => i.is_dir).length);
    },
    deleteItems,
    setClipboard: (mode, items) => setClipboard({ mode, paths: items.map((i) => i.path) }),
    paste: async () => (await pasteItems()).length,
    compress: compressItems,
    extract: async (zips) => {
      const errors: string[] = [];
      const n = await extractZips(zips, (m) => errors.push(m));
      if (errors.length) throw new Error(`${n} extracted. ${errors.join(' ')}`);
      return n;
    },
    insertCommand: async (text) => {
      const id = activeTabIdRef.current;
      if (!id) throw new Error('There is no command line tab.');
      if (atPromptRef.current[id] === false) throw new Error('A program is still running in the active command line tab; the command was not typed.');
      setShowTerminal(true);
      await pickCommand(text);
      // keep it as the pending line: a folder change then clears it, sends the cd and types it again, instead of
      // gluing the cd onto it (the user's first keystroke ends this, as for command templates)
      pendingCmdRef.current = text;
    },
    assignVar: (name, paths) => assignPathVar(name, paths),
    addQuickAccess: (path) => {
      if (quickAccess.length >= QA_MAX) return `Quick Access already has the maximum of ${QA_MAX} items. Remove one first.`;
      if (quickAccess.some((q) => samePath(q.path, path))) return 'That folder is already in Quick Access.';
      const label = path.replace(/\\+$/, '').split('\\').pop() || path;
      saveQuickAccess([...quickAccess, { label, path, icon_type: 'folder' }]);
      return '';
    },
    removeQuickAccess: (path) => {
      if (!quickAccess.some((q) => samePath(q.path, path))) return false;
      handleRemoveQuickAccess(path);
      return true;
    },
    setFreqSettings: updateFreqSettings,
    openSettings,
    undoBulkRename: () => undoLastBulkRename(true),
  };

  // ---- Command palette (Ctrl+Shift+P, components/CommandPalette.tsx, src/palette.ts) ----
  // One list of actions, saved commands, Global Vars, CONSTs, Quick Access, recent folders, drives and tabs. The
  // list is built on every render while it is open, so each entry acts on the current state.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteRecent, setPaletteRecent] = useState<string[]>(loadRecent);
  // a saved command (or a variable) picked in the palette: TerminalPanel runs it like a Commands-menu pick
  const [paletteRequest, setPaletteRequest] = useState<{ id: number; item: CommandItem } | null>(null);
  const paletteFocusRef = useRef<Element | null>(null);
  const openPalette = () => {
    paletteFocusRef.current = document.activeElement;
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    const el = paletteFocusRef.current as HTMLElement | null;
    if (el?.isConnected) el.focus?.();
  };
  const toast = (message: string) => setRenameToast({ message, undoable: false });
  const typeAtPrompt = (item: CommandItem) => {
    if (!showTerminal) setShowTerminal(true);
    setPaletteRequest({ id: Date.now(), item });
  };
  // New folder / text document from the palette: a free name, selected, with the Rename box open
  const createNew = async (kind: 'folder' | 'file') => {
    const here = currentPathRef.current;
    const [base, ext] = kind === 'folder' ? ['New folder', ''] : ['New Text Document', '.txt'];
    const taken = new Set(rawItems.map((i) => i.name.toLowerCase()));
    let name = base + ext;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    try {
      const path = await invoke<string>(kind === 'folder' ? 'create_new_folder' : 'create_new_file', { parentDir: here, name });
      await fetchDirectory(here, [path]);
      setRenameTrigger((t) => t + 1);
    } catch (err) {
      alert(String(err));
    }
  };
  const paletteItems = (): PaletteItem[] => {
    const here = currentPathRef.current;
    const inFolder = !thisPC && !!here;
    const sel = thisPC ? [] : selectedItems;
    const hasSel = sel.length > 0;
    const list: PaletteItem[] = [];
    const act = (
      id: string,
      title: string,
      run: () => void,
      o: { shortcut?: string; keywords?: string; detail?: string; when?: boolean } = {}
    ) => {
      if (o.when === false) return;
      list.push({ id: `act:${id}`, kind: 'action', title, run, shortcut: o.shortcut, keywords: o.keywords, detail: o.detail });
    };
    // folders and the file list
    act('up', 'Go up one folder', () => (basketView ? basketUp() : parentPath ? handleNavigate(parentPath) : openThisPC()), {
      when: !thisPC && !!(basketView || parentPath || here),
      keywords: 'parent back',
    });
    act('thispc', 'Open This PC (all drives)', openThisPC, { when: !thisPC, keywords: 'drives computer' });
    act('refresh', 'Refresh', refreshView, { shortcut: 'Ctrl+R', keywords: 'reload F5' });
    act('explorer', 'Open this folder in Windows Explorer', () => invoke('open_in_default_app', { path: here }).catch((e) => alert(String(e))), {
      when: inFolder,
    });
    act('copy-path', 'Copy the folder path', () => navigator.clipboard.writeText(here).then(() => toast(`Copied: ${here}`)), {
      when: inFolder,
      keywords: 'clipboard',
    });
    act('copy-sel-paths', 'Copy the paths of the selected items', () => {
      const text = sel.map((i) => i.path).join('\r\n');
      navigator.clipboard.writeText(text).then(() => toast(`Copied ${sel.length} path${sel.length === 1 ? '' : 's'}`));
    }, { when: hasSel, keywords: 'clipboard' });
    act('qa-add', 'Add this folder to Quick Access', () => handleAddQuickAccess({ label: lastName(here) || here, path: here }), {
      when: inFolder && !basketView && !quickAccess.some((q) => samePath(q.path, here)),
    });
    act('new-folder', 'New folder', () => createNew('folder'), { when: inFolder && !basketView, keywords: 'create make directory' });
    act('new-file', 'New text document', () => createNew('file'), { when: inFolder && !basketView, keywords: 'create make txt file' });
    act('new-basket', 'New basket', () => createBasket(), { when: inFolder && !basketView, keywords: 'create links' });
    act('select-all', 'Select all', selectAll, { shortcut: 'Ctrl+A', when: inFolder });
    act('copy', 'Copy the selected items', () => clipboardSelection('copy'), { shortcut: 'Ctrl+C', when: hasSel });
    act('cut', 'Cut the selected items', () => clipboardSelection('cut'), { shortcut: 'Ctrl+X', when: hasSel, keywords: 'move' });
    act('paste', 'Paste', pasteClipboard, { shortcut: 'Ctrl+V', when: inFolder && !!clipboard });
    act('delete', 'Delete the selected items (Recycle Bin)', deleteSelection, { shortcut: 'Del', when: hasSel, keywords: 'remove trash' });
    act('rename', 'Rename', () => setRenameTrigger((t) => t + 1), { shortcut: 'F2', when: sel.length === 1 && !sel[0].state });
    act('bulk-rename', 'Bulk rename the selected items', openBulkRename, {
      shortcut: 'F2',
      when: sel.length >= 2 || (sel.length === 1 && sel[0].is_dir),
    });
    act('undo-rename', 'Undo the last bulk rename', () => undoLastBulkRename(true), { shortcut: 'Ctrl+Z', when: renameHistory.length > 0 });
    act('zip', 'Compress the selected items to a zip', compressSelection, { when: hasSel, keywords: 'archive' });
    act('extract', 'Extract the selected zip files', extractSelectedZips, { when: selectedZips.length > 0, keywords: 'unzip' });
    // two panes
    act('dual', dual ? 'Back to one file pane' : 'Two file panes', () => {
      if (!dual && !showFilePanel) setShowFilePanel(true);
      toggleDual();
    }, { keywords: 'dual split commander' });
    act('dual-copy', 'Copy the selected items to the other pane', () => sendToOtherPane(false), { shortcut: 'F5', when: dual && hasSel });
    act('dual-move', 'Move the selected items to the other pane', () => sendToOtherPane(true), { shortcut: 'F6', when: dual && hasSel });
    act('dual-switch', 'Switch to the other pane', toggleActive, { shortcut: 'Tab', when: dual });
    // view
    act('view-details', 'Details view', () => setViewMode('details'), { when: viewMode !== 'details', keywords: 'list table' });
    act('view-tiles', 'Tiles view', () => setViewMode('tiles'), { when: viewMode !== 'tiles' });
    act('view-thumbs', 'Thumbnails view', () => setViewMode('thumbnails'), { when: viewMode !== 'thumbnails', keywords: 'pictures images grid' });
    act('preview', showPreview ? 'Hide the preview drawer' : 'Show the preview drawer', () => setShowPreview((v) => !v), { shortcut: 'Ctrl+P' });
    act('filepanel', showFilePanel ? 'Hide the file panel' : 'Show the file panel', () => setShowFilePanel((v) => !v), { shortcut: 'Ctrl+Shift+F' });
    act('search', showSearch ? 'Close the search bar' : 'Search in this folder', toggleSearch, { keywords: 'find filter' });
    act('terminal', showTerminal ? 'Hide the command line panel' : 'Show the command line panel', () => setShowTerminal((v) => !v), {
      keywords: 'terminal shell powershell',
    });
    act('assistant', showAssistant ? 'Hide the AI Assistant' : 'Show the AI Assistant', () => toggleAssistant(), { keywords: 'ai chat' });
    act('theme', theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', () => setTheme(theme === 'dark' ? 'light' : 'dark'), {
      keywords: 'dark light colour color white black',
    });
    // command line
    const active = tabs.find((t) => t.id === activeTabId);
    act('tab-new', 'New command line tab', () => newTab(), { keywords: 'terminal shell' });
    act('split-lr', 'Split the command line Left-Right', () => active && splitTab(active.id, 'lr'), {
      when: !!active && !active.splitOf && !active.cell,
      keywords: 'screen terminal',
    });
    act('split-tb', 'Split the command line Top-Bottom', () => active && splitTab(active.id, 'tb'), {
      when: !!active && !active.splitOf && !active.cell,
      keywords: 'screen terminal',
    });
    act('tab-level', active?.level === 'admin' ? 'Switch this command line to the normal user' : 'Switch this command line to Administrator', switchTabLevel, {
      when: !!active,
      keywords: 'admin elevate',
    });
    // Settings and help
    act('set-commands', 'Settings: Commands', () => openSettings('commands'), { keywords: 'gear' });
    act('set-vars', 'Settings: Global Var', () => openSettings('vars'), { keywords: 'gear variables' });
    act('set-consts', 'Settings: CONST Global Var', () => openSettings('consts'), { keywords: 'gear constants' });
    act('set-columns', 'Settings: Files Column', () => openSettings('columns'), { keywords: 'gear columns icons sizes' });
    act('set-qa', 'Settings: Quick Access', () => openSettings('quickaccess'), { keywords: 'gear' });
    act('set-frequent', 'Settings: Frequently Accessed', () => openSettings('frequent'), { keywords: 'gear' });
    act('manual', 'Open the manual', () => openSettings('manual'), { keywords: 'help documentation' });
    act('about', 'About boonsh', () => openSettings('about'), { keywords: 'version license' });
    act('update', 'Check for updates', () => updater.checkNow().then(toast), { keywords: 'upgrade version' });

    // saved commands (the Commands menu)
    for (const g of commandGroups) {
      for (const c of g.items) {
        list.push({
          id: `cmd:${c.id}`,
          kind: 'command',
          title: c.name,
          detail: `${g.category} · ${c.insertText.trim()}`,
          keywords: c.description,
          shortcut: c.hotkey,
          run: () => typeAtPrompt(c),
        });
      }
    }
    // Global Vars: fill one from the selection, or type one that has a value
    for (const d of globalVars) {
      const paths = d.takes === 'selection' ? sel.map((i) => i.path) : selectedItem && hasSel ? [selectedItem.path] : [];
      const target = paths.length > 0 ? (paths.length === 1 ? lastName(paths[0]) : `${paths.length} selected items`) : here && inFolder ? lastName(here) || here : '';
      if (target) {
        list.push({
          id: `var:set:${d.name}`,
          kind: 'var',
          title: `Assign {${d.name}} = ${target}`,
          detail: d.description,
          run: () => assignPathVar(d.name, paths.length > 0 ? paths : [here]),
        });
      }
      const value = pathVars[d.name];
      if (value && value.length > 0) {
        list.push({
          id: `var:type:${d.name}`,
          kind: 'var',
          title: `Type {${d.name}} at the prompt`,
          detail: value.length === 1 ? value[0] : `${value.length} items: ${value.map((p) => lastName(p)).join(', ')}`,
          run: () =>
            typeAtPrompt({ id: '', name: `{${d.name}}`, insertText: `{${d.name}}`, description: '', usage: `{${d.name}} = ${value.length} item${value.length === 1 ? '' : 's'}` }),
        });
      }
    }
    for (const c of constVars) {
      list.push({
        id: `const:${c.name}`,
        kind: 'const',
        title: `Type {${c.name}} at the prompt`,
        detail: c.value,
        keywords: c.description,
        run: () => typeAtPrompt({ id: '', name: `{${c.name}}`, insertText: `{${c.name}}`, description: '', usage: c.value }),
      });
    }
    // folders: Quick Access, the most recently visited ones, drives
    for (const q of quickAccess) {
      list.push({ id: `qa:${q.path.toLowerCase()}`, kind: 'quick', title: q.label, detail: q.path, run: () => handleNavigate(q.path) });
    }
    Object.values(freqStats)
      .filter((e) => !quickAccess.some((q) => samePath(q.path, e.path)) && !samePath(e.path, here))
      .sort((a, b) => b.last - a.last)
      .slice(0, 15)
      .forEach((e) =>
        list.push({ id: `dir:${e.path.toLowerCase()}`, kind: 'recent', title: lastName(e.path) || e.path, detail: e.path, run: () => handleNavigate(e.path) })
      );
    for (const d of drives) {
      if (!d.ready) continue;
      list.push({
        id: `drive:${d.letter}`,
        kind: 'drive',
        title: `${d.label || 'Local Disk'} (${d.letter}:)`,
        detail: d.path,
        run: () => handleNavigate(d.path),
      });
    }
    // command line tabs
    for (const t of tabs.filter((x) => !x.splitOf)) {
      list.push({ id: `tab:${t.id}`, kind: 'tab', title: `Go to tab: ${t.name}`, detail: t.cwd, run: () => selectTab(t.id) });
    }
    return list;
  };
  // Made from the typed text: a folder path to open, or a search for the words
  const paletteExtra = (query: string): PaletteItem[] => {
    const out: PaletteItem[] = [];
    const path = pathFromQuery(query, currentPathRef.current);
    if (path) {
      out.push({
        id: `path:${path}`,
        kind: 'path',
        title: `Open ${path}`,
        run: () => handleNavigate(path).then((ok) => !ok && alert(`Cannot open ${path}`)),
      });
      return out;
    }
    const { kinds, text } = splitPrefix(query);
    if (!kinds && text && !thisPC) {
      out.push({
        id: `search:${text}`,
        kind: 'search',
        title: `Search this folder for "${text}"`,
        run: () => {
          setShowSearch(true);
          setSearchQuery(text);
        },
      });
    }
    return out;
  };
  const runPaletteItem = (item: PaletteItem) => {
    if (item.kind !== 'path' && item.kind !== 'search') {
      const next = pushRecent(paletteRecent, item.id);
      setPaletteRecent(next);
      saveRecent(next);
    }
    closePalette();
    setTimeout(item.run, 0); // after the box is gone and the focus is back
  };

  // Keyboard Shortcuts (Ctrl+P, Ctrl+Shift+F, F5, Del, Ctrl+A/X/C/V).
  // Handler lives in a ref so the single window listener always sees current state.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (showSettings || bulkRenamePaths || clashPrompt) return;
    // File keys inside a text field (incl. xterm's hidden textarea) act on the text, not files
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inTextField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const key = e.key.toLowerCase();
    const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey;

    if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'p') {
      e.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette();
    } else if (paletteOpen) {
      return; // the palette has the keys (it stops them itself; this covers keys from elsewhere)
    } else if (e.ctrlKey && e.shiftKey && key === 'f') {
      e.preventDefault();
      setShowFilePanel((v) => !v);
    } else if (e.ctrlKey && key === 'p') {
      e.preventDefault();
      setShowPreview((v) => !v);
    } else if (e.key === 'F5' && !(dual && !inTextField && !thisPCRef.current && !e.ctrlKey && !e.altKey && !e.shiftKey)) {
      // two-pane mode: F5 copies to the other pane (below); Ctrl+R refreshes
      e.preventDefault();
      refreshView();
    } else if (inTextField) {
      return;
    } else if (thisPCRef.current) {
      return; // the This PC view lists drives, not files: no file keys there
    } else if ((e.target as HTMLElement | null)?.closest?.('.assistant-panel')) {
      return; // the AI Assistant's text: Ctrl+A / Ctrl+C work on the text there (the panel handles them)
    } else if (ctrlOnly && key === 'c' && (window.getSelection()?.toString() ?? '') !== '') {
      return; // text is selected (e.g. in the AI Assistant): copy the text, not the files
    } else if (ctrlOnly && key === 'r') {
      e.preventDefault();
      refreshView(); // also in two-pane mode, where F5 copies
    } else if (dual && (e.key === 'F5' || e.key === 'F6') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      sendToOtherPane(e.key === 'F6');
    } else if (dual && e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleActive();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'F2') {
      e.preventDefault();
      // One item: the Rename box (same as right-click, Rename). Two or more: Bulk Rename.
      if (selectedItems.length === 1) {
        if (!selectedItems[0].state) setRenameTrigger((t) => t + 1); // gone / new basket items cannot be renamed
      } else openBulkRename();
    } else if (ctrlOnly && key === 'z' && renameHistory.length > 0) {
      e.preventDefault();
      undoLastBulkRename(true);
    } else if (ctrlOnly && key === 'a') {
      e.preventDefault();
      selectAll();
    } else if (ctrlOnly && key === 'c') {
      e.preventDefault();
      clipboardSelection('copy');
    } else if (ctrlOnly && key === 'x') {
      e.preventDefault();
      clipboardSelection('cut');
    } else if (ctrlOnly && key === 'v') {
      e.preventDefault();
      pasteClipboard();
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const formatSelectedSize = () =>
    formatTotalSize(selectedItems.reduce((sum, i) => sum + i.size, 0)); // folders count once measured

  // The file panel's props. In two-pane mode the active pane gets these; the other pane (passivePanelProps) shows
  // its own folder, and a click there switches to it (the menus then act on it, as the active pane).
  const filePanelProps: React.ComponentProps<typeof MainFilePanel> = {
    items: sortedItems,
    selectedPaths,
    onItemClick: handleItemClick,
    onItemContextSelect: handleItemContextSelect,
    cutPaths: clipboard?.mode === 'cut' ? clipboard.paths : [],
    selectionCount: selectedItems.length,
    canPaste: !!clipboard,
    onCut: () => clipboardSelection('cut'),
    onCopy: () => clipboardSelection('copy'),
    onPaste: pasteClipboard,
    onDeleteSelection: deleteSelection,
    onBulkRename: openBulkRename,
    renameTrigger,
    zipSelectionCount: selectedZips.length,
    isBusy: !!busyMessage,
    onCompress: compressSelection,
    onExtract: extractSelectedZips,
    onClearSelection: () => selectSingle(null),
    onOpenDirectory: openDirectory,
    onOpenFile: handleOpenFile,
    basketMode: basketView ? { atTop: basketView.trail.length === 0 } : null,
    onCreateBasket: createBasket,
    onPasteIntoBasket: pasteIntoBasket,
    onDropOnBasket: addToBasket,
    onRenamed: handleRenamed,
    onOpenLocation: (item) => handleNavigate(parentDir(item.path), [item.path]),
    onBasketDeleteFiles: () => deleteBasketFiles(selectedItems),
    onBasketLink: linkInBasket,
    onBasketClear: removeFromBasket,
    onBasketRelink: relinkInBasket,
    viewMode,
    colPrefs,
    sortLevels,
    details,
    appByExt,
    rows: layout.rows,
    groups,
    onGroupColumn: groupColumn,
    onUngroupColumn: (col) => updateGroups(groups.filter((g) => g.column !== col)),
    onUngroupAll: () => updateGroups([]),
    onToggleGroup: toggleGroup,
    onSelectGroup: (groupItems) => {
      setSelectedItem(groupItems[0] ?? null);
      setSelectedPaths(new Set(groupItems.map((i) => i.path)));
      selectionAnchorRef.current = groupItems[0]?.path ?? null;
    },
    onCollapseAll: () => setCollapsed(new Set(topGroupIds(layout.rows))),
    onExpandAll: () => setCollapsed(new Set()),
    onSortClick: (col, additive) => updateSort(sortClick(sortLevels, col, additive)),
    onSortSet: (col, order, mode) => updateSort(sortSet(sortLevels, col, order, mode)),
    onSortRemove: (col) => updateSort(sortRemove(sortLevels, col)),
    onDateMode: setDateMode,
    onHideColumn: hideColumn,
    onOpenColumnSettings: () => openSettings('columns'),
    onAddQuickAccess: handleAddQuickAccess,
    currentPath,
    onRefresh: refreshView,
    globalVars,
    pathVars,
    onAssignPathVar: assignPathVar,
  };
  const passivePanelProps = (side: Side): React.ComponentProps<typeof MainFilePanel> => {
    const pick = (item: FileItem) => switchTo(side, { select: [item.path] });
    return {
      ...filePanelProps,
      active: false,
      items: otherLayout.flat,
      rows: otherLayout.rows,
      selectedPaths: new Set(otherPane?.selected ?? []),
      selectionCount: otherPane?.selected.length ?? 0,
      zipSelectionCount: 0,
      basketMode: null,
      currentPath: otherPane?.path ?? '',
      onItemClick: pick,
      onItemContextSelect: pick,
      onClearSelection: () => switchTo(side, { select: [] }),
      onOpenDirectory: (path) => switchTo(side, { path }),
      onOpenFile: (item) => {
        pick(item);
        if (!isBasket(item) && !item.state) invoke('open_in_default_app', { path: item.path }).catch(() => {});
      },
      onSelectGroup: (groupItems) => switchTo(side, { select: groupItems.map((i) => i.path) }),
      onCollapseAll: () => setCollapsed(new Set(topGroupIds(otherLayout.rows))),
    };
  };

  const handleGlobalContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={appRef}
      className={`app-container ${theme === 'light' ? 'light-theme' : ''}`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleGlobalContextMenu}
    >
      {/* Top Header Window Bar */}
      <HeaderBar
        currentPath={currentPath}
        parentPath={parentPath}
        searchQuery={searchQuery}
        searchOpen={showSearch && showFilePanel}
        onToggleSearch={toggleSearch}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showPreview={showPreview}
        onTogglePreview={() => setShowPreview(!showPreview)}
        showFilePanel={showFilePanel}
        onToggleFilePanel={() => setShowFilePanel(!showFilePanel)}
        showTerminal={showTerminal}
        onToggleTerminal={() => setShowTerminal(!showTerminal)}
        onOpenPalette={openPalette}
        dualPane={dual}
        onToggleDualPane={() => {
          if (!dual && !showFilePanel) setShowFilePanel(true);
          toggleDual();
        }}
        showAssistant={showAssistant}
        onToggleAssistant={() => toggleAssistant()}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onNavigate={(p) => handleNavigate(p)}
        basketTrail={
          basketView
            ? [
                { label: basketName(basketView.path), title: basketView.path, onClick: () => setBasketView({ ...basketView, trail: [] }) },
                ...basketView.trail.map((f, k) => ({
                  label: f.split('\\').pop() || f,
                  title: f,
                  onClick: () => setBasketView({ ...basketView, trail: basketView.trail.slice(0, k + 1) }),
                })),
              ]
            : null
        }
        onUp={basketView ? basketUp : !thisPC && !parentPath && currentPath ? openThisPC : undefined}
        thisPC={thisPCShown}
        onRefresh={refreshView}
        showSettings={showSettings}
        onOpenSettings={() => openSettings()}
        selectionCount={selectedItems.length}
        clipboard={thisPCShown ? null : clipboard}
        onCut={() => clipboardSelection('cut')}
        onCopy={() => clipboardSelection('copy')}
        onPaste={pasteClipboard}
        onDelete={deleteSelection}
      />

      {showSettings && (
        <SettingsPanel
          groups={commandGroups}
          onChange={handleCommandGroupsChange}
          onReset={resetCommands}
          initialSection={settingsStart}
          qaShown={quickAccess}
          qaCandidates={qaCandidates}
          onQaToggle={(item, on) => (on ? handleAddQuickAccess(item) : handleRemoveQuickAccess(item.path))}
          onQaReset={() => saveQuickAccess(defaultQuickAccess(qaCandidates))}
          freqSettings={freqSettings}
          freqTracked={Object.keys(freqStats).length}
          onFreqSettingsChange={updateFreqSettings}
          onFreqClear={() => updateFreqStats({})}
          colPrefs={colPrefs}
          onColPrefsChange={updatePrefs}
          onColPrefsReset={() => updatePrefs(DEFAULT_PREFS)}
          globalVars={globalVars}
          pathVars={pathVars}
          onGlobalVarsChange={handleGlobalVarsChange}
          onGlobalVarsReset={() => handleGlobalVarsChange(resetGlobalVars())}
          constVars={constVars}
          onConstVarsChange={handleConstVarsChange}
          onCheckUpdate={updater.checkNow}
          onClose={() => setShowSettings(false)}
        />
      )}

      {bulkRenamePaths && (
        <BulkRenameDialog
          paths={bulkRenamePaths}
          folderCount={bulkRenameFolders}
          initialForm={bulkRenameForm?.form}
          initialIncludeSub={bulkRenameForm?.includeSub}
          onClose={() => setBulkRenamePaths(null)}
          onApplied={handleBulkRenamed}
        />
      )}

      {clashPrompt && (
        <PasteConflictDialog clashes={clashPrompt.clashes} destName={clashPrompt.destName} onDone={clashPrompt.resolve} />
      )}

      <PasteProgress jobs={pasteJobs} onCancel={cancelJob} onPause={pauseJob} onStartNow={startJobNow} />
      {paletteOpen && (
        <CommandPalette items={paletteItems()} extra={paletteExtra} recent={paletteRecent} onRun={runPaletteItem} onClose={closePalette} />
      )}

      {updater.update && (
        <UpdateNotice update={updater.update} installing={updater.installing} onInstall={updater.install} onLater={updater.later} />
      )}

      {renameToast && (
        <div className="toast">
          <span>{renameToast.message}</span>
          {renameToast.undoable && (
            <button className="active" onClick={() => undoLastBulkRename(false)} title="Put the old names back (Ctrl+Z)">
              Undo
            </button>
          )}
          <button onClick={() => setRenameToast(null)} title="Dismiss" style={{ padding: 2 }}>
            ×
          </button>
        </div>
      )}

      {/* Main Workspace Split Body */}
      <div className="workspace-body">
        {/* Left Panel Column (Quick Access Bar + Folder Tree + Optional Middle File Panel + Optional Preview) */}
        <div className="left-column" style={{ width: !rightShown ? '100%' : showFilePanel ? `${leftWidthPct}%` : `${treeWidthPx}px` }}>
          {/* Quick Access Top Bar */}
          <QuickAccessBar
            items={quickAccess}
            currentPath={currentPath}
            onNavigate={handleNavigate}
            onRemoveQuickAccess={handleRemoveQuickAccess}
          />

          {/* Main File Explorer Container (Folder Tree + Optional File Panel) */}
          <div className="file-explorer-container">
            {/* Left Sub-pane: Folder Tree View */}
            <div
              style={{
                width: showFilePanel ? treeWidthPx : '100%',
                // A narrow window squeezes the tree before the file panel: the files keep at least 200 px
                maxWidth: showFilePanel ? 'max(120px, calc(100% - 200px))' : undefined,
                height: '100%',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {freqSettings.enabled && (
                <FrequentPanel
                  items={topFolders(freqStats, freqSettings.count)}
                  currentPath={currentPath}
                  onNavigate={handleNavigate}
                  onRemove={forgetFolder}
                />
              )}
              <div style={{ flex: '1 1 0%', minHeight: 0 }}>
              <FolderTree
                currentPath={currentPath}
                onNavigate={handleNavigate}
                onOpenBasket={openBasket}
                openBasketPath={basketView?.path ?? null}
                onCreateBasket={createBasket}
                listing={treeListing}
                onAddQuickAccess={handleAddQuickAccess}
                onRefresh={refreshView}
                drives={drives}
                onOpenThisPC={openThisPC}
                thisPCOpen={thisPCShown}
              />
              </div>
            </div>

            {/* Splitter between Folder Tree and File Panel */}
            {showFilePanel && (
              <div
                className={`split-handle-v ${isDraggingTree ? 'dragging' : ''}`}
                onMouseDown={startTree}
                title="Drag to resize folder tree width"
              />
            )}

            {/* Middle Sub-pane: Main File Explorer Table / Grid */}
            {showFilePanel && (
              <div className="file-panel-column">
              {!dual ? (
                <>
                  {thisPCShown && <ThisPCView drives={drives} onOpen={(p) => handleNavigate(p)} />}
                  {/* kept mounted (column widths, scroll) while This PC is shown */}
                  <div style={{ display: thisPCShown ? 'none' : 'contents' }}>
                    <MainFilePanel {...filePanelProps} />
                  </div>
                </>
              ) : (
                <div className="dual-panes" ref={dualBoxRef}>
                  {(['left', 'right'] as Side[]).map((side) => {
                    const isActive = side === activeSide;
                    const title = isActive
                      ? thisPCShown
                        ? 'This PC'
                        : basketView
                        ? `${basketName(basketView.path)} (basket)`
                        : searchQuery.trim()
                        ? `Search in ${currentPath}`
                        : currentPath
                      : otherPane?.path ?? '';
                    return (
                      <div key={side} style={{ display: 'contents' }}>
                        {side === 'right' && (
                          <div
                            className="split-handle-v dual-divider"
                            onMouseDown={startDualDrag}
                            onDoubleClick={() => {
                              setDualRatio(0.5);
                              saveDualRatio();
                            }}
                            title="Drag to resize the panes (double-click: half and half)"
                          />
                        )}
                        <div
                          className={`file-pane ${isActive ? 'active' : ''}`}
                          style={side === 'left' ? { width: `${dualRatio * 100}%` } : { flex: '1 1 0%' }}
                          onDragOver={(e) => {
                            if (!e.dataTransfer.types.includes('application/x-boonsh-paths')) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
                          }}
                          onDrop={(e) => dropOnPane(side, e)}
                          onContextMenuCapture={isActive ? undefined : () => switchTo(side)}
                        >
                          <div className="file-pane-head" onClick={() => switchTo(side)} title={title}>
                            <span className="file-pane-path">
                              <bdi dir="ltr">{title}</bdi>
                            </span>
                          </div>
                          {isActive && thisPCShown && <ThisPCView drives={drives} onOpen={(p) => handleNavigate(p)} />}
                          <div style={{ display: isActive && thisPCShown ? 'none' : 'contents' }}>
                            <MainFilePanel {...(isActive ? filePanelProps : passivePanelProps(side))} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {showSearch && (
                <SearchBar
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  searchError={searchError}
                  searchNotice={searchNotice}
                  searching={searching}
                  includeSubfolders={includeSubfolders}
                  onToggleIncludeSubfolders={() => setIncludeSubfolders(!includeSubfolders)}
                  onClose={toggleSearch}
                />
              )}
              </div>
            )}
          </div>

          {/* Horizontal Split Handle (between File Explorer and Bottom Preview) */}
          {showPreview && (
            <div
              className={`split-handle-h ${isDraggingH ? 'dragging' : ''}`}
              onMouseDown={startH}
            />
          )}

          {/* Collapsible Left-Bottom Preview Drawer Panel */}
          {showPreview && (
            <div style={{ height: previewHeightPx, flexShrink: 0 }}>
              <PreviewPanel
                selectedItem={selectedItem}
                allItems={rawItems}
                onClose={() => setShowPreview(false)}
                onSelectFile={selectSingle}
              />
            </div>
          )}
        </div>

        {/* Vertical Split Handle (between Left Panel and Right Terminal) */}
        {rightShown && (
          <div
            className={`split-handle-v ${isDraggingV ? 'dragging' : ''}`}
            onMouseDown={startV}
          />
        )}

        {/* Right Panel Column (Dedicated Interactive PowerShell Terminal) */}
        <div className="right-column" style={rightShown ? undefined : { display: 'none' }}>
          <div style={{ flex: '1 1 0%', minHeight: 0, display: showTerminal ? 'flex' : 'none', flexDirection: 'column' }}>
          <TerminalPanel
            currentPath={currentPath}
            theme={theme}
            visible={showTerminal}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={selectTab}
            onNewTab={newTab}
            onCloseTab={closeTab}
            onSplitTab={splitTab}
            onSplitPane={splitPane}
            onClosePane={closePane}
            onCloseAllTabs={closeAllTabs}
            onRenameTab={renameTab}
            onRecolorTab={recolorTab}
            onMoveTab={moveTab}
            onShellExit={(id) => removeTab(id, true)}
            onSwitchLevel={switchTabLevel}
            onSpawnFailed={spawnFailed}
            onShellCwdChange={handleShellCwdChange}
            onPromptState={(id, atPrompt) => { atPromptRef.current[id] = atPrompt; }}
            onPickCommand={pickCommand}
            paletteRequest={paletteRequest}
            onPickHistory={typeFromHistory}
            baskets={(treeListing && normalizePath(treeListing.path) === normalizePath(currentPath) ? treeListing.items : [])
              .filter(isBasket)
              .map((i) => basketName(i.name))}
            onUserInput={() => { pendingCmdRef.current = null; }}
            globalVars={globalVars}
            constVars={constVars}
            pathVars={pathVars}
            onClearPathVar={(name) => assignPathVar(name, [])}
            onAskAi={askAi}
            commandGroups={commandGroups}
            hotkeysOn={!showSettings}
            onOpenSettings={() => openSettings()}
          />
          </div>

          {/* AI Assistant, under the command line panel */}
          {showAssistant && showTerminal && (
            <div
              className={`split-handle-h ${isDraggingAi ? 'dragging' : ''}`}
              onMouseDown={startAi}
              title="Drag to resize the AI Assistant panel"
            />
          )}
          {/* hidden, never unmounted: closing the panel keeps the conversation until the user starts a new one */}
          <div
            style={
              !showAssistant
                ? { display: 'none' }
                : showTerminal
                ? { height: assistantHeightPx, flexShrink: 0, minHeight: 0 }
                : { flex: '1 1 0%', minHeight: 0 }
            }
          >
            <AssistantPanel getHost={() => assistantHostRef.current!} onClose={() => toggleAssistant(false)} askRequest={askAiRequest} />
          </div>
        </div>
      </div>

      {/* Bottom Status Bar */}
      <StatusBar
        totalFiles={totalFiles}
        totalFolders={totalFolders}
        totalSizeFormatted={sizeStatus().text}
        totalSizeNote={sizeStatus().note}
        totalSizeTitle={sizeStatus().title}
        selectedItem={(selectedItem && selectedItems.find((i) => i.path === selectedItem.path)) || selectedItem}
        selectionCount={selectedItems.length}
        selectionSizeFormatted={formatSelectedSize()}
        busyMessage={busyMessage}
        shellEngine={shellEngine}
        basketCounts={basketView && !searchQuery.trim() ? basketCounts : null}
        drivesCount={thisPCShown ? drives.length : null}
      />
    </div>
  );
}

export default App;