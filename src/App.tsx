import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { HeaderBar } from './components/HeaderBar';
import { QuickAccessBar } from './components/QuickAccessBar';
import { FolderTree } from './components/FolderTree';
import { MainFilePanel } from './components/MainFilePanel';
import { PreviewPanel } from './components/PreviewPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { FrequentPanel } from './components/FrequentPanel';
import { AssistantPanel } from './components/AssistantPanel';
import type { Section as SettingsSection } from './components/SettingsPanel';
import { AssistantHost } from './assistant';
import {
  GroupSpec,
  Bucket,
  layoutItems,
  loadGroups,
  saveGroups,
  topGroupIds,
} from './grouping';
import { QA_MAX, QA_KEY, defaultQuickAccess, isShown, parseSaved, samePath } from './quickAccess';
import { BulkRenameDialog } from './components/BulkRenameDialog';
import {
  PathVars,
  PathVarName,
  EMPTY_PATH_VARS,
  expandTemplate,
  hasPlaceholder,
} from './pathVars';
import {
  GlobalVarDef,
  loadGlobalVars,
  saveGlobalVars,
  resetGlobalVars,
  renameInText,
} from './globalVars';
import { ConstVar, loadConstVars, saveConstVars, constMap } from './constVars';
import { CommandGroup, loadCommandGroups, saveCommandGroups, resetCommandGroups } from './commands';
import {
  RenameBatch,
  RenameOp,
  RulesForm,
  UndoResult,
  MAX_BATCHES,
  loadRenameHistory,
  saveRenameHistory,
} from './bulkRename';
import { tabColor } from './tabColors';
import { FileItem, QuickAccessItem, FileListResult, ViewMode, ItemDetails, TermTab } from './types';
import {
  FrequentStats,
  FrequentSettings,
  loadStats,
  saveStats,
  loadSettings as loadFrequentSettings,
  saveSettings as saveFrequentSettings,
  recordVisit,
  removeVisit,
  topFolders,
} from './frequent';
import {
  ColumnId,
  ColumnPrefs,
  DateColumn,
  DateMode,
  SortLevel,
  DEFAULT_PREFS,
  DEFAULT_SORT,
  loadPrefs,
  savePrefs,
  loadSort,
  saveSort,
  sortClick,
  sortSet,
  sortRemove,
  detailKey,
  hasMediaProps,
  needsDetails,
} from './columns';

export function App() {
  const [currentPath, setCurrentPath] = useState<string>('');
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [rawItems, setRawItems] = useState<FileItem[]>([]);
  const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([]);
  // selectedItem = focused item (preview, title, status); selectedPaths = full multi-selection
  const [selectedItem, setSelectedItem] = useState<FileItem | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null); // Shift+Click range start
  // In-app file clipboard for Ctrl+X / Ctrl+C / Ctrl+V
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null);
  const [totalFiles, setTotalFiles] = useState<number>(0);
  const [totalFolders, setTotalFolders] = useState<number>(0);
  const [totalSize, setTotalSize] = useState<number>(0);

  // UI Modes, Toggles & Theme (Persisted in localStorage)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('boonsh_theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('boonsh_view_mode');
    return (saved === 'tiles' || saved === 'thumbnails' || saved === 'details') ? saved : 'details';
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [includeSubfolders, setIncludeSubfolders] = useState<boolean>(true);
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [showFilePanel, setShowFilePanel] = useState<boolean>(true); // Controls Middle File Panel
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
  const [assistantHeightPx, setAssistantHeightPx] = useState<number>(300);
  const [isDraggingAi, setIsDraggingAi] = useState<boolean>(false);
  const rightShown = showTerminal || showAssistant; // the right column holds the command line and the assistant
  const [shellEngine] = useState<string>('PowerShell 7');

  // Terminal helper commands (editable in Settings, persisted in localStorage)
  const [commandGroups, setCommandGroups] = useState<CommandGroup[]>(loadCommandGroups);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const handleCommandGroupsChange = (groups: CommandGroup[]) => {
    setCommandGroups(groups);
    saveCommandGroups(groups);
  };

  // {SELEC} / {DEST}: path variables for terminal commands. Memory only, so they vanish when the app closes.
  const [globalVars, setGlobalVars] = useState<GlobalVarDef[]>(loadGlobalVars); // definitions (saved)
  const globalVarsRef = useRef(globalVars);
  globalVarsRef.current = globalVars;
  const [pathVars, setPathVars] = useState<PathVars>(EMPTY_PATH_VARS); // values (memory only)
  const pathVarsRef = useRef(pathVars);
  pathVarsRef.current = pathVars;
  const varNames = () => globalVarsRef.current.map((v) => v.name);
  // CONST variables ({IP} = 202.283.242.97): saved with their values, filled into commands as written
  const [constVars, setConstVars] = useState<ConstVar[]>(loadConstVars);
  const constVarsRef = useRef(constVars);
  constVarsRef.current = constVars;
  const consts = () => constMap(constVarsRef.current);
  // Command template (with {SELEC}/{DEST}) sitting untouched at the prompt. While it is set, the typed line can be
  // rewritten when a variable or the folder changes. The terminal clears it as soon as the user types.
  const pendingCmdRef = useRef<string | null>(null);

  // Replace what is on the prompt line: Esc clears the line (PSReadLine and cmd). The pause keeps ConPTY from
  // reading Esc plus the next character as one Alt+key chord.
  const rewritePromptLine = async (text: string) => {
    await ptyWrite('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    await ptyWrite(text);
  };

  // Type a command template at the prompt, expanded against the current folder.
  const pickCommand = async (template: string) => {
    const text = expandTemplate(template, pathVarsRef.current, currentPathRef.current, consts());
    const replace = pendingCmdRef.current !== null;
    pendingCmdRef.current = hasPlaceholder(template, varNames()) ? template : null;
    if (replace) await rewritePromptLine(text);
    else await ptyWrite(text);
  };

  const setPathVarValues = (next: PathVars) => {
    pathVarsRef.current = next;
    setPathVars(next);
    const template = pendingCmdRef.current;
    if (template !== null) {
      rewritePromptLine(expandTemplate(template, next, currentPathRef.current, consts())).catch(() => {});
    }
  };

  const assignPathVar = (name: PathVarName, paths: string[]) => {
    setPathVarValues({ ...pathVarsRef.current, [name]: paths });
  };

  // Settings added, renamed or deleted variables. A rename keeps the value and updates {OLD} in the commands;
  // a deleted variable loses its value.
  const handleGlobalVarsChange = (next: GlobalVarDef[]) => {
    const old = globalVarsRef.current;
    const values: PathVars = {};
    let commands = commandGroups;
    for (const def of next) {
      const before = old.find((o) => o.id === def.id);
      const key = before ? before.name : def.name;
      if (pathVarsRef.current[key]?.length) values[def.name] = pathVarsRef.current[key];
      if (before && before.name !== def.name) {
        commands = commands.map((g) => ({
          ...g,
          items: g.items.map((i) => ({
            ...i,
            insertText: renameInText(i.insertText, before.name, def.name),
            usage: renameInText(i.usage, before.name, def.name),
          })),
        }));
      }
    }
    if (commands !== commandGroups) handleCommandGroupsChange(commands);
    globalVarsRef.current = next;
    setGlobalVars(next);
    saveGlobalVars(next);
    pendingCmdRef.current = null; // names changed under the prompt line; leave it as it is
    setPathVarValues(values);
  };

  // Settings added, renamed, edited or deleted CONST variables. A rename updates {OLD} in the commands.
  const handleConstVarsChange = (next: ConstVar[]) => {
    const old = constVarsRef.current;
    let commands = commandGroups;
    for (const def of next) {
      const before = old.find((o) => o.id === def.id);
      if (before && before.name !== def.name) {
        commands = commands.map((g) => ({
          ...g,
          items: g.items.map((i) => ({
            ...i,
            insertText: renameInText(i.insertText, before.name, def.name),
            usage: renameInText(i.usage, before.name, def.name),
          })),
        }));
      }
    }
    if (commands !== commandGroups) handleCommandGroupsChange(commands);
    constVarsRef.current = next;
    setConstVars(next);
    saveConstVars(next);
  };

  // Sort State
  // Smart sort: a list of levels (column + direction), and which columns the file panel shows. Both are saved.
  const [sortLevels, setSortLevels] = useState<SortLevel[]>(loadSort);
  const [colPrefs, setColPrefs] = useState<ColumnPrefs>(loadPrefs);
  const [details, setDetails] = useState<Record<string, ItemDetails>>({}); // media properties, by detailKey
  // Default app of each file type for the Type column ("MP4 (VLC media player)"); '' = none. Asked once per type.
  const [appByExt, setAppByExt] = useState<Record<string, string>>({});
  // Frequently Accessed folders: visit counts (always counted, even while the panel is hidden) and its settings
  const [freqStats, setFreqStats] = useState<FrequentStats>(loadStats);
  const [freqSettings, setFreqSettings] = useState<FrequentSettings>(loadFrequentSettings);
  const updateFreqStats = (next: FrequentStats) => {
    setFreqStats(next);
    saveStats(next);
  };
  const updateFreqSettings = (next: FrequentSettings) => {
    setFreqSettings(next);
    saveFrequentSettings(next);
  };
  const [settingsStart, setSettingsStart] = useState<SettingsSection>('commands');
  const updateSort = (next: SortLevel[]) => {
    setSortLevels(next);
    saveSort(next);
  };
  // Group view: header rows over the files. Separate from the sort, saved, and kept for every folder and search
  // result until the user cancels it. The layers follow the sort numbers of the grouped columns.
  const [groups, setGroups] = useState<GroupSpec[]>(loadGroups);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // ids of folded groups (this session)
  const updateGroups = (next: GroupSpec[]) => {
    setGroups(next);
    saveGroups(next);
    setCollapsed(new Set());
  };
  const groupColumn = (col: ColumnId, buckets: Bucket[]) => {
    const rest = groups.filter((g) => g.column !== col);
    if (buckets.length === 0) {
      updateGroups(rest); // nothing ticked any more: stop grouping this column
      return;
    }
    updateGroups([...rest, { column: col, buckets }]);
    // the sort numbers decide the layer order, so a grouped column gets a number (the next one) if it has none
    if (!sortLevels.some((l) => l.column === col)) updateSort([...sortLevels, { column: col, order: 'asc' }]);
  };
  const updatePrefs = (next: ColumnPrefs) => {
    setColPrefs(next);
    savePrefs(next);
    // a hidden column should not keep sorting or grouping invisibly
    const kept = sortLevels.filter((l) => next.visible.includes(l.column));
    if (kept.length !== sortLevels.length) updateSort(kept.length ? kept : DEFAULT_SORT);
    const keptGroups = groups.filter((g) => next.visible.includes(g.column));
    if (keptGroups.length !== groups.length) updateGroups(keptGroups);
  };
  const setDateMode = (col: DateColumn, kind: 'dateSort' | 'dateShow', mode: DateMode) =>
    updatePrefs({ ...colPrefs, [kind]: { ...colPrefs[kind], [col]: mode } });
  const hideColumn = (col: ColumnId) => {
    if (col === 'name') return;
    updatePrefs({ ...colPrefs, visible: colPrefs.visible.filter((c) => c !== col) });
  };
  const openSettings = (section: SettingsSection = 'commands') => {
    setSettingsStart(section);
    setShowSettings(true);
  };

  // Resizable Split Handles
  const [leftWidthPct, setLeftWidthPct] = useState<number>(55);
  const [treeWidthPx, setTreeWidthPx] = useState<number>(210);
  const [previewHeightPx, setPreviewHeightPx] = useState<number>(240);
  const [isDraggingV, setIsDraggingV] = useState<boolean>(false);
  const [isDraggingTree, setIsDraggingTree] = useState<boolean>(false);
  const [isDraggingH, setIsDraggingH] = useState<boolean>(false);

  const appRef = useRef<HTMLDivElement>(null);

  // Dynamically update window title with full directory/file pathname
  useEffect(() => {
    let titleStr = 'boonsh';
    if (selectedItem) {
      titleStr = `boonsh - ${selectedItem.path}`;
    } else if (currentPath) {
      titleStr = `boonsh - ${currentPath}`;
    }
    document.title = titleStr;
    try {
      const win = getCurrentWindow();
      win.setTitle(titleStr);
      win.unminimize().catch(() => {});
      win.setFocus().catch(() => {});
      win.maximize().catch(() => {});
    } catch {
      // Fallback for non-tauri dev env
    }
  }, [currentPath, selectedItem?.path]);

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

  // Quick Access: what the bar shows is saved (max QA_MAX items). Nothing saved yet = Home, Desktop, Downloads,
  // Documents and the C: drive. A saved empty list is a real choice (everything unchecked in Settings).
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

  // Quick Access Add / Remove Handlers
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
        setCurrentPath(res.current_path);
        setParentPath(res.parent_path);
        setRawItems(res.items);
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
        if (targetPath) {
          const next = removeVisit(freqStatsRef.current, targetPath);
          if (next !== freqStatsRef.current) {
            freqStatsRef.current = next;
            updateFreqStats(next);
          }
        }
        return false;
      });
  };

  useEffect(() => {
    fetchDirectory();
  }, []);

  // Every time a different folder becomes the current one (double-click, tree, Quick Access, path bar, `cd` in
  // the terminal) it counts as one visit. Refreshing or searching does not change the path, so it does not count.
  const freqStatsRef = useRef(freqStats);
  freqStatsRef.current = freqStats;
  useEffect(() => {
    if (!currentPath) return;
    const next = recordVisit(freqStatsRef.current, currentPath);
    freqStatsRef.current = next;
    updateFreqStats(next);
  }, [currentPath]);

  // ---- Command line tabs ----
  // Each tab is its own shell. The active tab is the one the file panel follows, the one GUI navigation sends
  // `cd` to, and the one commands/paths are typed into. Refs are updated together with the state so code that
  // runs right after a change (select a new tab, then navigate) already sees it.
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const tabCounterRef = useRef(0);
  const tabColorRef = useRef(0); // next color of the rotation
  const userNameRef = useRef('User');
  const firstTabRef = useRef(false);
  const appLevelRef = useRef<'admin' | 'normal'>('normal'); // the login boonsh itself runs with
  // Per tab: true while its shell sits at the prompt, false while a command or program (claude, vim, npm run dev
  // ...) is running. Keys sent to a running program would be typed into it, so a cd is held back until the
  // prompt returns.
  const atPromptRef = useRef<Record<string, boolean>>({});
  // Per tab: the folder the GUI moved to while a program was running; the shell is told when its prompt is back.
  const heldCdRef = useRef<Record<string, string | null>>({});

  const updateTabs = (next: TermTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  };
  const activate = (id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  };

  // Type into the active tab's shell
  const ptyWrite = (data: string): Promise<unknown> => {
    const id = activeTabIdRef.current;
    return id ? invoke('pty_write', { id, data }) : Promise.resolve();
  };

  // The file panel follows the tab: show the folder the tab's shell is in
  const followTab = (t: TermTab) => {
    if (t.cwd && normalizePath(t.cwd) !== normalizePath(currentPathRef.current)) fetchDirectory(t.cwd);
  };

  const newTab = () => {
    const id = `tab${++tabCounterRef.current}`;
    atPromptRef.current[id] = true;
    updateTabs([
      ...tabsRef.current,
      {
        id,
        name: userNameRef.current,
        cwd: currentPathRef.current,
        level: appLevelRef.current,
        color: tabColor(tabColorRef.current++),
      },
    ]);
    pendingCmdRef.current = null;
    activate(id);
  };

  const selectTab = (id: string) => {
    if (id === activeTabIdRef.current) return;
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    pendingCmdRef.current = null;
    activate(id);
    followTab(t);
  };

  const lastRespawnRef = useRef(0);
  const removeTab = (id: string, byExit = false) => {
    const list = tabsRef.current;
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = list.filter((t) => t.id !== id);
    delete atPromptRef.current[id];
    delete heldCdRef.current[id];
    updateTabs(next);
    if (next.length === 0) {
      // There is always one command line: the last tab going away leaves a fresh one. A shell that dies at once
      // (a broken install) must not respawn in a loop, so a tab that ended on its own gets one only every 3 s.
      pendingCmdRef.current = null;
      activate(null);
      if (!byExit || Date.now() - lastRespawnRef.current > 3000) {
        lastRespawnRef.current = Date.now();
        newTab();
      }
      return;
    }
    if (activeTabIdRef.current === id) {
      const neighbor = next[idx] ?? next[idx - 1] ?? null;
      pendingCmdRef.current = null;
      activate(neighbor ? neighbor.id : null);
      if (neighbor) followTab(neighbor);
    }
  };

  const RUNNING_MSG = 'A program is still running in this tab. Close it anyway?';
  const closeTab = (id: string) => {
    if (atPromptRef.current[id] === false && !window.confirm(RUNNING_MSG)) return;
    removeTab(id);
  };
  const closeAllTabs = () => {
    if (tabsRef.current.some((t) => atPromptRef.current[t.id] === false) && !window.confirm(RUNNING_MSG)) return;
    updateTabs([]);
    activate(null);
    atPromptRef.current = {};
    heldCdRef.current = {};
    pendingCmdRef.current = null;
    newTab(); // there is always one command line
  };
  // Give a tab a new shell with the other login: same place in the bar, same name and folder, new id (so the old
  // shell is ended and a new one starts). Only this tab changes; the others keep running as they are.
  const replaceTab = (oldId: string, level: 'admin' | 'normal') => {
    const list = tabsRef.current;
    if (!list.some((t) => t.id === oldId)) return;
    const nid = `tab${++tabCounterRef.current}`;
    delete atPromptRef.current[oldId];
    delete heldCdRef.current[oldId];
    atPromptRef.current[nid] = true;
    updateTabs(list.map((t) => (t.id === oldId ? { ...t, id: nid, level } : t)));
    if (activeTabIdRef.current === oldId) {
      pendingCmdRef.current = null;
      activate(nid);
    }
  };
  const switchTabLevel = () => {
    const id = activeTabIdRef.current;
    const t = tabsRef.current.find((x) => x.id === id);
    if (!id || !t) return;
    if (
      atPromptRef.current[id] === false &&
      !window.confirm("Switching the login restarts this tab's command line and ends the program running in it. Continue?")
    ) {
      return;
    }
    replaceTab(id, t.level === 'admin' ? 'normal' : 'admin');
  };
  // A tab's shell could not start (the Windows permission prompt was refused ...): back to the app's own login
  const spawnFailed = (id: string, message: string) => {
    window.alert(message);
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (t.level !== appLevelRef.current) replaceTab(id, appLevelRef.current);
    else removeTab(id);
  };
  const renameTab = (id: string, name: string) => {
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, name } : t)));
  };
  const recolorTab = (id: string, color: string) => {
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, color } : t)));
  };
  // Drag a tab to a new place in the bar (index among the tabs)
  const moveTab = (id: string, toIndex: number) => {
    const list = tabsRef.current;
    const from = list.findIndex((t) => t.id === id);
    if (from < 0 || from === toIndex || toIndex < 0 || toIndex >= list.length) return;
    const next = [...list];
    const [t] = next.splice(from, 1);
    next.splice(toIndex, 0, t);
    updateTabs(next);
  };

  // The first tab: named after the user, opens in the default folder
  useEffect(() => {
    if (firstTabRef.current) return; // StrictMode runs effects twice in dev
    firstTabRef.current = true;
    Promise.all([
      invoke<string>('get_username')
        .then((n) => {
          userNameRef.current = n;
        })
        .catch(() => {}),
      invoke<boolean>('is_admin')
        .then((a) => {
          appLevelRef.current = a ? 'admin' : 'normal';
        })
        .catch(() => {}),
    ]).finally(newTab);
  }, []);

  // Bi-directional navigation: Navigate GUI & send cd command to the active tab's PowerShell
  const handleNavigate = (path: string): Promise<boolean> => {
    const loaded = fetchDirectory(path);
    const id = activeTabIdRef.current;
    if (!id) return loaded;
    updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, cwd: path } : t)));
    if (atPromptRef.current[id] === false) {
      heldCdRef.current[id] = path;
      return loaded;
    }
    heldCdRef.current[id] = null;
    // A command still waiting at the prompt is cleared first (else the cd would be glued onto it) and typed
    // again afterwards, with its paths made relative to the new folder.
    const template = pendingCmdRef.current;
    if (template === null) {
      ptyWrite(`cd "${path}"\r`).catch(() => {});
      return loaded;
    }
    (async () => {
      await rewritePromptLine(`cd "${path}"\r`);
      await ptyWrite(expandTemplate(template, pathVarsRef.current, path, consts()));
    })().catch(() => {});
    return loaded;
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
    if (tabsRef.current.some((t) => t.id === id && t.cwd !== path)) {
      updateTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, cwd: path } : t)));
    }
    if (id !== activeTabIdRef.current) return; // a tab in the background does not move the file panel
    const last = lastRequestedPathRef.current;
    if (last === null || normalizePath(path) !== normalizePath(last)) {
      fetchDirectory(path);
    }
  };

  const handleOpenFile = (file: FileItem) => {
    selectSingle(file);
    invoke('open_in_default_app', { path: file.path }).catch((err) => {
      console.error('Failed to open file in default app:', err);
    });
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
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    const q = searchQuery.trim();
    if (!currentPath) return;
    if (q.length === 0) {
      setSearchError('');
      setSearchNotice('');
      setSearching(false);
      fetchDirectory(currentPath);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      invoke<{ items: FileItem[]; notice: string }>('search_files', {
        dir: currentPath,
        query: q,
        includeSubfolders,
        vars: pathVarsRef.current,
      })
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
  }, [searchQuery, includeSubfolders, searchRefreshTick, searchInputKey]);

  // Auto refresh (dir_watch.rs): another program added, changed or removed something in the open folder. Reload
  // the list quietly: selection, focus and scroll stay, unchanged items keep their objects (so the preview and the
  // details columns are not redone). Skipped while a search is shown: its results are not this folder's listing.
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const reloadQuietly = () => {
    const path = currentPathRef.current;
    if (!path || searchQueryRef.current.trim()) return;
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

  // Sort Items logic (see columns.ts): folders first (optional), each sort level in turn, then the name
  const layout = useMemo(
    () => layoutItems(rawItems, groups, sortLevels, colPrefs, details, collapsed),
    [rawItems, groups, sortLevels, colPrefs, details, collapsed]
  );
  // the items in view order, without those folded away inside a collapsed group (selection works on these)
  const sortedItems = layout.flat;
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

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
    if (selectedItems.length === 0) return;
    setClipboard({ mode, paths: selectedItems.map((i) => i.path) });
  };

  // Paste into the current folder; resolves with the new paths (the AI Assistant uses it too)
  const pasteItems = async (): Promise<string[]> => {
    if (!clipboard || !currentPath) return [];
    const dest = currentPath;
    try {
      const newPaths = await invoke<string[]>('paste_items', { paths: clipboard.paths, destDir: dest, mode: clipboard.mode });
      if (clipboard.mode === 'cut') setClipboard(null); // moved items can't be pasted again
      fetchDirectory(dest, newPaths);
      return newPaths;
    } catch (err) {
      fetchDirectory(dest);
      throw err;
    }
  };
  const pasteClipboard = () => {
    pasteItems().catch((err) => alert(err));
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
    else fetchDirectory(currentPath, selectPaths);
  };

  const openBulkRename = () => {
    // 2 or more items, or one folder (to rename what is inside it, with "Include sub-folders")
    const ok = selectedItems.length >= 2 || (selectedItems.length === 1 && selectedItems[0].is_dir);
    if (!ok || busyMessage) return;
    setBulkRenameForm(null);
    setBulkRenamePaths(selectedItems.map((i) => i.path)); // in the panel's sort order: numbering follows it
    setBulkRenameFolders(selectedItems.filter((i) => i.is_dir).length);
  };

  const handleBulkRenamed = (r: { renamed: number; ops: RenameOp[]; newPaths: string[] }) => {
    const batch: RenameBatch = { id: String(Date.now()), time: Date.now(), count: r.renamed, ops: r.ops };
    const history = [batch, ...renameHistory].slice(0, MAX_BATCHES);
    setRenameHistory(history);
    saveRenameHistory(history);
    setBulkRenamePaths(null);
    setRenameToast({ message: `Renamed ${r.renamed} item${r.renamed === 1 ? '' : 's'}.`, undoable: true });
    refreshAfterRename(r.newPaths);
  };

  const undoLastBulkRename = (askFirst: boolean) => {
    const batch = renameHistory[0];
    if (!batch || busyMessage) return;
    if (askFirst && !confirm(`Undo the last bulk rename (${batch.count} items)?`)) return;
    setRenameToast(null);
    invoke<UndoResult>('bulk_rename_undo', { ops: batch.ops })
      .then((res) => {
        const rest = renameHistory.slice(1);
        setRenameHistory(rest);
        saveRenameHistory(rest);
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
    deleteItems(selectedItems).catch((err) => alert(err));
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
    setViewMode: (mode) => {
      setViewMode(mode);
      localStorage.setItem('boonsh_view_mode', mode);
    },
    setTheme: (t) => {
      setTheme(t);
      localStorage.setItem('boonsh_theme', t);
    },
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

  // Keyboard Shortcuts (Ctrl+P, Ctrl+Shift+F, F5, Del, Ctrl+A/X/C/V).
  // Handler lives in a ref so the single window listener always sees current state.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (showSettings || bulkRenamePaths) return;
    // File keys inside a text field (incl. xterm's hidden textarea) act on the text, not files
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inTextField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const key = e.key.toLowerCase();
    const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey;

    if (e.ctrlKey && e.shiftKey && key === 'f') {
      e.preventDefault();
      setShowFilePanel((v) => !v);
    } else if (e.ctrlKey && key === 'p') {
      e.preventDefault();
      setShowPreview((v) => !v);
    } else if (e.key === 'F5') {
      e.preventDefault();
      fetchDirectory(currentPath);
    } else if (inTextField) {
      return;
    } else if ((e.target as HTMLElement | null)?.closest?.('.assistant-panel')) {
      return; // the AI Assistant's text: Ctrl+A / Ctrl+C work on the text there (the panel handles them)
    } else if (ctrlOnly && key === 'c' && (window.getSelection()?.toString() ?? '') !== '') {
      return; // text is selected (e.g. in the AI Assistant): copy the text, not the files
    } else if (e.key === 'Delete') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'F2') {
      e.preventDefault();
      // One item: the Rename box (same as right-click, Rename). Two or more: Bulk Rename.
      if (selectedItems.length === 1) setRenameTrigger((t) => t + 1);
      else openBulkRename();
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
    formatTotalSize(selectedItems.reduce((sum, i) => sum + (i.is_dir ? 0 : i.size), 0));

  // Resizable Panel Mouse Handlers
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!appRef.current) return;
    const bounds = appRef.current.getBoundingClientRect();

    if (isDraggingV) {
      const mouseX = e.clientX - bounds.left;
      const newPct = (mouseX / bounds.width) * 100;
      if (newPct > 15 && newPct < 85) {
        setLeftWidthPct(newPct);
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

  const formatTotalSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
        onSearchChange={setSearchQuery}
        searchError={searchError}
        searchNotice={searchNotice}
        searching={searching}
        includeSubfolders={includeSubfolders}
        onToggleIncludeSubfolders={() => setIncludeSubfolders(!includeSubfolders)}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          localStorage.setItem('boonsh_view_mode', mode);
        }}
        showPreview={showPreview}
        onTogglePreview={() => setShowPreview(!showPreview)}
        showFilePanel={showFilePanel}
        onToggleFilePanel={() => setShowFilePanel(!showFilePanel)}
        showTerminal={showTerminal}
        onToggleTerminal={() => setShowTerminal(!showTerminal)}
        showAssistant={showAssistant}
        onToggleAssistant={() => toggleAssistant()}
        theme={theme}
        onToggleTheme={() => {
          const next = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          localStorage.setItem('boonsh_theme', next);
        }}
        onNavigate={handleNavigate}
        onRefresh={() => fetchDirectory(currentPath)}
        showSettings={showSettings}
        onOpenSettings={() => openSettings()}
        selectionCount={selectedItems.length}
        clipboard={clipboard}
        onCut={() => clipboardSelection('cut')}
        onCopy={() => clipboardSelection('copy')}
        onPaste={pasteClipboard}
        onDelete={deleteSelection}
      />

      {showSettings && (
        <SettingsPanel
          groups={commandGroups}
          onChange={handleCommandGroupsChange}
          onReset={() => setCommandGroups(resetCommandGroups())}
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
                  onRemove={(path) => updateFreqStats(removeVisit(freqStats, path))}
                />
              )}
              <div style={{ flex: '1 1 0%', minHeight: 0 }}>
              <FolderTree
                currentPath={currentPath}
                onNavigate={handleNavigate}
                onAddQuickAccess={handleAddQuickAccess}
                onRefresh={() => fetchDirectory(currentPath)}
              />
              </div>
            </div>

            {/* Splitter between Folder Tree and File Panel */}
            {showFilePanel && (
              <div
                className={`split-handle-v ${isDraggingTree ? 'dragging' : ''}`}
                onMouseDown={() => setIsDraggingTree(true)}
                title="Drag to resize folder tree width"
              />
            )}

            {/* Middle Sub-pane: Main File Explorer Table / Grid */}
            {showFilePanel && (
              <MainFilePanel
                items={sortedItems}
                selectedPaths={selectedPaths}
                onItemClick={handleItemClick}
                onItemContextSelect={handleItemContextSelect}
                cutPaths={clipboard?.mode === 'cut' ? clipboard.paths : []}
                selectionCount={selectedItems.length}
                canPaste={!!clipboard}
                onCut={() => clipboardSelection('cut')}
                onCopy={() => clipboardSelection('copy')}
                onPaste={pasteClipboard}
                onDeleteSelection={deleteSelection}
                onBulkRename={openBulkRename}
                renameTrigger={renameTrigger}
                zipSelectionCount={selectedZips.length}
                isBusy={!!busyMessage}
                onCompress={compressSelection}
                onExtract={extractSelectedZips}
                onClearSelection={() => selectSingle(null)}
                onOpenDirectory={handleNavigate}
                onOpenFile={handleOpenFile}
                viewMode={viewMode}
                colPrefs={colPrefs}
                sortLevels={sortLevels}
                details={details}
                appByExt={appByExt}
                rows={layout.rows}
                groups={groups}
                onGroupColumn={groupColumn}
                onUngroupColumn={(col) => updateGroups(groups.filter((g) => g.column !== col))}
                onUngroupAll={() => updateGroups([])}
                onToggleGroup={toggleGroup}
                onSelectGroup={(groupItems) => {
                  setSelectedItem(groupItems[0] ?? null);
                  setSelectedPaths(new Set(groupItems.map((i) => i.path)));
                  selectionAnchorRef.current = groupItems[0]?.path ?? null;
                }}
                onCollapseAll={() => setCollapsed(new Set(topGroupIds(layout.rows)))}
                onExpandAll={() => setCollapsed(new Set())}
                onSortClick={(col, additive) => updateSort(sortClick(sortLevels, col, additive))}
                onSortSet={(col, order, mode) => updateSort(sortSet(sortLevels, col, order, mode))}
                onSortRemove={(col) => updateSort(sortRemove(sortLevels, col))}
                onDateMode={setDateMode}
                onHideColumn={hideColumn}
                onOpenColumnSettings={() => openSettings('columns')}
                onAddQuickAccess={handleAddQuickAccess}
                currentPath={currentPath}
                onRefresh={() => fetchDirectory(currentPath)}
                globalVars={globalVars}
                pathVars={pathVars}
                onAssignPathVar={assignPathVar}
              />
            )}
          </div>

          {/* Horizontal Split Handle (between File Explorer and Bottom Preview) */}
          {showPreview && (
            <div
              className={`split-handle-h ${isDraggingH ? 'dragging' : ''}`}
              onMouseDown={() => setIsDraggingH(true)}
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
            onMouseDown={() => setIsDraggingV(true)}
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
              onMouseDown={() => setIsDraggingAi(true)}
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
        totalSizeFormatted={formatTotalSize(totalSize)}
        selectedItem={selectedItem}
        selectionCount={selectedItems.length}
        selectionSizeFormatted={formatSelectedSize()}
        busyMessage={busyMessage}
        shellEngine={shellEngine}
      />
    </div>
  );
}

export default App;
