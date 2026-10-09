import React, { useState, useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
  ChevronRight,
  Scissors,
  Copy,
  ClipboardPaste,
  Plus,
  Pencil,
  Palette,
  Sparkles,
  MessageSquare,
} from 'lucide-react';
import { useMenuPosition } from '../useMenuPosition';
import { CommandGroup, CommandItem, GroupIcon } from '../commands';
import { PathVars, PathVarName, displayPath } from '../pathVars';
import { GlobalVarDef } from '../globalVars';
import { ConstVar } from '../constVars';
import { hotkeyFromEvent } from '../hotkey';
import { TermTab } from '../types';
import { TAB_COLORS } from '../tabColors';

interface TerminalPanelProps {
  currentPath: string;
  theme: 'dark' | 'light';
  visible: boolean;
  tabs: TermTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
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
  hotkeysOn: boolean; // false while a dialog (Settings) is open
  onUserInput: () => void;
  globalVars: GlobalVarDef[];
  constVars: ConstVar[];
  pathVars: PathVars;
  onClearPathVar: (name: PathVarName) => void;
  onAskAi: (text: string, send: boolean) => void; // selected text to the AI Assistant (send = explain it now)
}

/** One tab's terminal: its xterm, the element it lives in, and its prompt (OSC) handler. */
interface Session {
  term: XTerm;
  fit: FitAddon;
  el: HTMLDivElement;
  osc: { dispose: () => void };
}

const xtermTheme = (t: 'dark' | 'light') => {
  const isLight = t === 'light';
  return {
    background: isLight ? '#f4f4f5' : '#000000',
    foreground: isLight ? '#09090b' : '#ffffff',
    cursor: isLight ? '#09090b' : '#ffffff',
    selectionBackground: isLight ? '#d4d4d8' : '#3f3f46',
  };
};

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
  hotkeysOn,
  onUserInput,
  globalVars,
  constVars,
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

  const [termMenu, setTermMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);
  const termMenuPos = useMenuPosition(termMenu);

  const pasteFromClipboard = () => {
    setTermMenu(null);
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text && xtermRef.current) xtermRef.current.paste(text);
      })
      .catch(() => {})
      .finally(() => xtermRef.current?.focus());
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
      const list = tabsRef.current;
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

  // The Admin / normal user button shows the login of the active tab
  const isAdmin = tabs.find((t) => t.id === activeTabId)?.level === 'admin';

  const [showHelperMenu, setShowHelperMenu] = useState<boolean>(false);
  const [showVarsMenu, setShowVarsMenu] = useState<boolean>(false);
  const [showConstMenu, setShowConstMenu] = useState<boolean>(false);
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

  // Fit the active terminal to its box and tell its PTY
  const refit = () => {
    const id = activeIdRef.current;
    const s = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !s) return;
    s.fit.fit();
    s.term.scrollToBottom();
    invoke('pty_resize', { id, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
  };

  const createSession = (tab: TermTab) => {
    const host = terminalRef.current;
    if (!host) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;';
    el.style.display = tab.id === activeIdRef.current ? 'block' : 'none';
    host.appendChild(el);

    const term = new XTerm({
      // Fixed-width app font (--font-mono) at the file panel's 12px; xterm needs a literal font string
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      theme: xtermTheme(themeRef.current),
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    // Shell prompt reports its working directory via OSC 9;9 (see pty.rs) -> sync file panel
    const osc = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith('9;')) return false;
      onPromptStateRef.current(tab.id, true); // the prompt function ran: the shell is idle again
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
      if (data.includes('\r')) onPromptStateRef.current(tab.id, false); // Enter: a command or program is running until the next prompt
      onUserInputRef.current(); // anything typed here means a pending {SELEC}/{DEST} line is no longer ours to rewrite
      invoke('pty_write', { id: tab.id, data }).catch((err) => console.error('PTY Write Error:', err));
    });

    sessionsRef.current.set(tab.id, { term, fit, el, osc });

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
      s.term.write(event.payload.data);
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
      s.osc.dispose();
      s.term.dispose();
      s.el.remove();
      map.delete(id);
      invoke('pty_close', { id }).catch(() => {});
    }
  }, [tabIds]);

  // Show the active tab's terminal (also when the panel is shown again), refit it and give it the cursor
  useEffect(() => {
    const map = sessionsRef.current;
    map.forEach((s, id) => {
      s.el.style.display = id === activeTabId ? 'block' : 'none';
    });
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

  // Synchronize terminal fit & scroll whenever usageBanner toggles
  useEffect(() => {
    refit();
    const timer = setTimeout(refit, 50);
    return () => clearTimeout(timer);
  }, [usageBanner]);

  // Update xterm theme dynamically when app theme changes
  useEffect(() => {
    sessionsRef.current.forEach((s) => {
      s.term.options.theme = xtermTheme(theme);
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
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              tabElsRef.current[t.id] = el;
            }}
            className={`terminal-tab ${t.id === activeTabId ? 'active' : ''}`}
            style={{ '--tab-color': t.color } as React.CSSProperties}
            onMouseDown={(e) => startTabDrag(e, t.id)}
            onClick={() => {
              if (!justDraggedRef.current) onSelectTab(t.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setColorOpen(false);
              setTabCtx({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            title={t.name}
          >
            {t.level === 'admin' ? (
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
            {tabs.length > 1 && (
              <button
                className="terminal-tab-close"
                title="Close tab"
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

          {/* Global variables ({SELEC}, {DEST}, ...): values shown in full in a dropdown */}
          {setVarNames.length > 0 && (
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

        {showVarsMenu && setVarNames.length > 0 && (
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
              <div className="terminal-vars-hint">
                Set them with right-click in the file panel. Use them in your Commands as {'{NAME}'}.
              </div>
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
        className="terminal-container"
        ref={terminalRef}
        style={{
          background: theme === 'light' ? '#f4f4f5' : '#000000',
          ...(tabs.length === 0 ? { display: 'none' } : {}),
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setTermMenu({ x: e.clientX, y: e.clientY, hasSel: !!xtermRef.current?.hasSelection() });
        }}
      />

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
              className={`context-menu-item ${tabs.length > 1 ? '' : 'disabled'}`}
              onClick={() => {
                setHeaderCtx(null);
                if (tabs.length > 1) onCloseAllTabs();
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
                  if (xtermRef.current) copySelection(xtermRef.current, clear);
                  setTermMenu(null);
                  xtermRef.current?.focus();
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
                  const text = xtermRef.current?.getSelection() ?? '';
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
