import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, KeyRound, Eraser, X, Send, Square, Check, AlertTriangle, Search, Copy, MessageSquare, Files, Plus, Terminal, Trash2, Pin, History } from 'lucide-react';
import { useMenuPosition } from '../useMenuPosition';
import { MAX_TOOL_ROUNDS, AssistantHost, EXPLAIN_TERMINAL, executeTool, stateSummary, terminalBlock } from '../assistant';
import {
  AiError,
  AiSettings,
  ChatSession,
  KEY_PAGE,
  PROVIDER_LABEL,
  ProviderId,
  ToolOutput,
  Usage,
  NO_USAGE,
  addUsage,
  createSession,
  detectProvider,
  listModels,
  parseSaved,
} from '../aiProviders';
import {
  PRICE_PAGE,
  Price,
  builtInPrice,
  costOf,
  formatCost,
  formatTokens,
  loadUserPrices,
  priceFor,
  saveUserPrices,
  totalTokens,
  usageDetail,
} from '../aiCost';

interface AssistantPanelProps {
  getHost: () => AssistantHost; // the app's state and actions as of the latest render
  onClose: () => void;
  // "Ask AI" from the command line panel: the selected text, sent at once (explain) or attached for a question
  askRequest: { id: number; text: string; send: boolean } | null;
}

// What the panel shows: the user's words, the assistant's words, one line per action it took, and problems.
type EntryBody =
  | { kind: 'user'; text: string; terminal?: string } // terminal = command line text sent with it
  | { kind: 'assistant'; text: string }
  | { kind: 'action'; text: string; ok: boolean }
  | { kind: 'error'; text: string };
// usage / model: on the last line of a request, the tokens the whole request used and the model that answered
type Entry = EntryBody & { id: number; time: number; usage?: Usage; model?: string };

// Saved conversations (opt-in, ai_chats.rs). The file holds the shown lines and the tokens per model.
const KEEP_KEY = 'boonsh_ai_keep';
interface SavedChat {
  version: 1;
  id: string;
  title: string;
  created: number;
  updated: number;
  count: number;
  tokens: number;
  cost: number | null; // null: some tokens have no known price
  usage: Record<string, Usage>; // per model
  entries: Entry[];
}
interface ChatMeta {
  id: string;
  title: string;
  updated: number;
  count: number;
  cost: number | null;
  tokens: number;
}
const newChatId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const chatTitle = (entries: Entry[]) => {
  const first = entries.find((e) => e.kind === 'user')?.text ?? 'Conversation';
  const t = first.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 69) + '…' : t;
};
// Earlier lines given to a new session (after a restart, an opened chat or a model change), newest kept
const EARLIER_MAX_CHARS = 8000;
function earlierBlock(entries: Entry[]): string {
  const lines = entries
    .filter((e) => e.kind !== 'error')
    .map((e) =>
      e.kind === 'user'
        ? `User: ${e.text}${e.terminal ? ' [with command line text]' : ''}`
        : e.kind === 'assistant'
          ? `Assistant: ${e.text}`
          : `Action ${e.ok ? 'done' : 'failed'}: ${e.text}`
    );
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size + lines[i].length < EARLIER_MAX_CHARS; i--) {
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return kept.length ? `<earlier_conversation>\n${kept.join('\n')}\n</earlier_conversation>\n\n` : '';
}
/** Total cost of per-model usage, null when a model has no price; tokens in all. */
function totals(usage: Record<string, Usage>, prices: Record<string, Price>) {
  let cost: number | null = 0;
  let tokens = 0;
  let all = NO_USAGE;
  for (const [model, u] of Object.entries(usage)) {
    tokens += totalTokens(u);
    all = addUsage(all, u);
    const pr = priceFor(model, prices);
    if (!pr) cost = null;
    else if (cost !== null) cost += costOf(u, pr.price);
  }
  return { cost, tokens, all };
}

// How far back the panel keeps its output (the oldest lines go first). The conversation the model sees is not cut.
const MAX_ENTRIES = 500;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 2026-10-09 14:05:33, local time (the same date style as the file panel) */
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fullText = (e: Entry) => (e.kind === 'user' && e.terminal ? `${e.terminal}\n\n${e.text}` : e.text);
const entryLine = (e: Entry) =>
  `[${stamp(e.time)}] ${e.kind === 'user' ? 'You' : e.kind === 'assistant' ? 'Assistant' : e.kind === 'action' ? (e.ok ? 'Done' : 'Failed') : 'Note'}: ${fullText(e)}`;

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

// Quick prompts: one-click requests above the input box. The user adds (+ or right-click a message) and removes them.
const PROMPTS_KEY = 'boonsh_ai_prompts';
const PROMPTS_MAX = 20;
const DEFAULT_PROMPTS = [
  'Sort by date modified, newest first',
  'Sort by size, largest first',
  'Group by type',
  'Show only the PDF files here',
  'Write a command that lists the 10 biggest files here',
];
// What the user sent before, for Up / Down in the input box (newest last)
const HISTORY_KEY = 'boonsh_ai_input_history';
const HISTORY_MAX = 50;

function loadList(key: string, fallback: string[]): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* broken or blocked storage: use the fallback */
  }
  return fallback;
}
function saveList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage blocked: the list still works until boonsh closes */
  }
}

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

export const AssistantPanel: React.FC<AssistantPanelProps> = ({ getHost, onClose, askRequest }) => {
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
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Tokens of this conversation per model (not cut with the shown lines)
  const [convUsage, setConvUsage] = useState<Record<string, Usage>>({});
  const [userPrices, setUserPrices] = useState<Record<string, Price>>(() => loadUserPrices());

  // Saved conversations
  const [keep, setKeep] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEEP_KEY) === '1';
    } catch {
      return false;
    }
  });
  const chatIdRef = useRef<string | null>(null);
  const chatCreatedRef = useRef(0);
  const openedEntriesRef = useRef<Entry[] | null>(null); // the lines as loaded from disk (no need to save them again on open)
  const [showChats, setShowChats] = useState(false);
  const showChatsRef = useRef(showChats);
  showChatsRef.current = showChats;
  const [chatList, setChatList] = useState<ChatMeta[]>([]);
  const [chatId, setChatId] = useState<string | null>(null); // the open one, for the list's highlight
  const refreshChatList = () =>
    invoke<ChatMeta[]>('ai_chats_list')
      .then(setChatList)
      .catch(() => setChatList([]));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // The conversation, in the chosen service's own format. A new key or model starts a new one.
  const sessionRef = useRef<ChatSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attached, setAttached] = useState<string | null>(null); // command line text waiting to go with the next message

  // Quick prompts
  const [prompts, setPrompts] = useState<string[]>(() => loadList(PROMPTS_KEY, DEFAULT_PROMPTS));
  const updatePrompts = (next: string[]) => {
    setPrompts(next);
    saveList(PROMPTS_KEY, next);
  };
  const addPrompt = (text: string) => {
    const t = text.trim().replace(/\s+/g, ' ');
    if (!t) return;
    if (prompts.some((p) => p.toLowerCase() === t.toLowerCase())) return;
    if (prompts.length >= PROMPTS_MAX) return alert(`You can keep up to ${PROMPTS_MAX} quick prompts. Remove one first (right-click it).`);
    updatePrompts([...prompts, t]);
  };
  const [promptMenu, setPromptMenu] = useState<{ x: number; y: number; prompt: string } | null>(null);
  const promptMenuPos = useMenuPosition(promptMenu);

  // Up / Down history of what was sent (kept between runs)
  const historyRef = useRef<string[]>(loadList(HISTORY_KEY, []));
  const histPosRef = useRef<number | null>(null); // index being shown, null = not browsing
  const draftRef = useRef(''); // what was in the box before browsing started
  const remember = (text: string) => {
    const h = historyRef.current.filter((x) => x !== text);
    h.push(text);
    historyRef.current = h.slice(-HISTORY_MAX);
    saveList(HISTORY_KEY, historyRef.current);
    histPosRef.current = null;
  };
  const showHistory = (pos: number | null) => {
    histPosRef.current = pos;
    const text = pos === null ? draftRef.current : historyRef.current[pos];
    setInput(text);
    // caret at the end, like a shell
    setTimeout(() => inputRef.current?.setSelectionRange(text.length, text.length), 0);
  };
  // Up on the first line goes back, Down on the last line goes forward (past the newest: the draft again)
  const onHistoryKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const h = historyRef.current;
    if (e.shiftKey || e.ctrlKey || e.altKey || ta.selectionStart !== ta.selectionEnd) return false;
    if (e.key === 'ArrowUp') {
      if (ta.value.slice(0, ta.selectionStart).includes('\n') || h.length === 0) return false;
      const pos = histPosRef.current;
      if (pos === 0) return true;
      if (pos === null) draftRef.current = ta.value;
      showHistory(pos === null ? h.length - 1 : pos - 1);
      return true;
    }
    if (e.key === 'ArrowDown') {
      if (ta.value.slice(ta.selectionEnd).includes('\n') || histPosRef.current === null) return false;
      const pos = histPosRef.current + 1;
      showHistory(pos >= h.length ? null : pos);
      return true;
    }
    return false;
  };

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
  const shown = q ? entries.filter((e) => fullText(e).toLowerCase().includes(q.toLowerCase()) || stamp(e.time).includes(q)) : entries;

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

  const resetChat = () => {
    sessionRef.current = null;
    chatIdRef.current = null;
    setChatId(null);
    setEntries([]);
    setConvUsage({});
  };
  const clearChat = () => {
    if (busy) return;
    const ask = keep
      ? 'Start a new conversation? This one stays in the list of saved conversations.'
      : 'Start a new conversation? The messages shown here are cleared.';
    if (entries.length > 0 && !confirm(ask)) return;
    resetChat();
  };

  // Saving: after every change of the open conversation, while Keep is on (a short wait groups quick changes)
  useEffect(() => {
    if (!keep || !chatIdRef.current || entries.length === 0 || entries === openedEntriesRef.current) return; // just opened: unchanged
    const t = setTimeout(() => {
      const id = chatIdRef.current;
      if (!id) return;
      const tot = totals(convUsage, userPrices);
      const chat: SavedChat = {
        version: 1,
        id,
        title: chatTitle(entries),
        created: chatCreatedRef.current || Date.now(),
        updated: Date.now(),
        count: entries.filter((e) => e.kind === 'user' || e.kind === 'assistant').length,
        tokens: tot.tokens,
        cost: tot.cost,
        usage: convUsage,
        entries,
      };
      invoke('ai_chat_save', { id, json: JSON.stringify(chat) })
        .then(() => {
          if (showChatsRef.current) refreshChatList();
        })
        .catch((err) => console.error('Saving the conversation failed:', err));
    }, 400);
    return () => clearTimeout(t);
  }, [entries, convUsage, keep]);

  const openChat = async (id: string) => {
    if (busy) return;
    try {
      const chat = JSON.parse(await invoke<string>('ai_chat_load', { id })) as SavedChat;
      sessionRef.current = null; // the next request gets these lines as context
      chatIdRef.current = chat.id;
      chatCreatedRef.current = chat.created;
      setChatId(chat.id);
      const list = Array.isArray(chat.entries) ? chat.entries.slice(-MAX_ENTRIES) : [];
      entryIdRef.current = Math.max(entryIdRef.current, ...list.map((e) => e.id || 0));
      openedEntriesRef.current = list;
      setEntries(list);
      setConvUsage(chat.usage ?? {});
      setShowChats(false);
    } catch (err) {
      alert(`Could not open the conversation: ${err}`);
      refreshChatList();
    }
  };
  const deleteChat = async (meta: ChatMeta) => {
    if (!confirm(`Delete the saved conversation "${meta.title}"?`)) return;
    await invoke('ai_chat_delete', { id: meta.id }).catch((err) => alert(err));
    if (meta.id === chatIdRef.current) {
      chatIdRef.current = null; // the open one stays on screen, unsaved, until it changes again (then saved anew)
      setChatId(null);
    }
    refreshChatList();
  };
  const deleteAllChats = async () => {
    if (!confirm(`Delete all ${chatList.length} saved conversations? The one on screen stays open.`)) return;
    await invoke('ai_chats_delete_all').catch((err) => alert(err));
    chatIdRef.current = null;
    setChatId(null);
    refreshChatList();
  };
  const changeKeep = async (on: boolean) => {
    if (!on && chatList.length > 0) {
      if (confirm(`Stop saving conversations. Also delete the ${chatList.length} saved ones?\n\nOK: delete them. Cancel: keep them (you can still open or delete them here).`)) {
        await invoke('ai_chats_delete_all').catch((err) => alert(err));
        refreshChatList();
      }
    }
    setKeep(on);
    try {
      localStorage.setItem(KEEP_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    if (on && entries.length > 0 && !chatIdRef.current) {
      // start saving the conversation on screen
      chatIdRef.current = newChatId();
      chatCreatedRef.current = Date.now();
      setChatId(chatIdRef.current);
      setEntries((prev) => [...prev]); // triggers the save
    }
  };
  // At start: with Keep on, reopen the newest saved conversation
  useEffect(() => {
    if (!keep) return;
    invoke<ChatMeta[]>('ai_chats_list')
      .then((list) => {
        setChatList(list);
        if (list.length > 0 && entriesRef.current.length === 0) openChat(list[0].id);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (showChats) refreshChatList();
  }, [showChats]);

  // Prices (key form): the user's own price for the saved model, or back to the built-in one
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  const savedPrice = settings ? priceFor(settings.model, userPrices) : null;
  useEffect(() => {
    setPriceIn(savedPrice ? String(savedPrice.price.input) : '');
    setPriceOut(savedPrice ? String(savedPrice.price.output) : '');
  }, [settings?.model, showKeyForm, userPrices]);
  const priceValid = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  const savePrice = () => {
    if (!settings || !priceValid(priceIn) || !priceValid(priceOut)) return;
    const next = { ...userPrices, [settings.model]: { input: Number(priceIn), output: Number(priceOut) } };
    setUserPrices(next);
    saveUserPrices(next);
  };
  const resetPrice = () => {
    if (!settings) return;
    const next = { ...userPrices };
    delete next[settings.model];
    setUserPrices(next);
    saveUserPrices(next);
  };
  const conv = totals(convUsage, userPrices);
  // one line's usage text: "1.2k tokens · ~$0.0004"
  const usageText = (u: Usage, model: string) => {
    const pr = priceFor(model, userPrices);
    return `${formatTokens(totalTokens(u))} tokens${pr ? ` · ~${formatCost(costOf(u, pr.price))}` : ''}`;
  };
  const convModel = Object.keys(convUsage).length === 1 ? Object.keys(convUsage)[0] : settings?.model ?? '';

  const stop = () => abortRef.current?.abort();

  // terminalArg: command line text to send with it (else the attached one, if any)
  const send = async (textArg?: string, terminalArg?: string) => {
    const terminal = terminalArg ?? attached ?? undefined;
    const text = (textArg ?? input).trim() || (terminal ? EXPLAIN_TERMINAL : '');
    if (!text || busy) return;
    if (!settings) {
      if (terminal) setAttached(terminal);
      setShowKeyForm(true);
      return;
    }
    if (textArg === undefined && input.trim()) remember(input.trim());
    setInput('');
    setAttached(null);
    histPosRef.current = null;
    // a new session (restart, opened chat, new model) gets the lines shown so far as context
    const earlier = sessionRef.current ? '' : earlierBlock(entriesRef.current);
    if (!chatIdRef.current) {
      chatIdRef.current = newChatId();
      chatCreatedRef.current = Date.now();
      setChatId(chatIdRef.current);
    }
    add({ kind: 'user', text, terminal });
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const session = (sessionRef.current ??= createSession(settings));
    session.begin(`${earlier}${stateSummary(getHost())}\n\n${terminal ? `${terminalBlock(terminal)}\n\n` : ''}${text}`);
    const model = settings.model;
    let turnUsage = NO_USAGE;
    let finished = false;
    try {
      for (let round = 0; ; round++) {
        if (round >= MAX_TOOL_ROUNDS) {
          add({ kind: 'error', text: 'Stopped: the assistant took too many steps for one request. Try a smaller request.' });
          return;
        }
        const res = await session.step(abort.signal);
        turnUsage = addUsage(turnUsage, res.usage);
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
      // what the request used, billed even when it was stopped or failed: on its last line and in the total
      if (totalTokens(turnUsage) > 0) {
        const u = turnUsage;
        setEntries((prev) => (prev.length ? [...prev.slice(0, -1), { ...prev[prev.length - 1], usage: u, model }] : prev));
        setConvUsage((prev) => ({ ...prev, [model]: addUsage(prev[model] ?? NO_USAGE, u) }));
      }
      abortRef.current = null;
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  // "Ask AI" from the command line panel
  useEffect(() => {
    if (!askRequest) return;
    if (askRequest.send && !busy) send(EXPLAIN_TERMINAL, askRequest.text);
    else {
      setAttached(askRequest.text);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [askRequest?.id]);

  const modelLabel = settings ? settings.model : 'no API key';

  return (
    <div className="assistant-panel">
      <div className="assistant-header">
        <Sparkles size={14} style={{ color: '#a855f7' }} />
        <span className="assistant-title">AI Assistant</span>
        <span className="assistant-model" title={settings ? `${PROVIDER_LABEL[settings.provider]}, model ${settings.model}` : ''}>
          {modelLabel}
        </span>
        {conv.tokens > 0 && (
          <span
            className="assistant-usage"
            title={`This conversation\n${usageDetail(conv.all, Object.keys(convUsage).length === 1 ? priceFor(convModel, userPrices) : null)}${
              Object.keys(convUsage).length > 1 ? `\nModels: ${Object.keys(convUsage).join(', ')}` : ''
            }`}
          >
            {formatTokens(conv.tokens)} tokens{conv.cost !== null ? ` · ~${formatCost(conv.cost)}` : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className={showChats ? 'active' : ''}
          onClick={() => setShowChats((v) => !v)}
          title="Saved conversations"
        >
          <History size={13} style={{ color: '#10b981' }} />
        </button>
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
          {settings && (
            <div className="assistant-key-row" title="Used to estimate what the conversation costs (USD per 1 million tokens)">
              <span>Price per 1M tokens, USD: input</span>
              <input className="assistant-price" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} placeholder="?" spellCheck={false} />
              <span>output</span>
              <input className="assistant-price" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} placeholder="?" spellCheck={false} />
              <button onClick={savePrice} disabled={!priceValid(priceIn) || !priceValid(priceOut)}>
                Set price
              </button>
              {userPrices[settings.model] && builtInPrice(settings.model) && <button onClick={resetPrice}>Built-in price</button>}
              {userPrices[settings.model] && !builtInPrice(settings.model) && <button onClick={resetPrice}>Clear price</button>}
              <span className="assistant-price-note">
                {savedPrice ? (savedPrice.own ? '(your price)' : '(built-in, October 2026)') : '(unknown: tokens only)'}{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    invoke('open_in_default_app', { path: PRICE_PAGE[settings.provider] }).catch(() => {});
                  }}
                >
                  price list
                </a>
              </span>
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

      {showChats && (
        <div className="assistant-history">
          <label className="assistant-keep">
            <input type="checkbox" checked={keep} onChange={(e) => changeKeep(e.target.checked)} />
            <span>Keep conversations on this computer</span>
          </label>
          <div className="assistant-hint">
            {keep
              ? 'Each conversation is saved as you go and boonsh reopens the latest one at start. Saved in your user profile as plain text (what you asked, file names, command line text you sent); up to 100 conversations.'
              : 'Off: conversations are gone when boonsh closes. Turn it on to save them and see them here.'}
          </div>
          {chatList.length > 0 && (
            <>
              <div className="assistant-history-list">
                {chatList.map((c) => (
                  <div
                    key={c.id}
                    className={`assistant-history-row ${c.id === chatId ? 'current' : ''}`}
                    onClick={() => openChat(c.id)}
                    title={busy ? 'Wait until the assistant has finished' : 'Open this conversation'}
                  >
                    <div className="assistant-history-title">{c.title}</div>
                    <div className="assistant-history-meta">
                      {stamp(c.updated)} · {c.count} messages · {formatTokens(c.tokens)} tokens
                      {c.cost !== null && c.tokens > 0 ? ` · ~${formatCost(c.cost)}` : ''}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(c);
                      }}
                      title="Delete this saved conversation"
                    >
                      <Trash2 size={12} style={{ color: '#ef4444' }} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="assistant-history-clear" onClick={deleteAllChats}>
                Delete all saved conversations
              </button>
            </>
          )}
          {keep && chatList.length === 0 && <div className="assistant-hint">No saved conversations yet.</div>}
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
            <div>Ask me to do something in boonsh, on the current folder, or click a quick prompt below.</div>
            <div className="assistant-hint">
              Up / Down in the box brings back what you asked before. To ask about an error in the command line, select it there,
              right-click and choose Explain with AI.
            </div>
            <div className="assistant-hint">I only help with boonsh: files, folders, commands and settings. Commands are typed at the prompt, never run.</div>
          </div>
        )}
        {shown.map((e) =>
          e.kind === 'action' ? (
            <div
              key={e.id}
              data-entry={e.id}
              className={`assistant-action ${e.ok ? '' : 'failed'}`}
              title={`${stamp(e.time)}${e.usage && e.model ? `\nThis request: ${usageText(e.usage, e.model)}` : ''}`}
            >
              {e.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
              <span>{highlight(e.text, q)}</span>
            </div>
          ) : (
            <div key={e.id} data-entry={e.id} className={`assistant-entry ${e.kind}`}>
              <div className={`assistant-msg ${e.kind}`}>
                {e.kind === 'user' && e.terminal && <pre className="assistant-terminal">{highlight(e.terminal, q)}</pre>}
                {highlight(e.text, q)}
              </div>
              <div className="assistant-time" title={e.usage && e.model ? `This request (${e.model})\n${usageDetail(e.usage, priceFor(e.model, userPrices))}` : undefined}>
                {stamp(e.time)}
                {e.usage && e.model ? ` · ${usageText(e.usage, e.model)}` : ''}
              </div>
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
                if (menu.entry) copyText(fullText(menu.entry));
                setMenu(null);
              }}
            >
              <MessageSquare size={13} style={{ color: '#a855f7' }} />
              <span>Copy message</span>
            </div>
            {menu.entry?.kind === 'user' && (
              <div
                className="context-menu-item"
                onClick={() => {
                  if (menu.entry) addPrompt(menu.entry.text);
                  setMenu(null);
                }}
              >
                <Pin size={13} style={{ color: '#f59e0b' }} />
                <span>Save as quick prompt</span>
              </div>
            )}
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

      {promptMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setPromptMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPromptMenu(null);
            }}
          />
          <div className="context-menu" ref={promptMenuPos.ref} style={promptMenuPos.style}>
            <div
              className="context-menu-item"
              onClick={() => {
                setInput(promptMenu.prompt);
                setPromptMenu(null);
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
            >
              <MessageSquare size={13} style={{ color: '#a855f7' }} />
              <span>Put in the box (to edit first)</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                updatePrompts(prompts.filter((p) => p !== promptMenu.prompt));
                setPromptMenu(null);
              }}
            >
              <Trash2 size={13} style={{ color: '#ef4444' }} />
              <span>Remove quick prompt</span>
            </div>
          </div>
        </>
      )}

      <div className="assistant-prompts">
        {prompts.map((p) => (
          <button
            key={p}
            className="assistant-prompt"
            onClick={() => send(p)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPromptMenu({ x: e.clientX, y: e.clientY, prompt: p });
            }}
            disabled={busy}
            title={`${p}\n(click to send, right-click to edit first or remove)`}
          >
            {p}
          </button>
        ))}
        <button
          className="assistant-prompt add"
          onClick={() => addPrompt(input)}
          disabled={!input.trim()}
          title={input.trim() ? 'Save the text in the box as a quick prompt' : 'Type a request in the box, then click + to keep it as a quick prompt'}
        >
          <Plus size={12} />
        </button>
      </div>

      {attached && (
        <div className="assistant-attached" title={attached}>
          <Terminal size={12} style={{ color: '#10b981', flexShrink: 0 }} />
          <span>
            Command line text ({attached.split('\n').length} line{attached.includes('\n') ? 's' : ''}) goes with your next message. Enter
            with an empty box asks to explain it.
          </span>
          <button onClick={() => setAttached(null)} title="Don't send the command line text">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="assistant-input-row">
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder={settings ? 'Ask the assistant... (Enter to send, Shift+Enter for a new line)' : 'Enter your API key first (key button above)'}
          onChange={(e) => {
            setInput(e.target.value);
            histPosRef.current = null; // typing ends history browsing
          }}
          onKeyDown={(e) => {
            if (onHistoryKey(e)) {
              e.preventDefault();
              return;
            }
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
          <button onClick={() => send()} disabled={!input.trim() && !attached} title="Send (Enter)" style={{ opacity: input.trim() || attached ? 1 : 0.4 }}>
            <Send size={14} style={{ color: '#a855f7' }} />
          </button>
        )}
      </div>
    </div>
  );
};
