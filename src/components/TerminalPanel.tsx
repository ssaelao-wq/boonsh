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
  ChevronRight,
  Scissors,
  Copy,
  ClipboardPaste,
} from 'lucide-react';
import { useMenuPosition } from '../useMenuPosition';
import { CommandGroup, CommandItem, GroupIcon } from '../commands';
import { PathVars, PathVarName, displayPath } from '../pathVars';
import { GlobalVarDef } from '../globalVars';

interface TerminalPanelProps {
  currentPath: string;
  theme: 'dark' | 'light';
  onShellCwdChange: (path: string) => void;
  commandGroups: CommandGroup[];
  onOpenSettings: () => void;
  onPickCommand: (template: string) => Promise<void>;
  onUserInput: () => void;
  globalVars: GlobalVarDef[];
  pathVars: PathVars;
  onClearPathVar: (name: PathVarName) => void;
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
  onShellCwdChange,
  commandGroups,
  onOpenSettings,
  onPickCommand,
  onUserInput,
  globalVars,
  pathVars,
  onClearPathVar,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Latest callback for the mount-once OSC handler below
  const onShellCwdChangeRef = useRef(onShellCwdChange);
  onShellCwdChangeRef.current = onShellCwdChange;
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
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

  const [showHelperMenu, setShowHelperMenu] = useState<boolean>(false);
  const [showVarsMenu, setShowVarsMenu] = useState<boolean>(false);
  const [activeCategory, setActiveCategory] = useState<string>('Basic Commands');
  const [usageBanner, setUsageBanner] = useState<{ command: string; usage: string } | null>(null);

  // Only variables that have a value are listed; with none set the Global Var button is hidden
  const setVarNames = globalVars.map((v) => v.name).filter((n) => (pathVars[n] ?? []).length > 0);

  useEffect(() => {
    if (setVarNames.length === 0) setShowVarsMenu(false);
  }, [setVarNames.length]);

  const activeCatObj = commandGroups.find((c) => c.category === activeCategory) || commandGroups[0];

  useEffect(() => {
    invoke<boolean>('is_admin')
      .then((res) => setIsAdmin(res))
      .catch(() => {});

    invoke<string>('get_username')
      .then((name) => setUsername(name))
      .catch(() => {});
  }, []);

  // Initialize xterm.js PTY connection
  useEffect(() => {
    if (!terminalRef.current) return;

    const isLight = theme === 'light';
    const term = new XTerm({
      // Fixed-width app font (--font-mono) at the file panel's 12px; xterm needs a literal font string
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      theme: {
        background: isLight ? '#f4f4f5' : '#000000',
        foreground: isLight ? '#09090b' : '#ffffff',
        cursor: isLight ? '#09090b' : '#ffffff',
        selectionBackground: isLight ? '#d4d4d8' : '#3f3f46',
      },
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Shell prompt reports its working directory via OSC 9;9 (see pty.rs) -> sync file panel
    const oscDisposable = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith('9;')) return false;
      const path = data.slice(2).replace(/^"|"$/g, '');
      if (path) onShellCwdChangeRef.current(path);
      return true;
    });

    // Spawn native Windows PTY process (pwsh.exe / powershell.exe)
    invoke<string>('pty_spawn', {
      cols: term.cols,
      rows: term.rows,
      cwd: currentPath || null,
    }).catch((err) => console.error('PTY Spawn Error:', err));

    // Listen for terminal output from Rust backend and auto-scroll to bottom
    const unlistenPromise = listen<{ data: string }>('pty-output', (event) => {
      term.write(event.payload.data);
      term.scrollToBottom();
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
      onUserInputRef.current(); // anything typed here means a pending {SELEC}/{DEST} line is no longer ours to rewrite
      invoke('pty_write', { data }).catch((err) =>
        console.error('PTY Write Error:', err)
      );
    });

    // ResizeObserver to refit terminal canvas whenever container dimensions change
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        xtermRef.current.scrollToBottom();
        invoke('pty_resize', {
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }).catch(() => {});
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        xtermRef.current.scrollToBottom();
        invoke('pty_resize', {
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }).catch(() => {});
      }
    };

    window.addEventListener('resize', handleResize);

    // Multi-stage initial fit sequence to handle window maximization & startup layout stabilization
    const refitInitial = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        xtermRef.current.scrollToBottom();
        invoke('pty_resize', {
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }).catch(() => {});
      }
    };

    const t1 = setTimeout(refitInitial, 50);
    const t2 = setTimeout(refitInitial, 150);
    const t3 = setTimeout(refitInitial, 350);
    const t4 = setTimeout(refitInitial, 750);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      unlistenPromise.then((unlisten) => unlisten());
      oscDisposable.dispose();
      term.dispose();
    };
  }, []);

  // Synchronize terminal fit & scroll whenever usageBanner toggles
  useEffect(() => {
    const refit = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        xtermRef.current.scrollToBottom();
        invoke('pty_resize', {
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }).catch(() => {});
      }
    };
    refit();
    const timer = setTimeout(refit, 50);
    return () => clearTimeout(timer);
  }, [usageBanner]);

  // Update xterm theme dynamically when app theme changes
  useEffect(() => {
    if (xtermRef.current) {
      const isLight = theme === 'light';
      xtermRef.current.options.theme = {
        background: isLight ? '#f4f4f5' : '#000000',
        foreground: isLight ? '#09090b' : '#ffffff',
        cursor: isLight ? '#09090b' : '#ffffff',
        selectionBackground: isLight ? '#d4d4d8' : '#3f3f46',
      };
    }
  }, [theme]);

  // Refit terminal whenever container resizes
  useEffect(() => {
    setTimeout(() => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        xtermRef.current.scrollToBottom();
        invoke('pty_resize', {
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }).catch(() => {});
      }
    }, 50);
  }, [currentPath]);

  // Handle Drag & Drop of file paths into terminal
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const textData = e.dataTransfer.getData('text/plain');
    if (textData) {
      invoke('pty_write', { data: textData }).then(() => {
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

  return (
    <div
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
      {/* Terminal Top Bar with Admin Status & Command Helper */}
      <div
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
          <span>
            {isAdmin ? 'PowerShell (Administrator)' : 'Interactive Terminal'}
          </span>

          {/* Beginner Command Helper Button */}
          <button
            onClick={() => {
              setShowHelperMenu(!showHelperMenu);
              setShowVarsMenu(false);
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
            <BookOpen size={12} style={{ color: 'var(--accent)' }} />
            <span>Commands 💡</span>
          </button>

          {/* Global variables ({SELEC}, {DEST}, ...): values shown in full in a dropdown */}
          {setVarNames.length > 0 && (
          <button
            onClick={() => {
              setShowVarsMenu(!showVarsMenu);
              setShowHelperMenu(false);
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
            <Variable size={12} style={{ color: 'var(--accent)' }} />
            <span>Global Var</span>
          </button>
          )}
        </div>

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
                      <div className="terminal-cmd-name">{item.name}</div>
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
            onClick={() => {
              invoke('relaunch_as_normal', { currentPath })
                .catch((err) => alert(`Failed to switch to Normal User: ${err}`));
            }}
            title="Running as Administrator. Click to switch back to Normal User mode"
            style={{ padding: '2px 8px', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center', borderColor: 'var(--border-light)' }}
          >
            <ShieldCheck size={14} style={{ color: '#22c55e' }} />
            <span style={{ color: '#22c55e' }}>{username} (Admin)</span>
          </button>
        ) : (
          <button
            onClick={() => {
              invoke('relaunch_as_admin', { currentPath })
                .catch((err) => alert(`Failed to elevate to Administrator: ${err}`));
            }}
            title="Normal User Mode. Click to elevate to Administrator"
            style={{ padding: '2px 8px', fontSize: 11, display: 'flex', gap: 5, alignItems: 'center' }}
          >
            <ShieldAlert size={14} style={{ color: '#ef4444' }} />
            <span>{username}</span>
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
      <div
        className="terminal-container"
        ref={terminalRef}
        style={{ background: theme === 'light' ? '#f4f4f5' : '#000000' }}
        onContextMenu={(e) => {
          e.preventDefault();
          setTermMenu({ x: e.clientX, y: e.clientY, hasSel: !!xtermRef.current?.hasSelection() });
        }}
      />

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
          </div>
        </>
      )}
    </div>
  );
};
