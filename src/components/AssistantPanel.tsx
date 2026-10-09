import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, KeyRound, Eraser, X, Send, Square, Check, AlertTriangle, Search, Copy, MessageSquare, Files } from 'lucide-react';
import { useMenuPosition } from '../useMenuPosition';
import { MAX_TOOL_ROUNDS, AssistantHost, executeTool, stateSummary } from '../assistant';
import {
  AiError,
  AiSettings,
  ChatSession,
  KEY_PAGE,
  PROVIDER_LABEL,
  ProviderId,
  ToolOutput,
  createSession,
  detectProvider,
  listModels,
  parseSaved,
} from '../aiProviders';

interface AssistantPanelProps {
  getHost: () => AssistantHost; // the app's state and actions as of the latest render
  onClose: () => void;
}

// What the panel shows: the user's words, the assistant's words, one line per action it took, and problems.
type EntryBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'action'; text: string; ok: boolean }
  | { kind: 'error'; text: string };
type Entry = EntryBody & { id: number; time: number };

// How far back the panel keeps its output (the oldest lines go first). The conversation the model sees is not cut.
const MAX_ENTRIES = 500;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 2026-10-09 14:05:33, local time (the same date style as the file panel) */
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const entryLine = (e: Entry) =>
  `[${stamp(e.time)}] ${e.kind === 'user' ? 'You' : e.kind === 'assistant' ? 'Assistant' : e.kind === 'action' ? (e.ok ? 'Done' : 'Failed') : 'Note'}: ${e.text}`;

/** The text with every match of `q` (ignoring case) marked. */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  out.push(text.slice(at));
  return out;
}

const EXAMPLES = [
  'Sort by size, largest first',
  'Group by month modified',
  'Show only the PDF files here',
  'Write a command that lists the 10 biggest files here',
];

// Short label for an action line ("set_sort" -> "Sort")
const ACTION_LABEL: Record<string, string> = {
  list_items: 'Looked at the files',
  navigate: 'Open folder',
  select_items: 'Select',
  open_item: 'Open',
  set_sort: 'Sort',
  set_grouping: 'Group',
  set_columns: 'Columns',
  set_view: 'View',
  search: 'Search',
  rename_item: 'Rename',
  bulk_rename: 'Bulk Rename',
  create_item: 'New',
  delete_items: 'Delete',
  clipboard: 'Clipboard',
  zip: 'Zip',
  insert_command: 'Command',
  list_saved_commands: 'Read saved commands',
  set_global_var: 'Global Var',
  quick_access: 'Quick Access',
  frequent_folders: 'Frequently Accessed',
  open_settings: 'Settings',
  undo_bulk_rename: 'Undo',
  read_manual: 'Read the manual',
};
// Tools that only read: their result is for the model, the panel just says they ran
const READ_ONLY = new Set(['list_items', 'list_saved_commands', 'read_manual']);

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError' || (err as Error)?.constructor?.name === 'APIUserAbortError';

export const AssistantPanel: React.FC<AssistantPanelProps> = ({ getHost, onClose }) => {
  const [settings, setSettings] = useState<AiSettings | null>(null); // the saved key, its service and model
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [providerChoice, setProviderChoice] = useState<'auto' | ProviderId>('auto');
  const [models, setModels] = useState<string[]>([]); // the key's usable models, cheapest first (after Check)
  const [modelChoice, setModelChoice] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');

  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // The conversation, in the chosen service's own format. A new key or model starts a new one.
  const sessionRef = useRef<ChatSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    invoke<string | null>('ai_key_get')
      .then((raw) => {
        const s = parseSaved(raw);
        setSettings(s && s.model ? s : null); // a key saved without a model is checked again in the form
        if (s && !s.model) setKeyInput(s.key);
      })
      .catch(() => setSettings(null))
      .finally(() => setKeyLoaded(true));
  }, []);

  useEffect(() => {
    if (keyLoaded && !settings) setShowKeyForm(true);
  }, [keyLoaded, settings]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries, busy]);

  const entryIdRef = useRef(0);
  const add = (e: EntryBody) =>
    setEntries((prev) => [...prev, { ...e, id: ++entryIdRef.current, time: Date.now() } as Entry].slice(-MAX_ENTRIES));

  // Search in the panel's history
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const q = showSearch ? query.trim() : '';
  const shown = q ? entries.filter((e) => e.text.toLowerCase().includes(q.toLowerCase()) || stamp(e.time).includes(q)) : entries;

  // Copying: selected text (Ctrl+C or right-click), one message, or the whole conversation
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null; selection: string } | null>(null);
  const menuPos = useMenuPosition(menu);
  const copyText = (text: string) => navigator.clipboard.writeText(text).catch(() => {});
  const selectedText = () => window.getSelection()?.toString() ?? '';
  const selectAllMessages = () => {
    const el = listRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // The service of the key in the box: the one picked, else guessed from the key's beginning
  const typedKey = keyInput.trim();
  const keyProvider: ProviderId | null = providerChoice !== 'auto' ? providerChoice : detectProvider(typedKey);

  // Check the typed key (lists its models, free of charge) and show the model choice
  const checkKey = async () => {
    if (!typedKey) return setKeyError('Paste your API key first.');
    if (!keyProvider) return setKeyError('Could not tell which service this key is for. Choose the service in the list.');
    setKeyBusy(true);
    setKeyError('');
    try {
      const list = await listModels(keyProvider, typedKey);
      setModels(list);
      setModelChoice(list[0]);
    } catch (err) {
      setModels([]);
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  };

  const saveKey = async () => {
    if (!keyProvider || !modelChoice) return;
    const next: AiSettings = { provider: keyProvider, key: typedKey, model: modelChoice };
    try {
      await invoke('ai_key_set', { key: JSON.stringify(next) });
    } catch (err) {
      return setKeyError(`Could not save the key: ${err}`);
    }
    setSettings(next);
    sessionRef.current = null; // new service or model: a new conversation
    setKeyInput('');
    setModels([]);
    setShowKeyForm(false);
  };

  // Only change the model of the saved key
  const changeModel = async (model: string) => {
    if (!settings) return;
    const next = { ...settings, model };
    await invoke('ai_key_set', { key: JSON.stringify(next) }).catch(() => {});
    setSettings(next);
    sessionRef.current = null;
  };
  const [savedModels, setSavedModels] = useState<string[]>([]);
  useEffect(() => {
    // the model list of the saved key, for the drop-down in the key form
    if (!showKeyForm || !settings) return;
    listModels(settings.provider, settings.key)
      .then(setSavedModels)
      .catch(() => setSavedModels([]));
  }, [showKeyForm, settings?.key]);

  const removeKey = async () => {
    if (!confirm('Remove the saved API key from this computer?')) return;
    await invoke('ai_key_delete').catch(() => {});
    setSettings(null);
    sessionRef.current = null;
    setShowKeyForm(true);
  };

  const clearChat = () => {
    if (busy) return;
    if (entries.length > 0 && !confirm('Start a new conversation? The messages shown here are cleared.')) return;
    sessionRef.current = null;
    setEntries([]);
  };

  const stop = () => abortRef.current?.abort();

  const send = async (textArg?: string) => {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    if (!settings) {
      setShowKeyForm(true);
      return;
    }
    setInput('');
    add({ kind: 'user', text });
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const session = (sessionRef.current ??= createSession(settings));
    session.begin(`${stateSummary(getHost())}\n\n${text}`);
    let finished = false;
    try {
      for (let round = 0; ; round++) {
        if (round >= MAX_TOOL_ROUNDS) {
          add({ kind: 'error', text: 'Stopped: the assistant took too many steps for one request. Try a smaller request.' });
          return;
        }
        const res = await session.step(abort.signal);
        for (const t of res.texts) add({ kind: 'assistant', text: t });
        if (res.stop === 'refusal') {
          add({ kind: 'error', text: 'The model declined this request.' });
          return;
        }
        if (res.stop === 'max_tokens') {
          add({ kind: 'error', text: 'The answer was cut off. Try a shorter request.' });
          return;
        }
        if (res.stop === 'again') continue;
        if (res.stop !== 'tools') break;

        const results: ToolOutput[] = [];
        for (const call of res.calls) {
          let out: string;
          let failed = false;
          try {
            out = await executeTool(call.name, call.input, getHost());
            failed = out.startsWith('Error:');
          } catch (err) {
            out = `Error: ${err instanceof Error ? err.message : String(err)}`;
            failed = true;
          }
          const label = ACTION_LABEL[call.name] ?? call.name;
          add({ kind: 'action', ok: !failed, text: READ_ONLY.has(call.name) && !failed ? label : `${label}: ${out.replace(/^Error:\s*/, '')}` });
          results.push({ call, content: out, isError: failed });
          await tick(80); // let React draw the change so the next tool sees the new state
        }
        session.addResults(results);
        if (abort.signal.aborted) {
          add({ kind: 'error', text: 'Stopped.' });
          return;
        }
      }
      finished = true;
    } catch (err) {
      if (abort.signal.aborted || isAbort(err)) add({ kind: 'error', text: 'Stopped.' });
      else add({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      if (err instanceof AiError && err.auth) setShowKeyForm(true);
    } finally {
      // only a finished turn joins the conversation; a stopped or failed one leaves it as it was
      if (finished) session.commit();
      else session.rollback();
      abortRef.current = null;
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const modelLabel = settings ? settings.model : 'no API key';

  return (
    <div className="assistant-panel">
      <div className="assistant-header">
        <Sparkles size={14} style={{ color: '#a855f7' }} />
        <span className="assistant-title">AI Assistant</span>
        <span className="assistant-model" title={settings ? `${PROVIDER_LABEL[settings.provider]}, model ${settings.model}` : ''}>
          {modelLabel}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={showKeyForm ? 'active' : ''}
          onClick={() => setShowKeyForm((v) => !v)}
          title={settings ? `AI API key: ${PROVIDER_LABEL[settings.provider]}. Click to change the key or the model.` : 'Enter your AI API key'}
        >
          <KeyRound size={13} style={{ color: settings ? '#f59e0b' : '#ef4444' }} />
        </button>
        <button
          className={showSearch ? 'active' : ''}
          onClick={() => {
            if (showSearch) setQuery('');
            setShowSearch(!showSearch);
          }}
          title="Search the conversation"
        >
          <Search size={13} style={{ color: '#3b82f6' }} />
        </button>
        <button onClick={clearChat} disabled={busy || entries.length === 0} title="Start a new conversation" style={{ opacity: busy || entries.length === 0 ? 0.4 : 1 }}>
          <Eraser size={13} style={{ color: '#06b6d4' }} />
        </button>
        <button onClick={onClose} title="Hide the AI Assistant panel">
          <X size={13} />
        </button>
      </div>

      {showKeyForm && (
        <div className="assistant-key-form">
          <div className="assistant-key-title">AI API key</div>
          <div className="assistant-key-note">
            Use your own key from Anthropic (Claude), OpenAI or Google Gemini. boonsh picks the cheapest chat model of that
            service; you can choose another. The key is kept in Windows Credential Manager for your Windows account only.
            Requests are billed to the key's account.
          </div>
          {settings && (
            <div className="assistant-key-row">
              <span>
                Saved: <b>{PROVIDER_LABEL[settings.provider]}</b>, model
              </span>
              <select value={settings.model} onChange={(e) => changeModel(e.target.value)} disabled={busy}>
                {(savedModels.length ? savedModels : [settings.model]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === savedModels[0] ? ' (cheapest)' : ''}
                  </option>
                ))}
              </select>
              <button onClick={removeKey}>Remove key</button>
            </div>
          )}
          <div className="assistant-key-row">
            <select
              value={providerChoice}
              onChange={(e) => {
                setProviderChoice(e.target.value as 'auto' | ProviderId);
                setModels([]);
              }}
              title="Which service the key is for"
            >
              <option value="auto">Auto-detect{providerChoice === 'auto' && keyProvider ? `: ${PROVIDER_LABEL[keyProvider]}` : ''}</option>
              {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={keyInput}
              placeholder={settings ? 'Paste a new key to replace the saved one' : 'sk-ant-...  /  sk-...  /  AIza...'}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setModels([]);
                setKeyError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (models.length ? saveKey() : checkKey());
              }}
              spellCheck={false}
              autoFocus
            />
            <button className="active" onClick={checkKey} disabled={keyBusy || !typedKey}>
              {keyBusy ? 'Checking...' : 'Check'}
            </button>
          </div>
          {models.length > 0 && keyProvider && (
            <div className="assistant-key-row">
              <span>
                Key OK ({PROVIDER_LABEL[keyProvider]}). Model:
              </span>
              <select value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
                {models.map((m, k) => (
                  <option key={m} value={m}>
                    {m}
                    {k === 0 ? ' (cheapest)' : ''}
                  </option>
                ))}
              </select>
              <button className="active" onClick={saveKey}>
                Save
              </button>
            </div>
          )}
          <div className="assistant-key-links">
            Get a key:{' '}
            {(Object.keys(KEY_PAGE) as ProviderId[]).map((p, k) => (
              <React.Fragment key={p}>
                {k > 0 && ' · '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    invoke('open_in_default_app', { path: KEY_PAGE[p] }).catch(() => {});
                  }}
                >
                  {PROVIDER_LABEL[p]}
                </a>
              </React.Fragment>
            ))}
          </div>
          {keyError && <div className="assistant-key-error">{keyError}</div>}
        </div>
      )}

      {showSearch && (
        <div className="assistant-search">
          <Search size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search the conversation"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowSearch(false);
                setQuery('');
              }
            }}
            spellCheck={false}
            autoFocus
          />
          <span className="assistant-search-count">{q ? `${shown.length} of ${entries.length}` : ''}</span>
          <button
            onClick={() => {
              setShowSearch(false);
              setQuery('');
            }}
            title="Close search (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div
        className="assistant-messages"
        ref={listRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          // Ctrl+A selects the conversation's text (not the whole window); Ctrl+C then copies it as usual
          if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            selectAllMessages();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const id = (e.target as HTMLElement).closest('[data-entry]')?.getAttribute('data-entry');
          setMenu({ x: e.clientX, y: e.clientY, entry: entries.find((x) => String(x.id) === id) ?? null, selection: selectedText() });
        }}
      >
        {q && shown.length === 0 && <div className="assistant-hint">Nothing found for "{q}".</div>}
        {entries.length === 0 && (
          <div className="assistant-empty">
            <div>Ask me to do something in boonsh, on the current folder. For example:</div>
            {EXAMPLES.map((ex) => (
              <button key={ex} className="assistant-example" onClick={() => send(ex)} disabled={busy || !settings}>
                {ex}
              </button>
            ))}
            <div className="assistant-hint">I only help with boonsh: files, folders, commands and settings. Commands are typed at the prompt, never run.</div>
          </div>
        )}
        {shown.map((e) =>
          e.kind === 'action' ? (
            <div key={e.id} data-entry={e.id} className={`assistant-action ${e.ok ? '' : 'failed'}`} title={stamp(e.time)}>
              {e.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
              <span>{highlight(e.text, q)}</span>
            </div>
          ) : (
            <div key={e.id} data-entry={e.id} className={`assistant-entry ${e.kind}`}>
              <div className={`assistant-msg ${e.kind}`}>{highlight(e.text, q)}</div>
              <div className="assistant-time">{stamp(e.time)}</div>
            </div>
          )
        )}
        {busy && <div className="assistant-thinking">Working...</div>}
      </div>

      {menu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="context-menu" ref={menuPos.ref} style={menuPos.style}>
            <div
              className="context-menu-item"
              style={menu.selection ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
              onClick={() => {
                copyText(menu.selection);
                setMenu(null);
              }}
            >
              <Copy size={13} style={{ color: '#3b82f6' }} />
              <span>Copy</span>
            </div>
            <div
              className="context-menu-item"
              style={menu.entry ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
              onClick={() => {
                if (menu.entry) copyText(menu.entry.text);
                setMenu(null);
              }}
            >
              <MessageSquare size={13} style={{ color: '#a855f7' }} />
              <span>Copy message</span>
            </div>
            <div
              className="context-menu-item"
              style={shown.length ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
              onClick={() => {
                copyText(shown.map(entryLine).join('\n'));
                setMenu(null);
              }}
            >
              <Files size={13} style={{ color: '#10b981' }} />
              <span>{q ? 'Copy the messages found' : 'Copy conversation'}</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                selectAllMessages();
                setMenu(null);
              }}
            >
              <span style={{ width: 13 }} />
              <span>Select all (Ctrl+A)</span>
            </div>
          </div>
        </>
      )}

      <div className="assistant-input-row">
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder={settings ? 'Ask the assistant... (Enter to send, Shift+Enter for a new line)' : 'Enter your API key first (key button above)'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={!keyLoaded}
        />
        {busy ? (
          <button onClick={stop} title="Stop">
            <Square size={14} style={{ color: '#ef4444' }} />
          </button>
        ) : (
          <button onClick={() => send()} disabled={!input.trim()} title="Send (Enter)" style={{ opacity: input.trim() ? 1 : 0.4 }}>
            <Send size={14} style={{ color: '#a855f7' }} />
          </button>
        )}
      </div>
    </div>
  );
};
