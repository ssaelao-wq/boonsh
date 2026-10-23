import React, { useState, useEffect, useRef } from 'react';
import { Terminal as XTerm, IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ShieldAlert,
  ShieldCheck,
  Terminal as TermIcon,
  BookOpen,
  X,
  Variable,
  Lock,
  ShoppingBasket,
  ChevronRight,
  Scissors,
  Copy,
  ClipboardPaste,
  Plus,
  Pencil,
  Palette,
  Sparkles,
  MessageSquare,
  Columns2,
  Rows2,
  Grid2x2,
  Search,
  FileDown,
  ChevronUp,
  ChevronDown,
  History as HistoryIcon,
} from 'lucide-react';
import { useMenuPosition } from '../useMenuPosition';
import { CommandGroup, CommandItem, GroupIcon } from '../commands';
import { PathVars, PathVarName, displayPath } from '../pathVars';
import { GlobalVarDef } from '../globalVars';
import { ConstVar } from '../constVars';
import { hotkeyFromEvent } from '../hotkey';
import { TermTab } from '../types';
import { TAB_COLORS } from '../tabColors';
import {
  SplitDir,
  SplitRatios,
  DIR_LABEL,
  canSplitCell,
  cellRect,
  crossDir,
  dividers,
  edgeCss,
  paneName,
  spanCss,
} from '../splitLayout';

interface TerminalPanelProps {
  currentPath: string;
  theme: 'dark' | 'light';
  visible: boolean;
  tabs: TermTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void; // the whole tab (all its screens when split)
  onSplitTab: (id: string, dir: SplitDir) => void; // Split Screen: a second shell beside or under this tab's
  onSplitPane: (id: string) => void; // split one half of a split tab again, across the first split
  onClosePane: (id: string) => void; // one screen of a split tab
  onCloseAllTabs: () => void;
  onRenameTab: (id: string, name: string) => void;
  onRecolorTab: (id: string, color: string) => void;
  onMoveTab: (id: string, toIndex: number) => void;
  onShellExit: (id: string) => void; // the shell of a tab ended (typed `exit`)
  onSwitchLevel: () => void; // the Admin / normal user button: change the login of the active tab
  onSpawnFailed: (id: string, message: string) => void; // a tab's shell could not start
  onShellCwdChange: (id: string, path: string) => void;
  onPromptState: (id: string, atPrompt: boolean) => void;
  commandGroups: CommandGroup[];
  onOpenSettings: () => void;
  onPickCommand: (template: string) => Promise<void>;
  /** the command palette picked a saved command (or a variable): run it like a pick from the Commands menu */
  paletteRequest?: { id: number; item: CommandItem } | null;
  onPickHistory: (command: string) => Promise<void>; // History Commands: put an earlier command on the prompt line
  hotkeysOn: boolean; // false while a dialog (Settings) is open
  onUserInput: () => void;
  globalVars: GlobalVarDef[];
  constVars: ConstVar[];
  baskets: string[]; // names of the baskets in the current folder ({BASKET:name} in the Global Var menu)
  pathVars: PathVars;
  onClearPathVar: (name: PathVarName) => void;
  onAskAi: (text: string, send: boolean) => void; // selected text to the AI Assistant (send = explain it now)
}

/** One tab's terminal: its xterm, the element it lives in, and its prompt (OSC) handler. */
interface Session {
  term: XTerm;
  fit: FitAddon;
  search: SearchAddon; // Find Text
  el: HTMLDivElement;
  osc: { dispose: () => void };
  atPrompt: boolean; // the shell's prompt is showing (set by its OSC 9 report, cleared by Enter)
  // A command sent with Enter (marker = its line), read once the shell has drawn it and moved past it (readPending)
  pending: { marker: IMarker; timer: number; atEnter: string; settle?: number; seen?: string } | null;
  history: string[]; // History Commands: this screen's last HISTORY_KEEP commands, newest last
}

const HISTORY_KEEP = 20;

// History Commands. Enter is pressed before the shell has echoed everything typed (fast typing, a paste, a busy
// shell), so the command is read from the screen when the shell has finished with the line: the cursor moved
// below it, a full-screen program took over or the next prompt came (all of which ConPTY can report a little
// before the last of the line is drawn, hence SETTLE_MS more), or after 5 s at the latest. `now` reads at once
// (the next Enter). If the line is gone by then (cls clears it in the same output), the text seen when it was
// done is used, else the text on it when Enter was pressed.
const SETTLE_MS = 250;
const readPending = (s: Session, now = false) => {
  const p = s.pending;
  if (!p) return;
  const read = () => (!p.marker.isDisposed && p.marker.line >= 0 ? promptLine(s.term, p.marker.line) : '');
  if (!now) {
    if (p.settle) return;
    p.seen = read();
    p.settle = window.setTimeout(() => readPending(s, true), SETTLE_MS);
    return;
  }
  const cmd = read() || p.seen || p.atEnter;
  dropPending(s); // disposes the marker, so after the read
  // a repeat (ignoring upper / lower case) moves to the end, written as it was typed this time
  const key = cmd.toLowerCase();
  if (cmd) s.history = [...s.history.filter((c) => c.toLowerCase() !== key), cmd].slice(-HISTORY_KEEP);
};
const dropPending = (s: Session) => {
  const p = s.pending;
  if (!p) return;
  s.pending = null;
  clearTimeout(p.timer);
  clearTimeout(p.settle);
  p.marker.dispose();
};
const lineDone = (s: Session) => {
  const p = s.pending;
  if (!p) return false;
  const buf = s.term.buffer.normal;
  if (s.term.buffer.active !== buf || p.marker.isDisposed || p.marker.line < 0) return true;
  let last = p.marker.line;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  return buf.baseY + buf.cursorY > last;
};

// The command line the user is sending: the logical line (wrapped rows joined) that starts at `row`, without
// the prompt (`admin > `, `NAME > `, cmd's `NAME >`; names cannot contain `>`) and without PSReadLine's inline
// prediction (grey dim + italic text after the cursor, not part of the command).
const promptLine = (term: XTerm, row: number): string => {
  const buf = term.buffer.normal; // the prompt is never on the alternate (full-screen) buffer
  const cell = buf.getNullCell();
  let text = '';
  for (let y = row; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line || (y > row && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell)) break;
      if (cell.getWidth() === 0) continue; // the second half of a wide character
      if (cell.isDim() && cell.isItalic()) continue;
      text += cell.getChars() || ' ';
    }
  }
  const gt = text.indexOf('>');
  return gt < 0 ? '' : text.slice(gt + 1).trim();
};

// finding: Find Text is open on this terminal. The search add-on selects the current match and the selection is
// drawn over its highlight, so the selection takes the current-match color (also while the find box has the focus).
const xtermTheme = (t: 'dark' | 'light', finding = false) => {
  const isLight = t === 'light';
  const sel = finding ? findDecorations(t).activeMatchBackground : isLight ? '#d4d4d8' : '#3f3f46';
  return {
    background: isLight ? '#f4f4f5' : '#000000',
    foreground: isLight ? '#09090b' : '#ffffff',
    cursor: isLight ? '#09090b' : '#ffffff',
    selectionBackground: sel,
    selectionInactiveBackground: sel,
  };
};

// Lines kept per command line, and the most Export Screen writes
const SCROLLBACK_LINES = 50000;

// Find Text highlights: every match, and a stronger one for the current match (#RRGGBB only)
const findDecorations = (t: 'dark' | 'light') =>
  t === 'light'
    ? { matchBackground: '#fde047', activeMatchBackground: '#fb923c', matchOverviewRuler: '#ca8a04', activeMatchColorOverviewRuler: '#ea580c' }
    : { matchBackground: '#854d0e', activeMatchBackground: '#ea580c', matchOverviewRuler: '#ca8a04', activeMatchColorOverviewRuler: '#f97316' };

/** The text of a command line: every line kept (up to SCROLLBACK_LINES), wrapped lines joined, CRLF ends. */
function screenText(term: XTerm): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-SCROLLBACK_LINES).join('\r\n') + '\r\n';
}

function copySelection(term: XTerm, clear: boolean) {
  const text = term.getSelection();
  if (!text) return;
  navigator.clipboard.writeText(text).catch(() => {});
  if (clear) term.clearSelection();
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  currentPath,
  theme,
  visible,
  tabs,
  activeTabId,
  onSelectTab,
  onNewTab,
  onCloseTab,
  onSplitTab,
  onSplitPane,
  onClosePane,
  onCloseAllTabs,
  onRenameTab,
  onRecolorTab,
  onMoveTab,
  onShellExit,
  onSwitchLevel,
  onSpawnFailed,
  onShellCwdChange,
  onPromptState,
  commandGroups,
  onOpenSettings,
  onPickCommand,
  paletteRequest,
  onPickHistory,
  hotkeysOn,
  onUserInput,
  globalVars,
  constVars,
  baskets,
  pathVars,
  onClearPathVar,
  onAskAi,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Latest callback for the mount-once OSC handler below
  const onShellCwdChangeRef = useRef(onShellCwdChange);
  onShellCwdChangeRef.current = onShellCwdChange;
  const onPromptStateRef = useRef(onPromptState);
  onPromptStateRef.current = onPromptState;
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  const [username, setUsername] = useState<string>('User');

  // id: the screen that was right-clicked
  const [termMenu, setTermMenu] = useState<{ x: number; y: number; hasSel: boolean; id: string } | null>(null);
  const termMenuPos = useMenuPosition(termMenu);
  const menuTerm = (): XTerm | null =>
    (termMenu && sessionsRef.current.get(termMenu.id)?.term) || xtermRef.current;

  const pasteFromClipboard = () => {
    const term = menuTerm();
    setTermMenu(null);
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text && term) term.paste(text);
      })
      .catch(() => {})
      .finally(() => term?.focus());
  };

  // Tab right-click menu, header right-click menu, and the tab being renamed
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const tabCtxPos = useMenuPosition(tabCtx);
  const [headerCtx, setHeaderCtx] = useState<{ x: number; y: number } | null>(null);
  const headerCtxPos = useMenuPosition(headerCtx);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);

  const [colorOpen, setColorOpen] = useState(false); // the swatches inside the tab menu

  // Drag a tab sideways to reorder: while the mouse is held, the tab swaps with whichever tab is under it
  const tabElsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{ id: string; x: number; moved: boolean } | null>(null);
  const justDraggedRef = useRef(false);
  const onMoveTabRef = useRef(onMoveTab);
  onMoveTabRef.current = onMoveTab;
  const startTabDrag = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || renaming) return;
    dragRef.current = { id, x: e.clientX, moved: false };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.x) < 5) return;
      d.moved = true;
      const list = tabsRef.current.filter((t) => !t.splitOf); // the headers (the other screens of a split tab have none)
      const over = list.findIndex((t) => {
        const r = tabElsRef.current[t.id]?.getBoundingClientRect();
        return r && ev.clientX >= r.left && ev.clientX <= r.right;
      });
      if (over >= 0 && list[over].id !== d.id) onMoveTabRef.current(d.id, over);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      justDraggedRef.current = !!dragRef.current?.moved; // swallow the click that ends a drag
      dragRef.current = null;
      setTimeout(() => (justDraggedRef.current = false), 0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const commitRename = () => {
    if (renaming) {
      const name = renaming.draft.trim();
      if (name) onRenameTab(renaming.id, name);
    }
    setRenaming(null);
  };

  // The Admin / normal user button shows the login of the active tab (the active screen of a split tab)
  const isAdmin = tabs.find((t) => t.id === activeTabId)?.level === 'admin';

  // Split Screen: only the first screen of a tab has a tab header; the others belong to the header of their `splitOf`
  const heads = tabs.filter((t) => !t.splitOf);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeMainId = activeTab ? activeTab.splitOf ?? activeTab.id : null;
  const activeMain = heads.find((t) => t.id === activeMainId);
  // the screens of the active tab when it is split (two to four), else empty
  const activePanes = activeMain?.cell ? tabs.filter((t) => t.id === activeMain.id || t.splitOf === activeMain.id) : [];
  const paneCount = (headId: string) => tabs.filter((x) => x.id === headId || x.splitOf === headId).length;
  // "Top-Left" ... for a screen of a split tab, '' for a tab that is not split
  const sideOf = (t: TermTab | undefined): string => {
    if (!t?.cell) return '';
    const head = t.splitOf ? tabs.find((x) => x.id === t.splitOf) : t;
    return paneName(head?.splitDir ?? 'lr', t.cell);
  };
  const splitIcon = (head: TermTab, size: number, color?: string) => {
    const style = { flexShrink: 0, color };
    if (paneCount(head.id) > 2) return <Grid2x2 size={size} style={style} />;
    return head.splitDir === 'tb' ? <Rows2 size={size} style={style} /> : <Columns2 size={size} style={style} />;
  };
  // The screen last used in each split tab, so clicking its header goes back to that screen
  const lastPaneRef = useRef<Record<string, string>>({});
  if (activeTab && activeMainId) lastPaneRef.current[activeMainId] = activeTab.id;
  const pickHeader = (mainId: string) => {
    if (activeMainId === mainId) return;
    const last = lastPaneRef.current[mainId];
    const ok = last && tabs.some((x) => x.id === last && (x.id === mainId || x.splitOf === mainId));
    onSelectTab(ok ? last : mainId);
  };
  const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  const [showHelperMenu, setShowHelperMenu] = useState<boolean>(false);
  const [showVarsMenu, setShowVarsMenu] = useState<boolean>(false);
  const [showConstMenu, setShowConstMenu] = useState<boolean>(false);
  // History Commands: the list of the screen it was opened for (a copy taken when it opens)
  const [historyMenu, setHistoryMenu] = useState<{ id: string; items: string[] } | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (showHelperMenu || showVarsMenu || showConstMenu) setHistoryMenu(null);
  }, [showHelperMenu, showVarsMenu, showConstMenu]);
  const [activeCategory, setActiveCategory] = useState<string>('Basic Commands');
  const [usageBanner, setUsageBanner] = useState<{ command: string; usage: string } | null>(null);

  // Only variables that have a value are listed; with none set the Global Var button is hidden
  const setVarNames = globalVars.map((v) => v.name).filter((n) => (pathVars[n] ?? []).length > 0);

  useEffect(() => {
    if (setVarNames.length === 0) setShowVarsMenu(false);
  }, [setVarNames.length]);

  const activeCatObj = commandGroups.find((c) => c.category === activeCategory) || commandGroups[0];

  useEffect(() => {
    invoke<string>('get_username')
      .then((name) => setUsername(name))
      .catch(() => {});
  }, []);

  // ---- Tabs: one xterm + one PTY per tab; only the active tab's xterm is shown ----
  const sessionsRef = useRef<Map<string, Session>>(new Map());
  const activeIdRef = useRef<string | null>(activeTabId);
  activeIdRef.current = activeTabId;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onShellExitRef = useRef(onShellExit);
  onShellExitRef.current = onShellExit;
  const onSpawnFailedRef = useRef(onSpawnFailed);
  onSpawnFailedRef.current = onSpawnFailed;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Split Screen: where the separators of each split tab sit, half and half at first; memory only. Keys:
  // `<tab id>:<dir>` for the first split, `<tab id>:<dir>:a` / `:b` for the split inside a half (a new direction
  // after a close starts at half and half again).
  const [splitRatio, setSplitRatio] = useState<Record<string, number>>({});
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const ratioKey = (head: TermTab, which: 'main' | 'a' | 'b') =>
    `${head.id}:${head.splitDir ?? 'lr'}${which === 'main' ? '' : `:${which}`}`;
  const ratiosOf = (head: TermTab, map: Record<string, number>): SplitRatios => ({
    main: map[ratioKey(head, 'main')] ?? 0.5,
    a: map[ratioKey(head, 'a')] ?? 0.5,
    b: map[ratioKey(head, 'b')] ?? 0.5,
  });
  const onSelectTabRef = useRef(onSelectTab);
  onSelectTabRef.current = onSelectTab;

  // The screens shown for the active tab: its own, plus the others when it is split
  const shownIds = (): string[] => {
    const id = activeIdRef.current;
    if (!id) return [];
    const list = tabsRef.current;
    const t = list.find((x) => x.id === id);
    if (!t) return [id];
    const main = t.splitOf ?? t.id;
    return list.filter((x) => x.id === main || x.splitOf === main).map((x) => x.id);
  };

  // Fit the shown terminals to their boxes and tell their PTYs
  const refit = () => {
    for (const id of shownIds()) {
      const s = sessionsRef.current.get(id);
      if (!s || s.el.style.display === 'none') continue;
      s.fit.fit();
      s.term.scrollToBottom();
      invoke('pty_resize', { id, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  };

  // Place the terminals: the active tab's screen(s) are shown, each in its box under its own header bar when the
  // tab is split, the rest hidden
  const SPLIT_GAP = 3; // half the width of the separator between two screens
  const PANE_HEAD = 22; // the header bar on top of each screen of a split tab
  const layout = () => {
    const ids = shownIds();
    const list = tabsRef.current;
    const first = list.find((t) => t.id === ids[0]);
    const head = first?.splitOf ? list.find((t) => t.id === first.splitOf) : first;
    const split = ids.length > 1 && head?.cell;
    const ratios = head ? ratiosOf(head, splitRatioRef.current) : null;
    sessionsRef.current.forEach((s, id) => {
      const shown = ids.includes(id);
      s.el.style.display = shown ? 'block' : 'none';
      const cell = list.find((t) => t.id === id)?.cell;
      if (!shown || !split || !cell || !head || !ratios) {
        Object.assign(s.el.style, { left: '0', top: '0', right: '0', bottom: '0', width: '', height: '' });
        return;
      }
      const r = cellRect(head.splitDir ?? 'lr', cell, ratios, SPLIT_GAP);
      Object.assign(s.el.style, {
        left: edgeCss(r.x0),
        top: edgeCss(r.y0, PANE_HEAD),
        width: spanCss(r.x0, r.x1),
        height: spanCss(r.y0, r.y1, -PANE_HEAD),
        right: '',
        bottom: '',
      });
    });
  };

  const createSession = (tab: TermTab) => {
    const host = terminalRef.current;
    if (!host) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;';
    el.style.display = tab.id === activeIdRef.current ? 'block' : 'none';
    host.appendChild(el);
    // A click in a screen of a split tab makes it the active one (commands, cd and the file panel follow it)
    el.addEventListener('mousedown', () => onSelectTabRef.current(tab.id), true);

    const term = new XTerm({
      // Fixed-width app font (--font-mono) at the file panel's 12px; xterm needs a literal font string
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      theme: xtermTheme(themeRef.current),
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true, // the search add-on draws its match highlights with decorations
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(el);
    fit.fit();
    search.onDidChangeResults((r) => {
      if (findRef.current?.id === tab.id) setFindResult({ index: r.resultIndex, count: r.resultCount });
    });

    // Shell prompt reports its working directory via OSC 9;9 (see pty.rs) -> sync file panel
    const osc = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith('9;')) return false;
      onPromptStateRef.current(tab.id, true); // the prompt function ran: the shell is idle again
      const s = sessionsRef.current.get(tab.id);
      if (s) {
        readPending(s); // the command before this prompt is done
        s.atPrompt = true;
      }
      const path = data.slice(2).replace(/^"|"$/g, '');
      if (path) onShellCwdChangeRef.current(tab.id, path);
      return true;
    });

    // Ctrl+C copies when text is selected (else it stays the shell's interrupt); Ctrl+X does the same
    // for a selection (output text cannot be removed, so cut = copy); Ctrl+V is left to the browser
    // paste event, which xterm turns into input. Without a selection Ctrl+X still reaches the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
      const key = e.key.toLowerCase();
      // the app's own Ctrl+Shift keys (command palette, file panel): handled by App's window listener, not
      // sent to the shell (Ctrl+P / Ctrl+F are PSReadLine keys)
      if (e.shiftKey && (key === 'p' || key === 'f')) return false;
      if ((key === 'c' || key === 'x') && term.hasSelection()) {
        copySelection(term, key === 'x');
        e.preventDefault();
        return false;
      }
      if (key === 'v') return false;
      return true;
    });

    // Handle user input in terminal
    term.onData((data) => {
      if (data.includes('\r')) {
        // Enter at the prompt: the command goes to History Commands once the shell has drawn it (readPending).
        // Input to a running program (a password, an answer) is never recorded.
        const s = sessionsRef.current.get(tab.id);
        // The cursor is on the command's line (the start of its wrapped rows); not where the cursor was at the
        // prompt's OSC report: ConPTY passes that through before the rows in front of the prompt are drawn.
        if (s?.atPrompt) {
          readPending(s, true);
          const buf = term.buffer.normal;
          const cursor = buf.baseY + buf.cursorY;
          let start = cursor;
          while (start > 0 && buf.getLine(start)?.isWrapped) start--;
          const marker = term.registerMarker(start - cursor); // a marker follows scrollback trimming
          if (marker) {
            const timer = window.setTimeout(() => readPending(s, true), 5000);
            s.pending = { marker, timer, atEnter: promptLine(term, start) }; // last resort: what is drawn now
          }
        }
        if (s) s.atPrompt = false;
        onPromptStateRef.current(tab.id, false); // Enter: a command or program is running until the next prompt
      }
      onUserInputRef.current(); // anything typed here means a pending {SELEC}/{DEST} line is no longer ours to rewrite
      invoke('pty_write', { id: tab.id, data }).catch((err) => console.error('PTY Write Error:', err));
    });

    sessionsRef.current.set(tab.id, { term, fit, search, el, osc, atPrompt: false, pending: null, history: [] });
    // Spawn native Windows PTY process (pwsh.exe / powershell.exe)
    invoke<string>('pty_spawn', {
      id: tab.id,
      cols: term.cols,
      rows: term.rows,
      cwd: tab.cwd || null,
      level: tab.level,
    }).catch((err) => console.error('PTY Spawn Error:', err));
  };

  // Output and shell-exit events from the Rust backend (every tab's, told apart by id); resize hooks
  useEffect(() => {
    const unlistenOut = listen<{ id: string; data: string }>('pty-output', (event) => {
      const s = sessionsRef.current.get(event.payload.id);
      if (!s) return;
      s.term.write(event.payload.data, () => {
        if (lineDone(s)) readPending(s);
      });
      s.term.scrollToBottom();
    });
    const unlistenExit = listen<{ id: string }>('pty-exit', (event) => onShellExitRef.current(event.payload.id));
    const unlistenFailed = listen<{ id: string; message: string }>('pty-failed', (event) =>
      onSpawnFailedRef.current(event.payload.id, event.payload.message)
    );

    // ResizeObserver to refit terminal canvas whenever container dimensions change
    const resizeObserver = new ResizeObserver(() => refit());
    if (terminalRef.current) resizeObserver.observe(terminalRef.current);
    window.addEventListener('resize', refit);

    // Multi-stage initial fit sequence to handle window maximization & startup layout stabilization
    const timers = [50, 150, 350, 750].map((ms) => setTimeout(refit, ms));

    return () => {
      timers.forEach(clearTimeout);
      resizeObserver.disconnect();
      window.removeEventListener('resize', refit);
      unlistenOut.then((u) => u());
      unlistenExit.then((u) => u());
      unlistenFailed.then((u) => u());
      sessionsRef.current.forEach((s) => {
        dropPending(s);
        s.osc.dispose();
        s.term.dispose();
      });
      sessionsRef.current.clear();
    };
  }, []);

  // A new tab gets its xterm and shell; a closed tab loses them (the shell is ended in the backend)
  const tabIds = tabs.map((t) => t.id).join('|');
  useEffect(() => {
    const map = sessionsRef.current;
    for (const t of tabsRef.current) if (!map.has(t.id)) createSession(t);
    for (const [id, s] of Array.from(map)) {
      if (tabsRef.current.some((t) => t.id === id)) continue;
      dropPending(s);
      s.osc.dispose();
      s.term.dispose();
      s.el.remove();
      map.delete(id);
      invoke('pty_close', { id }).catch(() => {});
    }
  }, [tabIds]);

  // Show the active tab's terminal(s) (also when the panel is shown again), refit and give the active one the cursor
  useEffect(() => {
    const map = sessionsRef.current;
    layout();
    const s = activeTabId ? map.get(activeTabId) : undefined;
    xtermRef.current = s ? s.term : null;
    fitAddonRef.current = s ? s.fit : null;
    if (!visible || !s) return;
    refit();
    const timer = setTimeout(() => {
      refit();
      s.term.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [activeTabId, visible, tabIds]);

  // A separator was dragged or the screens of a tab moved: place and refit the shown screens
  const layoutSig = tabs.map((t) => `${t.id}:${t.cell ?? ''}:${t.splitDir ?? ''}`).join('|');
  useEffect(() => {
    layout();
    refit();
  }, [splitRatio, layoutSig]);

  // Drag a separator between the screens of a split tab (`vertical` lines move sideways, the others up and down)
  const splitBoxRef = useRef<HTMLDivElement>(null);
  const [draggingSplit, setDraggingSplit] = useState<{ key: string; vertical: boolean } | null>(null);
  const startSplitDrag = (e: React.MouseEvent, key: string, vertical: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDraggingSplit({ key, vertical });
    const move = (ev: MouseEvent) => {
      const r = splitBoxRef.current?.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return;
      const share = vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      const ratio = Math.min(0.85, Math.max(0.15, share));
      setSplitRatio((m) => ({ ...m, [key]: ratio }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDraggingSplit(null);
      sessionsRef.current.get(activeIdRef.current ?? '')?.term.focus();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ---- Find Text: a floating box over one screen; matches are highlighted, Up / Down step through them ----
  const [find, setFind] = useState<{ id: string; text: string } | null>(null);
  const findRef = useRef(find);
  findRef.current = find;
  const [findResult, setFindResultState] = useState<{ index: number; count: number } | null>(null);
  const findResultRef = useRef(findResult); // read right after a step (the add-on reports synchronously)
  const setFindResult = (r: { index: number; count: number } | null) => {
    findResultRef.current = r;
    setFindResultState(r);
  };
  const findInputRef = useRef<HTMLInputElement>(null);
  const lastFindRef = useRef(''); // the box opens with the last text searched

  const runFind = (dir: 'up' | 'down', text: string, fromEnd = false) => {
    const f = findRef.current;
    const s = f ? sessionsRef.current.get(f.id) : undefined;
    if (!s) return;
    if (!text) {
      s.search.clearDecorations();
      setFindResult(null);
      return;
    }
    // A new text starts from the bottom (the newest output) and goes up
    if (fromEnd) s.term.clearSelection();
    const opts = { decorations: findDecorations(themeRef.current) };
    const step = () => (dir === 'up' ? s.search.findPrevious(text, opts) : s.search.findNext(text, opts));
    const before = findResultRef.current;
    const found = step();
    // Turning around (Up, then Down) the add-on first lands on the match it is already on: take one more step
    const after = findResultRef.current;
    if (found && !fromEnd && before && after && after.count > 1 && after.index === before.index) step();
    if (!found) setFindResult({ index: -1, count: 0 });
  };
  const closeFind = (focus = true) => {
    const f = findRef.current;
    const s = f ? sessionsRef.current.get(f.id) : undefined;
    if (s) {
      s.search.clearDecorations();
      s.term.clearSelection();
      s.term.options.theme = xtermTheme(themeRef.current);
      if (focus) s.term.focus();
    }
    findRef.current = null;
    setFind(null);
    setFindResult(null);
  };
  const openFind = (id: string) => {
    if (findRef.current && findRef.current.id !== id) closeFind(false);
    if (id !== activeIdRef.current) onSelectTab(id);
    const text = findRef.current?.id === id ? findRef.current.text : lastFindRef.current;
    const next = { id, text };
    findRef.current = next;
    setFind(next);
    const s = sessionsRef.current.get(id);
    if (s) s.term.options.theme = xtermTheme(themeRef.current, true);
    setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
      if (text) runFind('up', text, true);
    }, 80);
  };
  // The screen with the box went away or is no longer shown: close the box
  useEffect(() => {
    if (find && !shownIds().includes(find.id)) closeFind(false);
  }, [activeTabId, tabIds]);
  // Theme changed: draw the highlights in the new colors
  useEffect(() => {
    if (findRef.current?.text) runFind('up', findRef.current.text, true);
  }, [theme]);

  // ---- Export Screen: everything the command line still holds (up to 50,000 lines) to a .txt file ----
  const [exportNote, setExportNote] = useState<string | null>(null);
  useEffect(() => {
    if (!exportNote) return;
    const t = setTimeout(() => setExportNote(null), 5000);
    return () => clearTimeout(t);
  }, [exportNote]);
  const exportScreen = async (id: string, side?: string) => {
    const s = sessionsRef.current.get(id);
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!s || !tab) return;
    const text = screenText(s.term); // taken now, so output that comes while the dialog is open is not mixed in
    const owner = tabsRef.current.find((t) => t.id === (tab.splitOf ?? tab.id)) ?? tab;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = `${owner.name}${side ? ` ${side}` : ''} ${stamp}`.replace(/[\\/:*?"<>|]+/g, '_');
    try {
      const path = await invoke<string | null>('save_file_dialog', {
        title: 'Export Screen',
        filter: 'Text file (*.txt)|*.txt',
        defaultName: name,
      });
      if (!path) return;
      await invoke('write_text_file', { path, content: '﻿' + text }); // BOM: Thai and other text opens right everywhere
      const lines = text.split('\r\n').length - 1;
      setExportNote(`Saved ${lines.toLocaleString()} line${lines === 1 ? '' : 's'} to ${path}`);
    } catch (err) {
      window.alert(`Export Screen failed: ${err}`);
    }
  };

  // Right-click on the header bar of a screen of a split tab: Find Text / Export Screen / split it / close it
  const [paneCtx, setPaneCtx] = useState<{ x: number; y: number; id: string; side: string } | null>(null);
  const paneCtxPos = useMenuPosition(paneCtx);

  // Synchronize terminal fit & scroll whenever usageBanner toggles
  useEffect(() => {
    refit();
    const timer = setTimeout(refit, 50);
    return () => clearTimeout(timer);
  }, [usageBanner]);

  // Update xterm theme dynamically when app theme changes
  useEffect(() => {
    sessionsRef.current.forEach((s, id) => {
      s.term.options.theme = xtermTheme(theme, findRef.current?.id === id);
    });
  }, [theme]);

  // Refit terminal whenever container resizes
  useEffect(() => {
    const timer = setTimeout(refit, 50);
    return () => clearTimeout(timer);
  }, [currentPath]);

  // Handle Drag & Drop of file paths into terminal
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const textData = e.dataTransfer.getData('text/plain');
    if (textData) {
      invoke('pty_write', { id: activeIdRef.current, data: textData }).then(() => {
        if (xtermRef.current) {
          xtermRef.current.scrollToBottom();
          xtermRef.current.focus();
        }
      }).catch(() => {});
    }
  };

  useEffect(() => {
    if (paletteRequest) handleSelectCommand(paletteRequest.item);
  }, [paletteRequest?.id]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleSelectCommand = (item: CommandItem) => {
    setShowHelperMenu(false);
    setUsageBanner({
      command: item.name,
      usage: item.usage,
    });

    // Write command into PTY stream
    onPickCommand(item.insertText).then(() => {
      // Ensure terminal immediately scrolls to the bottom row where prompt is active
      setTimeout(() => {
        if (xtermRef.current) {
          xtermRef.current.scrollToBottom();
          xtermRef.current.focus();
        }
      }, 30);
    }).catch(() => {});
  };

  // Command hot keys (Settings, Commands): the same as picking the command in the menu. They work only while the
  // command line has the keyboard focus (a command line tab is active), so Ctrl+Alt combinations used by anything
  // else never clash; with focus elsewhere nothing happens. The capture handler runs before xterm sees the key.
  const onHotkey = (e: React.KeyboardEvent) => {
    if (!hotkeysOn || !visible || !activeTabId) return;
    const hk = hotkeyFromEvent(e.nativeEvent);
    if (!hk) return;
    const item = commandGroups.flatMap((g) => g.items).find((i) => i.hotkey === hk);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) handleSelectCommand(item);
  };

  return (
    <div
      onKeyDownCapture={onHotkey}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        flex: '1 1 0%',
        minHeight: 0,
        minWidth: 0,
        background: theme === 'light' ? '#f4f4f5' : '#000000',
        overflow: 'hidden',
        position: 'relative',
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Command line tabs: always shown, even for a single tab */}
      <div className="terminal-tabs">
        {heads.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              tabElsRef.current[t.id] = el;
            }}
            className={`terminal-tab ${t.id === activeMainId ? 'active' : ''}`}
            style={{ '--tab-color': t.color } as React.CSSProperties}
            onMouseDown={(e) => startTabDrag(e, t.id)}
            onClick={() => {
              if (!justDraggedRef.current) pickHeader(t.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setColorOpen(false);
              setTabCtx({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            title={t.cell ? `${t.name} (split screen: ${paneCount(t.id)} screens)` : t.name}
          >
            {t.cell ? (
              splitIcon(t, 12)
            ) : t.level === 'admin' ? (
              <ShieldCheck size={12} style={{ color: '#86efac', flexShrink: 0 }} />
            ) : (
              <TermIcon size={12} style={{ flexShrink: 0 }} />
            )}
            {renaming && renaming.id === t.id ? (
              <input
                className="terminal-tab-input"
                autoFocus
                value={renaming.draft}
                onChange={(e) => setRenaming({ id: t.id, draft: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="terminal-tab-name">{t.name}</span>
            )}
            {heads.length > 1 && (
              <button
                className="terminal-tab-close"
                title={t.cell ? `Close tab (all ${paneCount(t.id)} screens)` : 'Close tab'}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(t.id);
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button className="terminal-tab-new" title="New tab" onClick={onNewTab}>
          <Plus size={13} />
        </button>
      </div>

      {/* Terminal Top Bar with Admin Status & Command Helper */}
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setHeaderCtx({ x: e.clientX, y: e.clientY });
        }}
        style={{
          height: 28,
          minHeight: 28,
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          fontSize: 11,
          color: 'var(--text-muted)',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isAdmin ? (
            <ShieldCheck size={13} style={{ color: '#22c55e' }} />
          ) : (
            <TermIcon size={13} style={{ color: 'var(--text-main)' }} />
          )}
          {/* History Commands: the active screen's last commands (icon only) */}
          <button
            onClick={() => {
              const id = activeIdRef.current;
              const s = id ? sessionsRef.current.get(id) : undefined;
              setHistoryMenu(historyMenu || !id ? null : { id, items: s ? [...s.history] : [] });
              setShowHelperMenu(false);
              setShowVarsMenu(false);
              setShowConstMenu(false);
            }}
            title="History Commands: the last commands of this screen"
            style={{
              padding: '2px 5px',
              display: 'flex',
              alignItems: 'center',
              background: historyMenu ? 'var(--bg-selected)' : 'var(--bg-panel-secondary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <HistoryIcon size={13} style={{ color: '#3b82f6' }} />
          </button>
          {/* Beginner Command Helper Button */}
          <button
            onClick={() => {
              setShowHelperMenu(!showHelperMenu);
              setShowVarsMenu(false);
              setShowConstMenu(false);
            }}
            title="Beginner Command Helper: Click to select common commands"
            style={{
              padding: '2px 7px',
              fontSize: 11,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              background: showHelperMenu ? 'var(--bg-selected)' : 'var(--bg-panel-secondary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <BookOpen size={12} style={{ color: '#f59e0b' }} />
            <span>Commands 💡</span>
          </button>

          {/* Global variables ({SELEC}, {DEST}, ...): values shown in full in a dropdown, plus this folder's baskets */}
          {(setVarNames.length > 0 || baskets.length > 0) && (
          <button
            onClick={() => {
              setShowVarsMenu(!showVarsMenu);
              setShowHelperMenu(false);
              setShowConstMenu(false);
            }}
            title="Global variables shared by the file panel and terminal commands"
            style={{
              padding: '2px 7px',
              fontSize: 11,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              background: showVarsMenu ? 'var(--bg-selected)' : 'var(--bg-panel-secondary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <Variable size={12} style={{ color: '#06b6d4' }} />
            <span>Global Var</span>
          </button>
          )}

          {/* CONST Global Var: fixed values; click one to type its value at the prompt */}
          {constVars.length > 0 && (
          <button
            onClick={() => {
              setShowConstMenu(!showConstMenu);
              setShowVarsMenu(false);
              setShowHelperMenu(false);
            }}
            title="CONST Global Var: fixed values you can type into the command line"
            style={{
              padding: '2px 7px',
              fontSize: 11,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              background: showConstMenu ? 'var(--bg-selected)' : 'var(--bg-panel-secondary)',
              borderColor: 'var(--border-color)',
            }}
          >
            <Lock size={12} style={{ color: '#a855f7' }} />
            <span>CONST Global Var</span>
          </button>
          )}
        </div>

        {historyMenu && (
          <>
            <div
              style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 1040 }}
              onClick={() => setHistoryMenu(null)}
            />
            <div className="terminal-vars-dropdown terminal-history-dropdown">
              <div className="terminal-vars-heading">
                <HistoryIcon size={12} style={{ color: '#3b82f6' }} /> History Commands
                {(() => {
                  const t = tabs.find((x) => x.id === historyMenu.id);
                  if (!t) return null;
                  const side = t.cell ? ` (${sideOf(t)})` : '';
                  return <span className="terminal-history-tab">{`${tabs.find((x) => x.id === (t.splitOf ?? t.id))?.name ?? t.name}${side}`}</span>;
                })()}
              </div>
              {historyMenu.items.length === 0 ? (
                <div className="terminal-vars-hint">No commands in this screen yet.</div>
              ) : (
                <div
                  className="terminal-history-list"
                  ref={(el) => {
                    // newest at the bottom: open scrolled to the end, earlier ones are above
                    if (el && historyListRef.current !== el) el.scrollTop = el.scrollHeight;
                    historyListRef.current = el;
                  }}
                >
                  {historyMenu.items.map((cmd, i) => (
                    <div
                      key={i}
                      className="terminal-history-row"
                      title="Click to put it on the command line (Enter runs it)"
                      onClick={() => {
                        setHistoryMenu(null);
                        onPickHistory(cmd).finally(() => {
                          xtermRef.current?.scrollToBottom();
                          xtermRef.current?.focus();
                        });
                      }}
                    >
                      {cmd}
                    </div>
                  ))}
                </div>
              )}
              <div className="terminal-vars-hint">
                Click one to put it on the command line. The last {HISTORY_KEEP} are kept, newest at the bottom.
              </div>
            </div>
          </>
        )}

        {showConstMenu && constVars.length > 0 && (
          <>
            <div
              style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 1040 }}
              onClick={() => setShowConstMenu(false)}
            />
            <div className="terminal-vars-dropdown">
              {constVars.map((v) => (
                <div
                  key={v.id}
                  className="terminal-vars-row"
                  style={{ cursor: 'pointer' }}
                  title={v.description ? `${v.description} (click to type the value)` : 'Click to type the value'}
                  onClick={() => {
                    setShowConstMenu(false);
                    onPickCommand(`{${v.name}}`).finally(() => xtermRef.current?.focus());
                  }}
                >
                  <span className="terminal-vars-name">{`{${v.name}}`}</span>
                  <div className="terminal-vars-value">
                    <div>{v.value}</div>
                    {v.description && <div style={{ color: 'var(--text-muted)' }}>{v.description}</div>}
                  </div>
                </div>
              ))}
              <div className="terminal-vars-hint">
                Click one to type its value at the prompt. Add or change them in Settings, CONST Global Var.
              </div>
            </div>
          </>
        )}

        {showVarsMenu && (setVarNames.length > 0 || baskets.length > 0) && (
          <>
            <div
              style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 1040 }}
              onClick={() => setShowVarsMenu(false)}
            />
            <div className="terminal-vars-dropdown">
              {setVarNames.map((name) => {
                const values = pathVars[name] ?? [];
                return (
                  <div key={name} className="terminal-vars-row">
                    <span className="terminal-vars-name">{`{${name}}`}</span>
                    <div className="terminal-vars-value">
                      {values.map((p) => <div key={p} title={p}>{displayPath(p, currentPath)}</div>)}
                    </div>
                    <button
                      className="terminal-vars-clear"
                      onClick={() => onClearPathVar(name)}
                      title={`Clear {${name}}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
              {setVarNames.length > 0 && (
                <div className="terminal-vars-hint">
                  Set them with right-click in the file panel. Use them in your Commands as {'{NAME}'}.
                </div>
              )}
              {baskets.length > 0 && (
                <>
                  <div className="terminal-vars-heading">
                    <ShoppingBasket size={12} className="basket-icon" /> Baskets in this folder
                  </div>
                  {baskets.map((name) => (
                    <div
                      key={name}
                      className="terminal-vars-row"
                      style={{ cursor: 'pointer' }}
                      title="Click to type it; the command gets the basket's linked items"
                      onClick={() => {
                        setShowVarsMenu(false);
                        onPickCommand(`{BASKET:${name}}`).finally(() => xtermRef.current?.focus());
                      }}
                    >
                      <span className="terminal-vars-name">{`{BASKET:${name}}`}</span>
                    </div>
                  ))}
                  <div className="terminal-vars-hint">
                    For many links use a pipe, e.g. basket "{baskets[0]}" | Copy-Item -Destination D:\Send
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* 2-Step Command Helper Dropdown Menu */}
        {showHelperMenu && (
          <>
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100vw',
                height: '100vh',
                zIndex: 1040,
              }}
              onClick={() => setShowHelperMenu(false)}
            />
            <div className="terminal-cmd-dropdown">
              {/* Step 1: Category Groups */}
              <div className="terminal-cmd-categories-list">
                {commandGroups.map((cat) => (
                  <div
                    key={cat.category}
                    className={`terminal-cmd-cat-item ${activeCategory === cat.category ? 'active' : ''}`}
                    onMouseEnter={() => setActiveCategory(cat.category)}
                    onClick={() => setActiveCategory(cat.category)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <GroupIcon icon={cat.icon} />
                      <span>{cat.category}</span>
                    </div>
                    <ChevronRight size={13} style={{ color: 'var(--text-dim)' }} />
                  </div>
                ))}
              </div>

              {/* Step 2: Commands Submenu for Selected Category Group */}
              <div className="terminal-cmd-submenu">
                <div className="terminal-cmd-cat-header">
                  <GroupIcon icon={activeCatObj.icon} />
                  <span>{activeCatObj.category}</span>
                </div>
                <div className="terminal-cmd-items-list">
                  {activeCatObj.items.length === 0 && (
                    <div className="terminal-cmd-empty">
                      No commands in this group yet.{' '}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setShowHelperMenu(false);
                          onOpenSettings();
                        }}
                      >
                        Add some in Settings
                      </a>
                      .
                    </div>
                  )}
                  {activeCatObj.items.map((item) => (
                    <div
                      key={item.id}
                      className="terminal-cmd-item"
                      onClick={() => handleSelectCommand(item)}
                    >
                      <div className="terminal-cmd-name">
                        {item.name}
                        {item.hotkey && <span className="hotkey-badge">{item.hotkey}</span>}
                      </div>
                      <div className="terminal-cmd-desc">{item.description}</div>
                      <div className="terminal-cmd-usage-preview">Usage: {item.usage}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {isAdmin ? (
          <button
            onClick={onSwitchLevel}
            title="This tab runs as Administrator. Click to switch this tab to Normal User mode (only this tab changes)"
            style={{ padding: '2px 8px', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center', borderColor: 'var(--border-light)' }}
          >
            <ShieldCheck size={14} style={{ color: '#22c55e' }} />
            <span style={{ color: '#22c55e' }}>User: {username} (Admin)</span>
          </button>
        ) : (
          <button
            onClick={onSwitchLevel}
            title="This tab runs as a normal user. Click to switch this tab to Administrator (only this tab changes; Windows asks for permission)"
            style={{ padding: '2px 8px', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}
          >
            <ShieldAlert size={14} style={{ color: '#ef4444' }} />
            <span>User: {username}</span>
          </button>
        )}
      </div>

      {/* Usage Banner Toast when a Command is selected */}
      {usageBanner && (
        <div className="terminal-usage-banner">
          <div>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>💡 Usage: </span>
            <span>{usageBanner.usage}</span>
          </div>
          <button
            onClick={() => setUsageBanner(null)}
            style={{ border: 'none', padding: 2, cursor: 'pointer' }}
            title="Dismiss usage hint"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main Interactive PowerShell Terminal */}
      {tabs.length === 0 && (
        <div className="terminal-empty">
          <span>No command line is open.</span>
          <button className="btn-primary" onClick={onNewTab}>
            New Tab
          </button>
        </div>
      )}
      <div
        ref={splitBoxRef}
        style={{
          flex: '1 1 0%',
          minHeight: 0,
          position: 'relative',
          display: tabs.length === 0 ? 'none' : 'flex',
        }}
      >
        <div
          className="terminal-container"
          ref={terminalRef}
          style={{ background: theme === 'light' ? '#f4f4f5' : '#000000' }}
          onContextMenu={(e) => {
            e.preventDefault();
            // the screen that was right-clicked (a split tab has two to four)
            let id = activeIdRef.current;
            sessionsRef.current.forEach((s, sid) => {
              if (s.el.contains(e.target as Node)) id = sid;
            });
            const s = id ? sessionsRef.current.get(id) : undefined;
            setTermMenu({ x: e.clientX, y: e.clientY, hasSel: !!s?.term.hasSelection(), id: id ?? '' });
          }}
        />
        {/* Split Screen: a header bar on top of each screen (its name, folder and close button) and the separators */}
        {activeMain?.cell && activePanes.length > 1 && (() => {
          const dir = activeMain.splitDir ?? 'lr';
          const ratios = ratiosOf(activeMain, splitRatio);
          return (
            <>
              {activePanes.map((p) => {
                if (!p.cell) return null;
                const r = cellRect(dir, p.cell, ratios, SPLIT_GAP);
                const name = paneName(dir, p.cell);
                return (
                  <div
                    key={p.id}
                    className={`split-pane-head ${p.id === activeTabId ? 'active' : ''}`}
                    style={{
                      '--tab-color': activeMain.color,
                      left: edgeCss(r.x0),
                      top: edgeCss(r.y0),
                      width: spanCss(r.x0, r.x1),
                      height: PANE_HEAD,
                    } as React.CSSProperties}
                    onClick={() => onSelectTab(p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setPaneCtx({ x: e.clientX, y: e.clientY, id: p.id, side: name });
                    }}
                    title={`${name} screen: ${p.cwd} (right-click: Find Text, Export Screen${canSplitCell(p.cell) ? ', Split' : ''})`}
                  >
                    {p.level === 'admin' ? (
                      <ShieldCheck size={11} style={{ color: '#22c55e', flexShrink: 0 }} />
                    ) : (
                      <TermIcon size={11} style={{ flexShrink: 0 }} />
                    )}
                    <span className="split-bar-label">{name}</span>
                    <span className="split-bar-folder">{folderName(p.cwd)}</span>
                    <button
                      className="terminal-tab-close"
                      title={`Close the ${name} screen`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClosePane(p.id);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
              {dividers(dir, activePanes.flatMap((p) => (p.cell ? [p.cell] : [])), ratios, SPLIT_GAP).map((d) => {
                const key = ratioKey(activeMain, d.key);
                const pos = { f: d.at, px: -SPLIT_GAP };
                const style: React.CSSProperties = d.vertical
                  ? { left: edgeCss(pos), width: SPLIT_GAP * 2, top: edgeCss(d.from), height: spanCss(d.from, d.to) }
                  : { top: edgeCss(pos), height: SPLIT_GAP * 2, left: edgeCss(d.from), width: spanCss(d.from, d.to) };
                return (
                  <div
                    key={d.key}
                    className={`split-divider ${d.vertical ? 'col' : 'row'} ${draggingSplit?.key === key ? 'dragging' : ''}`}
                    style={style}
                    onMouseDown={(e) => startSplitDrag(e, key, d.vertical)}
                    onDoubleClick={() => setSplitRatio((m) => ({ ...m, [key]: 0.5 }))}
                    title="Drag to resize the screens (double-click: half and half)"
                  />
                );
              })}
            </>
          );
        })()}
        {find && (() => {
          // over the top right of its own screen, under its header bar when the tab is split, never wider than it
          const ft = tabs.find((t) => t.id === find.id);
          const r =
            ft?.cell && activeMain?.cell && activePanes.length > 1
              ? cellRect(activeMain.splitDir ?? 'lr', ft.cell, ratiosOf(activeMain, splitRatio), SPLIT_GAP)
              : null;
          const right = r ? `calc(${(1 - r.x1.f) * 100}% + ${18 - r.x1.px}px)` : '18px';
          const top = r ? edgeCss(r.y0, PANE_HEAD + 6) : undefined;
          const maxWidth = r ? spanCss(r.x0, r.x1, -30) : 'calc(100% - 30px)';
          const status = !find.text
            ? ''
            : !findResult || findResult.count === 0
              ? 'No results'
              : findResult.index < 0
                ? `${findResult.count.toLocaleString()}+ found`
                : `${findResult.index + 1} of ${findResult.count.toLocaleString()}`;
          return (
            <div className="term-find" style={{ right, top, maxWidth }} onMouseDown={(e) => e.stopPropagation()}>
              <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input
                ref={findInputRef}
                value={find.text}
                placeholder="Find text"
                spellCheck={false}
                onChange={(e) => {
                  const text = e.target.value;
                  lastFindRef.current = text;
                  const next = { id: find.id, text };
                  findRef.current = next;
                  setFind(next);
                  runFind('up', text, true);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') closeFind();
                  else if (e.key === 'Enter') runFind(e.shiftKey ? 'down' : 'up', find.text);
                  else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    runFind('up', find.text);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    runFind('down', find.text);
                  }
                }}
              />
              <span className={`term-find-status ${status === 'No results' ? 'none' : ''}`}>{status}</span>
              <button title="Find up: the match above (Up arrow, Enter)" disabled={!find.text} onClick={() => runFind('up', find.text)}>
                <ChevronUp size={14} />
              </button>
              <button title="Find down: the match below (Down arrow, Shift+Enter)" disabled={!find.text} onClick={() => runFind('down', find.text)}>
                <ChevronDown size={14} />
              </button>
              <button title="Close (Esc)" onClick={() => closeFind()}>
                <X size={13} />
              </button>
            </div>
          );
        })()}
        {exportNote && (
          <div className="term-export-note" onClick={() => setExportNote(null)} title={exportNote}>
            {exportNote}
          </div>
        )}
        {/* keeps the pointer from selecting terminal text while the separator is dragged */}
        {draggingSplit && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 2000, cursor: draggingSplit.vertical ? 'col-resize' : 'row-resize' }} />
        )}
      </div>

      {tabCtx && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setTabCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabCtx(null);
            }}
          />
          <div className="context-menu" ref={tabCtxPos.ref} style={tabCtxPos.style}>
            <div
              className="context-menu-item"
              onClick={() => {
                const id = tabCtx.id;
                setTabCtx(null);
                onCloseTab(id);
              }}
            >
              <X size={13} style={{ color: '#ef4444' }} />
              <span>Close Tab</span>
            </div>
            {(() => {
              const head = tabs.find((x) => x.id === tabCtx.id);
              if (!head?.cell) {
                return (['lr', 'tb'] as const).map((dir) => (
                  <div
                    key={dir}
                    className="context-menu-item"
                    onClick={() => {
                      const id = tabCtx.id;
                      setTabCtx(null);
                      onSplitTab(id, dir);
                    }}
                  >
                    {dir === 'lr' ? (
                      <Columns2 size={13} style={{ color: '#06b6d4' }} />
                    ) : (
                      <Rows2 size={13} style={{ color: '#06b6d4' }} />
                    )}
                    <span>Split Screen {DIR_LABEL[dir]}</span>
                  </div>
                ));
              }
              // already split (further splits are on the screens' own header bars): close one of its screens
              return tabs
                .filter((x) => x.id === head.id || x.splitOf === head.id)
                .map((p) => (
                  <div
                    key={p.id}
                    className="context-menu-item"
                    onClick={() => {
                      setTabCtx(null);
                      onClosePane(p.id);
                    }}
                  >
                    <X size={13} style={{ color: '#ef4444' }} />
                    <span>Close {sideOf(p)} Screen</span>
                  </div>
                ));
            })()}
            <div className="context-menu-divider" />
            {(() => {
              // A split tab has several screens: these are on the header bar above each screen instead
              const split = !!tabs.find((x) => x.id === tabCtx.id)?.cell;
              const tip = split ? 'This tab is split: right-click the header bar above a screen' : undefined;
              return (
                <>
                  <div
                    className={`context-menu-item ${split ? 'disabled' : ''}`}
                    title={tip}
                    onClick={() => {
                      if (split) return;
                      const id = tabCtx.id;
                      setTabCtx(null);
                      openFind(id);
                    }}
                  >
                    <Search size={13} style={{ color: '#f59e0b' }} />
                    <span>Find Text</span>
                  </div>
                  <div
                    className={`context-menu-item ${split ? 'disabled' : ''}`}
                    title={tip}
                    onClick={() => {
                      if (split) return;
                      const id = tabCtx.id;
                      setTabCtx(null);
                      exportScreen(id);
                    }}
                  >
                    <FileDown size={13} style={{ color: '#22c55e' }} />
                    <span>Export Screen</span>
                  </div>
                </>
              );
            })()}
            <div className="context-menu-divider" />
            <div
              className="context-menu-item"
              onClick={() => {
                const t = tabs.find((x) => x.id === tabCtx.id);
                setTabCtx(null);
                if (t) setRenaming({ id: t.id, draft: t.name });
              }}
            >
              <Pencil size={13} style={{ color: '#3b82f6' }} />
              <span>Rename Tab</span>
            </div>
            <div className="context-menu-item" onClick={() => setColorOpen((o) => !o)}>
              <Palette size={13} style={{ color: '#a855f7' }} />
              <span>Change Tab Color</span>
            </div>
            {colorOpen && (
              <div className="tab-color-grid">
                {TAB_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`tab-color-swatch ${tabs.find((x) => x.id === tabCtx.id)?.color === c ? 'current' : ''}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => {
                      onRecolorTab(tabCtx.id, c);
                      setTabCtx(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {paneCtx && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setPaneCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPaneCtx(null);
            }}
          />
          <div className="context-menu" ref={paneCtxPos.ref} style={paneCtxPos.style}>
            <div
              className="context-menu-item"
              onClick={() => {
                const id = paneCtx.id;
                setPaneCtx(null);
                openFind(id);
              }}
            >
              <Search size={13} style={{ color: '#f59e0b' }} />
              <span>Find Text</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                const { id, side } = paneCtx;
                setPaneCtx(null);
                exportScreen(id, side);
              }}
            >
              <FileDown size={13} style={{ color: '#22c55e' }} />
              <span>Export Screen</span>
            </div>
            <div className="context-menu-divider" />
            {(() => {
              // a half that is not split yet can be split once more, the other way than the tab's first split
              const p = tabs.find((x) => x.id === paneCtx.id);
              const head = p?.splitOf ? tabs.find((x) => x.id === p.splitOf) : p;
              if (!p || !head || !canSplitCell(p.cell)) return null;
              const dir = crossDir(head.splitDir ?? 'lr');
              return (
                <div
                  className="context-menu-item"
                  onClick={() => {
                    const id = paneCtx.id;
                    setPaneCtx(null);
                    onSplitPane(id);
                  }}
                >
                  {dir === 'lr' ? (
                    <Columns2 size={13} style={{ color: '#06b6d4' }} />
                  ) : (
                    <Rows2 size={13} style={{ color: '#06b6d4' }} />
                  )}
                  <span>Split Screen {DIR_LABEL[dir]}</span>
                </div>
              );
            })()}
            <div
              className="context-menu-item"
              onClick={() => {
                const id = paneCtx.id;
                setPaneCtx(null);
                onClosePane(id);
              }}
            >
              <X size={13} style={{ color: '#ef4444' }} />
              <span>Close {paneCtx.side} Screen</span>
            </div>
          </div>
        </>
      )}

      {headerCtx && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setHeaderCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setHeaderCtx(null);
            }}
          />
          <div className="context-menu" ref={headerCtxPos.ref} style={headerCtxPos.style}>
            <div
              className="context-menu-item"
              onClick={() => {
                setHeaderCtx(null);
                onNewTab();
              }}
            >
              <Plus size={13} style={{ color: '#22c55e' }} />
              <span>New Tab</span>
            </div>
            <div
              className={`context-menu-item ${heads.length > 1 ? '' : 'disabled'}`}
              onClick={() => {
                setHeaderCtx(null);
                if (heads.length > 1) onCloseAllTabs();
              }}
            >
              <X size={13} style={{ color: '#ef4444' }} />
              <span>Close All Tabs</span>
            </div>
          </div>
        </>
      )}

      {termMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setTermMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTermMenu(null);
            }}
          />
          <div className="context-menu" ref={termMenuPos.ref} style={termMenuPos.style}>
            {([
              ['Cut', Scissors, true],
              ['Copy', Copy, false],
            ] as const).map(([label, Icon, clear]) => (
              <div
                key={label}
                className="context-menu-item"
                style={termMenu.hasSel ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
                onClick={() => {
                  const term = menuTerm();
                  if (term) copySelection(term, clear);
                  setTermMenu(null);
                  term?.focus();
                }}
              >
                <Icon size={13} style={{ color: clear ? '#ef4444' : '#3b82f6' }} />
                <span>{label}</span>
              </div>
            ))}
            <div className="context-menu-item" onClick={pasteFromClipboard}>
              <ClipboardPaste size={13} style={{ color: '#8b5cf6' }} />
              <span>Paste</span>
            </div>
            <div className="context-menu-divider" />
            {([
              ['Explain with AI', Sparkles, true],
              ['Ask AI about this...', MessageSquare, false],
            ] as const).map(([label, Icon, send]) => (
              <div
                key={label}
                className="context-menu-item"
                style={termMenu.hasSel ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
                title={termMenu.hasSel ? undefined : 'Select some text first (an error, a command and its output)'}
                onClick={() => {
                  const text = menuTerm()?.getSelection() ?? '';
                  setTermMenu(null);
                  if (text.trim()) onAskAi(text, send);
                }}
              >
                <Icon size={13} style={{ color: '#a855f7' }} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
