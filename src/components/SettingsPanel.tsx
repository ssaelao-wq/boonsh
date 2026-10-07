import React, { useState, useEffect } from 'react';
import { X, Plus, Pencil, Trash2, RotateCcw, Settings, BookOpen, Variable, Columns3, ArrowUp, ArrowDown, History, Bookmark, Info, BookText, Lock, FolderPlus, Download, Upload } from 'lucide-react';
import { CommandGroup, CommandItem, GroupIcon, newCommandId, validateGroupName, MAX_GROUP_NAME } from '../commands';
import { ConstVar, newConstId } from '../constVars';
import { validateHotkey, availableKeys, HOTKEY_PREFIX } from '../hotkey';
import { toJson, toCsv, parseImport, mergeImport, importMessage } from '../commandsIo';
import { GlobalVarDef, VarTakes, newVarId, validateVarName, MAX_NAME_LENGTH } from '../globalVars';
import { PathVars } from '../pathVars';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import licenseText from '../../LICENSE?raw';
import { ManualView } from './ManualView';
import { APP_NAME, COPYRIGHT, REPO_URL, COMPONENTS } from '../about';
import { QuickAccessItem } from '../types';
import { QA_MAX, isShown, settingsRows } from '../quickAccess';
import { FrequentSettings, MIN_COUNT, MAX_COUNT, DEFAULT_SETTINGS as DEFAULT_FREQUENT } from '../frequent';
import { COLUMN_BY_ID, ColumnId, ColumnPrefs, DateColumn, DateMode, isDateColumn } from '../columns';

interface SettingsPanelProps {
  groups: CommandGroup[];
  onChange: (groups: CommandGroup[]) => void;
  onReset: () => void;
  onClose: () => void;
  globalVars: GlobalVarDef[];
  pathVars: PathVars;
  onGlobalVarsChange: (defs: GlobalVarDef[]) => void;
  onGlobalVarsReset: () => void;
  constVars: ConstVar[];
  onConstVarsChange: (defs: ConstVar[]) => void;
  initialSection: Section;
  colPrefs: ColumnPrefs;
  onColPrefsChange: (prefs: ColumnPrefs) => void;
  onColPrefsReset: () => void;
  freqSettings: FrequentSettings;
  freqTracked: number;
  onFreqSettingsChange: (s: FrequentSettings) => void;
  onFreqClear: () => void;
  qaShown: QuickAccessItem[];
  qaCandidates: QuickAccessItem[];
  onQaToggle: (item: QuickAccessItem, on: boolean) => void;
  onQaReset: () => void;
}

type Section = 'commands' | 'vars' | 'consts' | 'columns' | 'frequent' | 'quickaccess' | 'manual' | 'about';

interface VarDraft {
  name: string;
  takes: VarTakes;
  description: string;
}

interface ConstDraft {
  name: string;
  value: string;
  description: string;
}

type ConstEditState = { mode: 'add'; draft: ConstDraft } | { mode: 'edit'; id: string; draft: ConstDraft };

type VarEditState = { mode: 'add'; draft: VarDraft } | { mode: 'edit'; id: string; draft: VarDraft };

interface Draft {
  name: string;
  insertText: string;
  description: string;
  usage: string;
  category: string;
  hotkey: string;
}

type EditState = { mode: 'add'; draft: Draft } | { mode: 'edit'; id: string; draft: Draft };

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  groups,
  onChange,
  onReset,
  onClose,
  globalVars,
  pathVars,
  onGlobalVarsChange,
  onGlobalVarsReset,
  constVars,
  onConstVarsChange,
  initialSection,
  colPrefs,
  onColPrefsChange,
  onColPrefsReset,
  freqSettings,
  freqTracked,
  onFreqSettingsChange,
  onFreqClear,
  qaShown,
  qaCandidates,
  onQaToggle,
  onQaReset,
}) => {
  const [qaMessage, setQaMessage] = useState<string>('');
  const [version, setVersion] = useState<string>('');
  const [aboutMessage, setAboutMessage] = useState<string>('');
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  const openLink = (command: string, args?: Record<string, unknown>) => {
    setAboutMessage('');
    invoke(command, args).catch((err) => setAboutMessage(String(err)));
  };
  const [section, setSection] = useState<Section>(initialSection);
  const [varEditing, setVarEditing] = useState<VarEditState | null>(null);
  const [varError, setVarError] = useState<string>('');
  const [constEditing, setConstEditing] = useState<ConstEditState | null>(null);
  const [constError, setConstError] = useState<string>('');
  // Naming a new command group, or renaming a custom one
  const [groupEditing, setGroupEditing] = useState<{ mode: 'add' | 'rename'; draft: string } | null>(null);
  const [groupError, setGroupError] = useState<string>('');
  const [groupNote, setGroupNote] = useState<string>(''); // result of an import / export
  const [activeCategory, setActiveCategory] = useState<string>(groups[0]?.category ?? '');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState<string>('');

  const activeGroup = groups.find((g) => g.category === activeCategory) || groups[0];

  // Escape cancels the open form first, then closes the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (constEditing) {
        setConstEditing(null);
        setConstError('');
      } else if (groupEditing) {
        setGroupEditing(null);
        setGroupError('');
      } else if (varEditing) {
        setVarEditing(null);
        setVarError('');
      } else if (editing) {
        setEditing(null);
        setError('');
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, varEditing, constEditing, groupEditing, onClose]);

  const selectGroup = (category: string) => {
    setActiveCategory(category);
    setEditing(null);
    setError('');
    setGroupEditing(null);
    setGroupError('');
    setGroupNote('');
  };

  const handleGroupSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupEditing) return;
    const name = groupEditing.draft.trim();
    const renaming = groupEditing.mode === 'rename';
    const err = validateGroupName(name, groups, renaming ? activeGroup.category : undefined);
    if (err) {
      setGroupError(err);
      return;
    }
    if (renaming) {
      onChange(groups.map((g) => (g.category === activeGroup.category ? { ...g, category: name } : g)));
    } else {
      onChange([...groups, { category: name, icon: 'folder', custom: true, items: [] }]);
    }
    setActiveCategory(name);
    setGroupEditing(null);
    setGroupError('');
  };

  // Export the selected group's commands to a .json or .csv file (the Save dialog's file type decides)
  const handleExport = async () => {
    setGroupError('');
    setGroupNote('');
    if (activeGroup.items.length === 0) {
      setGroupError('This group has no commands to export.');
      return;
    }
    try {
      const safe = activeGroup.category.replace(/[\\/:*?"<>|]+/g, '_');
      const path = await invoke<string | null>('save_file_dialog', {
        title: `Export the commands of "${activeGroup.category}"`,
        filter: 'JSON file (*.json)|*.json|CSV file for Excel (*.csv)|*.csv',
        defaultName: `${safe} commands`,
      });
      if (!path) return;
      const csv = path.toLowerCase().endsWith('.csv');
      await invoke('write_text_file', { path, content: csv ? toCsv(activeGroup.items) : toJson(activeGroup.category, activeGroup.items) });
      const n = activeGroup.items.length;
      setGroupNote(`Exported ${n} command${n === 1 ? '' : 's'} to ${path}`);
    } catch (err) {
      setGroupError(String(err));
    }
  };

  // Import commands from a .json or .csv file into the selected group (duplicates are skipped)
  const handleImport = async () => {
    setGroupError('');
    setGroupNote('');
    try {
      const path = await invoke<string | null>('pick_file', {
        title: `Import commands into "${activeGroup.category}"`,
        filter: 'Commands (*.json;*.csv)|*.json;*.csv|All files (*.*)|*.*',
      });
      if (!path) return;
      const text = await invoke<string>('read_import_file', { path });
      const incoming = parseImport(text, path);
      const used = new Set(groups.flatMap((g) => g.items).map((i) => i.hotkey).filter((h): h is string => !!h));
      const result = mergeImport(activeGroup.items, incoming, used, newCommandId);
      if (result.added > 0) {
        onChange(groups.map((g) => (g.category === activeGroup.category ? { ...g, items: result.items } : g)));
      }
      setGroupNote(importMessage(result));
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGroupDelete = () => {
    if (!activeGroup.custom) return;
    const n = activeGroup.items.length;
    const what = n
      ? `the group "${activeGroup.category}" and its ${n} command${n === 1 ? '' : 's'}`
      : `the group "${activeGroup.category}"`;
    if (!confirm(`Delete ${what}?`)) return;
    onChange(groups.filter((g) => g.category !== activeGroup.category));
    setActiveCategory(groups[0]?.category ?? '');
    setEditing(null);
  };

  const startAdd = () => {
    setError('');
    setEditing({
      mode: 'add',
      draft: { name: '', insertText: '', description: '', usage: '', category: activeGroup.category, hotkey: '' },
    });
  };

  const startEdit = (item: CommandItem) => {
    setError('');
    setEditing({
      mode: 'edit',
      id: item.id,
      draft: {
        name: item.name,
        insertText: item.insertText,
        description: item.description,
        usage: item.usage,
        category: activeGroup.category,
        hotkey: item.hotkey ?? '',
      },
    });
  };

  const updateDraft = (field: keyof Draft, value: string) => {
    if (!editing) return;
    setEditing({ ...editing, draft: { ...editing.draft, [field]: value } });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const d = editing.draft;
    if (!d.name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!d.insertText.trim()) {
      setError('Terminal text is required.');
      return;
    }

    const hotkeyError = validateHotkey(d.hotkey, groups, editing.mode === 'edit' ? editing.id : undefined);
    if (hotkeyError) {
      setError(hotkeyError);
      return;
    }

    const item: CommandItem = {
      id: editing.mode === 'edit' ? editing.id : newCommandId(),
      name: d.name.trim(),
      // Keep a trailing space so the cursor lands ready for arguments (e.g. "ren ")
      insertText: d.insertText.replace(/^\s+/, ''),
      description: d.description.trim(),
      usage: d.usage.trim(),
      hotkey: d.hotkey || undefined,
    };

    const next = groups.map((g) => {
      const without = g.items.filter((i) => i.id !== item.id);
      if (g.category !== d.category) return { ...g, items: without };
      if (editing.mode === 'edit') {
        const idx = g.items.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          const items = [...g.items];
          items[idx] = item;
          return { ...g, items };
        }
      }
      return { ...g, items: [...without, item] };
    });

    onChange(next);
    setActiveCategory(d.category);
    setEditing(null);
    setError('');
  };

  const handleDelete = (item: CommandItem) => {
    if (!confirm(`Delete the command "${item.name}"?`)) return;
    onChange(
      groups.map((g) =>
        g.category === activeGroup.category ? { ...g, items: g.items.filter((i) => i.id !== item.id) } : g
      )
    );
    if (editing?.mode === 'edit' && editing.id === item.id) setEditing(null);
  };

  // ---- Files Column ----
  const setVisible = (id: ColumnId, on: boolean) => {
    if (id === 'name') return;
    const shown = new Set(colPrefs.visible);
    if (on) shown.add(id);
    else shown.delete(id);
    onColPrefsChange({ ...colPrefs, visible: colPrefs.order.filter((c) => c === 'name' || shown.has(c)) });
  };

  // "Name" stays first, so a column can move between positions 1 and last
  const moveColumn = (id: ColumnId, dir: -1 | 1) => {
    const order = [...colPrefs.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (id === 'name' || j < 1 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    onColPrefsChange({ ...colPrefs, order, visible: order.filter((c) => c === 'name' || colPrefs.visible.includes(c)) });
  };

  const setDate = (col: DateColumn, kind: 'dateShow' | 'dateSort', mode: DateMode) =>
    onColPrefsChange({ ...colPrefs, [kind]: { ...colPrefs[kind], [col]: mode } });

  const handleReset = () => {
    if (section === 'quickaccess') {
      if (!confirm('Reset Quick Access to Home, Desktop, Downloads, Documents and the C: drive? Folders you added are removed.')) return;
      setQaMessage('');
      onQaReset();
      return;
    }
    if (section === 'frequent') {
      if (!confirm('Reset the Frequently Accessed settings (on, 3 folders)? The visit counts are kept.')) return;
      onFreqSettingsChange(DEFAULT_FREQUENT);
      return;
    }
    if (section === 'columns') {
      if (!confirm('Reset the file panel columns and date options to the defaults?')) return;
      onColPrefsReset();
      return;
    }
    if (section === 'consts') return; // CONST variables have no reset: they stay until deleted
    if (section === 'vars') {
      if (!confirm('Reset the global variables to {SELEC} and {DEST}? Your own variables and their values will be lost.')) return;
      setVarEditing(null);
      setVarError('');
      onGlobalVarsReset();
      return;
    }
    if (!confirm('Reset all commands to the defaults? Your added and edited commands, and the groups you made, will be lost.')) return;
    setEditing(null);
    setError('');
    onReset();
  };

  // ---- Global variables ----
  const selectSection = (next: Section) => {
    setSection(next);
    setEditing(null);
    setError('');
    setVarEditing(null);
    setVarError('');
    setConstEditing(null);
    setConstError('');
    setGroupEditing(null);
    setGroupError('');
  };

  const startVarAdd = () => {
    setVarError('');
    setVarEditing({ mode: 'add', draft: { name: '', takes: 'item', description: '' } });
  };

  const startVarEdit = (v: GlobalVarDef) => {
    setVarError('');
    setVarEditing({ mode: 'edit', id: v.id, draft: { name: v.name, takes: v.takes, description: v.description } });
  };

  const updateVarDraft = <K extends keyof VarDraft>(field: K, value: VarDraft[K]) => {
    if (!varEditing) return;
    setVarEditing({ ...varEditing, draft: { ...varEditing.draft, [field]: value } });
  };

  const handleVarSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!varEditing) return;
    const d = varEditing.draft;
    const err = validateVarName(d.name, [...globalVars, ...constVars], varEditing.mode === 'edit' ? varEditing.id : undefined);
    if (err) {
      setVarError(err);
      return;
    }
    const def: GlobalVarDef = {
      id: varEditing.mode === 'edit' ? varEditing.id : newVarId(),
      name: d.name.trim().toUpperCase(),
      takes: d.takes,
      description: d.description.trim(),
    };
    onGlobalVarsChange(
      varEditing.mode === 'edit' ? globalVars.map((v) => (v.id === def.id ? def : v)) : [...globalVars, def]
    );
    setVarEditing(null);
    setVarError('');
  };

  const handleVarDelete = (v: GlobalVarDef) => {
    if (!confirm(`Delete the variable {${v.name}}? Commands that use it will keep the text {${v.name}} unchanged.`)) return;
    onGlobalVarsChange(globalVars.filter((x) => x.id !== v.id));
    if (varEditing?.mode === 'edit' && varEditing.id === v.id) setVarEditing(null);
  };

  // ---- CONST variables ----
  const startConstAdd = () => {
    setConstError('');
    setConstEditing({ mode: 'add', draft: { name: '', value: '', description: '' } });
  };

  const startConstEdit = (v: ConstVar) => {
    setConstError('');
    setConstEditing({ mode: 'edit', id: v.id, draft: { name: v.name, value: v.value, description: v.description } });
  };

  const updateConstDraft = (field: keyof ConstDraft, value: string) => {
    if (!constEditing) return;
    setConstEditing({ ...constEditing, draft: { ...constEditing.draft, [field]: value } });
  };

  const handleConstSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!constEditing) return;
    const d = constEditing.draft;
    const err = validateVarName(
      d.name,
      [...globalVars, ...constVars],
      constEditing.mode === 'edit' ? constEditing.id : undefined
    );
    if (err) {
      setConstError(err);
      return;
    }
    if (!d.value.trim()) {
      setConstError('Value is required.');
      return;
    }
    const def: ConstVar = {
      id: constEditing.mode === 'edit' ? constEditing.id : newConstId(),
      name: d.name.trim().toUpperCase(),
      value: d.value.trim(),
      description: d.description.trim(),
    };
    onConstVarsChange(
      constEditing.mode === 'edit' ? constVars.map((v) => (v.id === def.id ? def : v)) : [...constVars, def]
    );
    setConstEditing(null);
    setConstError('');
  };

  const handleConstDelete = (v: ConstVar) => {
    if (!confirm(`Delete the constant {${v.name}} (${v.value})? Commands that use it will keep the text {${v.name}} unchanged.`)) return;
    onConstVarsChange(constVars.filter((x) => x.id !== v.id));
    if (constEditing?.mode === 'edit' && constEditing.id === v.id) setConstEditing(null);
  };

  const renderConstForm = (draft: ConstDraft, mode: 'add' | 'edit') => (
    <form className="settings-cmd-form" onSubmit={handleConstSave}>
      <div className="settings-form-title">{mode === 'add' ? 'New CONST variable' : 'Edit CONST variable'}</div>

      <label className="modal-label">Name (written as {'{NAME}'} in commands)</label>
      <input
        className="modal-input settings-mono"
        value={draft.name}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => updateConstDraft('name', e.target.value)}
        placeholder="e.g. IP"
        autoFocus
      />

      <label className="modal-label">Value (typed in place of the name)</label>
      <input
        className="modal-input settings-mono"
        value={draft.value}
        onChange={(e) => updateConstDraft('value', e.target.value)}
        placeholder="e.g. 202.283.242.97"
      />

      <label className="modal-label">Description</label>
      <input
        className="modal-input"
        value={draft.description}
        onChange={(e) => updateConstDraft('description', e.target.value)}
        placeholder="e.g. This is the IP of XYZ server"
      />

      {mode === 'edit' && (
        <div className="settings-empty" style={{ padding: '4px 0' }}>
          Renaming also updates the old name in your commands.
        </div>
      )}

      {constError && <div className="settings-error">{constError}</div>}

      <div className="modal-footer">
        <button
          type="button"
          onClick={() => {
            setConstEditing(null);
            setConstError('');
          }}
        >
          Cancel
        </button>
        <button type="submit" className="active">
          {mode === 'add' ? 'Add constant' : 'Save changes'}
        </button>
      </div>
    </form>
  );

  const renderVarForm = (draft: VarDraft, mode: 'add' | 'edit') => (
    <form className="settings-cmd-form" onSubmit={handleVarSave}>
      <div className="settings-form-title">{mode === 'add' ? 'New global variable' : 'Edit global variable'}</div>

      <label className="modal-label">Name (written as {'{NAME}'} in commands)</label>
      <input
        className="modal-input settings-mono"
        value={draft.name}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => updateVarDraft('name', e.target.value)}
        placeholder="e.g. SOURCE"
        autoFocus
      />

      <label className="modal-label">Right-click &quot;Assign&quot; stores</label>
      <select
        className="modal-input"
        value={draft.takes}
        onChange={(e) => updateVarDraft('takes', e.target.value as VarTakes)}
      >
        <option value="item">Only the item you right-clicked (one path)</option>
        <option value="selection">Every selected item (one or more paths)</option>
      </select>

      <label className="modal-label">Description</label>
      <input
        className="modal-input"
        value={draft.description}
        onChange={(e) => updateVarDraft('description', e.target.value)}
        placeholder="e.g. Folder to read from"
      />

      {mode === 'edit' && (
        <div className="settings-empty" style={{ padding: '4px 0' }}>
          Renaming also updates the old name in your commands and keeps the current value.
        </div>
      )}

      {varError && <div className="settings-error">{varError}</div>}

      <div className="modal-footer">
        <button
          type="button"
          onClick={() => {
            setVarEditing(null);
            setVarError('');
          }}
        >
          Cancel
        </button>
        <button type="submit" className="active">
          {mode === 'add' ? 'Add variable' : 'Save changes'}
        </button>
      </div>
    </form>
  );

  const renderForm = (draft: Draft, mode: 'add' | 'edit') => (
    <form className="settings-cmd-form" onSubmit={handleSave}>
      <div className="settings-form-title">{mode === 'add' ? 'New command' : 'Edit command'}</div>

      <label className="modal-label">Name (shown in the menu)</label>
      <input
        className="modal-input"
        value={draft.name}
        onChange={(e) => updateDraft('name', e.target.value)}
        placeholder='e.g. ren (rename)'
        autoFocus
      />

      <label className="modal-label">Terminal text (typed at the prompt when picked)</label>
      <input
        className="modal-input settings-mono"
        value={draft.insertText}
        onChange={(e) => updateDraft('insertText', e.target.value)}
        placeholder='e.g. ren {SELEC} {DEST}  (filled from the file panel)'
      />

      <label className="modal-label">Description</label>
      <input
        className="modal-input"
        value={draft.description}
        onChange={(e) => updateDraft('description', e.target.value)}
        placeholder='e.g. Rename a file or folder'
      />

      <label className="modal-label">Usage example</label>
      <input
        className="modal-input settings-mono"
        value={draft.usage}
        onChange={(e) => updateDraft('usage', e.target.value)}
        placeholder='e.g. ren "oldname.txt" "newname.txt"'
      />

      <label className="modal-label">Hot key (optional): types this command at the prompt while the command line is active</label>
      <div className="settings-hotkey-row">
        <span className="settings-hotkey-prefix">Ctrl + Alt +</span>
        <select
          className="modal-input settings-mono"
          value={draft.hotkey.startsWith(HOTKEY_PREFIX) ? draft.hotkey.slice(HOTKEY_PREFIX.length) : ''}
          onChange={(e) => updateDraft('hotkey', e.target.value ? HOTKEY_PREFIX + e.target.value : '')}
        >
          <option value="">(no hot key)</option>
          {availableKeys(groups, editing?.mode === 'edit' ? editing.id : undefined).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <label className="modal-label">Group</label>
      <select
        className="modal-input"
        value={draft.category}
        onChange={(e) => updateDraft('category', e.target.value)}
      >
        {groups.map((g) => (
          <option key={g.category} value={g.category}>
            {g.category}
          </option>
        ))}
      </select>

      {error && <div className="settings-error">{error}</div>}

      <div className="modal-footer">
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setError('');
          }}
        >
          Cancel
        </button>
        <button type="submit" className="active">
          {mode === 'add' ? 'Add command' : 'Save changes'}
        </button>
      </div>
    </form>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`settings-dialog ${section === 'manual' ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Settings size={14} />
            <span>Settings</span>
            <span className="settings-header-sub">/ {section === 'vars' ? 'Global Var' : section === 'consts' ? 'CONST Global Var' : section === 'columns' ? 'Files Column' : section === 'frequent' ? 'Frequently Accessed' : section === 'quickaccess' ? 'Quick Access' : section === 'manual' ? 'Manual' : section === 'about' ? 'About' : 'Commands'}</span>
          </div>
          <button onClick={onClose} title="Close (Esc)" style={{ padding: 2 }}>
            <X size={14} />
          </button>
        </div>

        <div className="settings-hint">
          {section === 'commands' ? (
            <>
              These commands appear in the terminal's <b>Commands 💡</b> menu. Pick a group, then add, edit or delete its
              commands. Use {'{SELEC}'}, {'{DEST}'} or your own variables in a command. Changes are saved automatically.
            </>
          ) : section === 'consts' ? (
            <>
              A <b>CONST Global Var</b> is a name with a fixed value, for example <b>IP</b> = 202.283.242.97. Write{' '}
              {'{IP}'} in a command and the value is typed in its place. Unlike the Global Var section, the values are
              saved and stay until you delete them. Changes are saved automatically.
            </>
          ) : section === 'manual' ? (
            <>
              The boonsh manual: every feature, how to use it and its limits. Click an item in the contents list to jump to it.
            </>
          ) : section === 'about' ? (
            <>
              About boonsh: its version, its license and the open-source libraries it is built with.
            </>
          ) : section === 'quickaccess' ? (
            <>
              <b>Quick Access</b> is the row of folder buttons above the folder tree. Tick the ones you want to see, up
              to {QA_MAX}. You can still right-click a folder, <b>Add to Quick Access</b>, or right-click a button to
              remove it. Changes are saved automatically.
            </>
          ) : section === 'frequent' ? (
            <>
              The <b>Frequently Accessed</b> panel sits above the Folder Tree and lists the folders you open most. Switch
              it on or off and choose how many folders it shows. Changes are saved automatically.
            </>
          ) : section === 'columns' ? (
            <>
              Choose which columns the file panel shows and in what order. In the file panel, <b>click</b> a column
              name to sort by it, <b>Shift+click</b> to add it as the next sort level (shown as 1, 2, 3), and
              <b> right-click</b> a column name for more options. Changes are saved automatically.
            </>
          ) : (
            <>
              Global variables hold files or folders you pick in the file panel (right-click, <b>Assign to Global Var</b>)
              and fill them into commands as {'{NAME}'}. Their values are forgotten when the app closes.
            </>
          )}
        </div>

        <div className="settings-body">
          {/* Left bar: settings sections */}
          <div className="settings-groups">
            <div
              className={`terminal-cmd-cat-item ${section === 'commands' ? 'active' : ''}`}
              onClick={() => selectSection('commands')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <BookOpen size={13} style={{ color: '#f59e0b' }} />
                <span>Commands</span>
              </div>
              <span className="settings-count">{groups.reduce((n, g) => n + g.items.length, 0)}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'vars' ? 'active' : ''}`}
              onClick={() => selectSection('vars')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Variable size={13} style={{ color: '#06b6d4' }} />
                <span>Global Var</span>
              </div>
              <span className="settings-count">{globalVars.length}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'consts' ? 'active' : ''}`}
              onClick={() => selectSection('consts')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lock size={13} style={{ color: '#a855f7' }} />
                <span>CONST Global Var</span>
              </div>
              <span className="settings-count">{constVars.length}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'columns' ? 'active' : ''}`}
              onClick={() => selectSection('columns')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Columns3 size={13} style={{ color: 'var(--text-muted)' }} />
                <span>Files Column</span>
              </div>
              <span className="settings-count">{colPrefs.visible.length}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'quickaccess' ? 'active' : ''}`}
              onClick={() => {
                setQaMessage('');
                selectSection('quickaccess');
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Bookmark size={13} style={{ color: 'var(--text-muted)' }} />
                <span>Quick Access</span>
              </div>
              <span className="settings-count">{qaShown.length}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'frequent' ? 'active' : ''}`}
              onClick={() => selectSection('frequent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <History size={13} style={{ color: 'var(--text-muted)' }} />
                <span>Frequently Accessed</span>
              </div>
              <span className="settings-count">{freqSettings.enabled ? 'On' : 'Off'}</span>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'manual' ? 'active' : ''}`}
              onClick={() => selectSection('manual')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <BookText size={13} style={{ color: 'var(--text-muted)' }} />
                <span>Manual</span>
              </div>
            </div>
            <div
              className={`terminal-cmd-cat-item ${section === 'about' ? 'active' : ''}`}
              onClick={() => {
                setAboutMessage('');
                selectSection('about');
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Info size={13} style={{ color: 'var(--text-muted)' }} />
                <span>About</span>
              </div>
            </div>
          </div>

          {section === 'manual' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BookText size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>boonsh manual</span>
                </div>
                <span className="settings-col-note">{version ? `version ${version}` : ''}</span>
              </div>
              <ManualView />
            </div>
          ) : section === 'about' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Info size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>About {APP_NAME}</span>
                </div>
              </div>

              <div className="settings-commands-list settings-about">
                <div className="about-title">
                  {APP_NAME} <span className="about-version">{version ? `version ${version}` : ''}</span>
                </div>
                <div className="about-line">A file manager with a built-in PowerShell terminal, for Windows.</div>
                <div className="about-line">{COPYRIGHT}</div>
                <div className="about-line">
                  <b>Free software.</b> Anyone may use, copy, change and share boonsh, for free, under the MIT License
                  below.
                </div>

                <div className="about-buttons">
                  <button onClick={() => openLink('open_in_default_app', { path: REPO_URL })} title={REPO_URL}>
                    Project page on GitHub
                  </button>
                  <button onClick={() => openLink('open_license_notices')} title="THIRD_PARTY_LICENSES.txt, next to the app">
                    Open the licenses of the libraries inside boonsh
                  </button>
                </div>
                {aboutMessage && <div className="settings-error">{aboutMessage}</div>}

                <div className="about-heading">MIT License</div>
                <pre className="about-license">{licenseText}</pre>

                <div className="about-heading">Open-source components</div>
                <table className="about-table">
                  <tbody>
                    {COMPONENTS.map((c) => (
                      <tr key={c.name}>
                        <td>{c.name}</td>
                        <td>{c.license}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="about-line about-small">
                  These and the other libraries boonsh includes keep their own licenses. The full texts, with their
                  copyright notices, are in the file opened by the button above.
                </div>
              </div>
            </div>
          ) : section === 'quickaccess' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Bookmark size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Quick Access</span>
                </div>
                <span className="settings-col-note">
                  {qaShown.length} of {QA_MAX} shown
                </span>
              </div>

              <div className="settings-commands-list">
                {settingsRows(qaCandidates, qaShown).map((item) => {
                  const on = isShown(qaShown, item);
                  return (
                    <div key={item.path} className="settings-cmd-row settings-col-row">
                      <label className="settings-col-check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            if (e.target.checked && qaShown.length >= QA_MAX) {
                              setQaMessage(`Quick Access holds at most ${QA_MAX} items. Untick one first.`);
                              return;
                            }
                            setQaMessage('');
                            onQaToggle(item, e.target.checked);
                          }}
                        />
                        <span className="terminal-cmd-name">{item.label}</span>
                        <span className="settings-col-note" title={item.path}>
                          {item.path}
                        </span>
                      </label>
                    </div>
                  );
                })}

                {qaMessage && <div className="settings-error">{qaMessage}</div>}

                <div className="settings-empty">
                  Home, Desktop, Downloads, Documents and the C: drive are ticked at first. The other drives are listed
                  too. Folders you add with a right-click, <b>Add to Quick Access</b>, appear at the end of the list; if
                  you untick one it is removed from Quick Access (add it again by right-click).
                </div>
              </div>
            </div>
          ) : section === 'frequent' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <History size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Frequently Accessed</span>
                </div>
              </div>

              <div className="settings-commands-list">
                <div className="settings-cmd-row settings-col-row">
                  <label className="settings-col-check">
                    <input
                      type="checkbox"
                      checked={freqSettings.enabled}
                      onChange={(e) => onFreqSettingsChange({ ...freqSettings, enabled: e.target.checked })}
                    />
                    <span className="terminal-cmd-name">On: show the Frequently Accessed panel</span>
                  </label>
                </div>

                <div className="settings-cmd-row settings-col-row">
                  <label className="settings-col-check" style={{ cursor: 'default' }}>
                    <span className="terminal-cmd-name">Folders to show</span>
                    <select
                      className="modal-input"
                      style={{ width: 'auto' }}
                      value={freqSettings.count}
                      disabled={!freqSettings.enabled}
                      onChange={(e) => onFreqSettingsChange({ ...freqSettings, count: Number(e.target.value) })}
                    >
                      {Array.from({ length: MAX_COUNT - MIN_COUNT + 1 }, (_, i) => MIN_COUNT + i).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <span className="settings-col-note">{MIN_COUNT} to {MAX_COUNT}</span>
                  </label>
                </div>

                <div className="settings-cmd-row settings-col-row">
                  <div className="settings-cmd-info">
                    <div className="terminal-cmd-name">Visit history</div>
                    <div className="terminal-cmd-desc">
                      {freqTracked === 0
                        ? 'Nothing counted yet.'
                        : `${freqTracked} folder${freqTracked === 1 ? '' : 's'} counted so far.`}
                    </div>
                  </div>
                  <div className="settings-cmd-actions">
                    <button
                      disabled={freqTracked === 0}
                      onClick={() => {
                        if (confirm('Forget every folder? All visit counts go back to 0 and start building again.')) onFreqClear();
                      }}
                    >
                      <Trash2 size={13} />
                      <span>Clear history</span>
                    </button>
                  </div>
                </div>

                <div className="settings-empty">
                  A folder counts one visit each time it becomes the open folder: by double-click, in the folder tree, in
                  Quick Access, in the path bar or with <code>cd</code> in the terminal. Refreshing or searching does not
                  count. The panel lists the folders with the most visits (the most recent first when they tie).
                  Right-click a folder in the panel to remove it: its count goes back to 0 and builds up again, and the
                  next most visited folder takes its place. Counting goes on while the panel is switched off.
                </div>
              </div>
            </div>
          ) : section === 'columns' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Columns3 size={13} style={{ color: 'var(--text-muted)' }} />
                  <span>Files Column</span>
                </div>
              </div>

              <div className="settings-commands-list">
                {colPrefs.order.map((id, idx) => {
                  const col = COLUMN_BY_ID[id];
                  const on = colPrefs.visible.includes(id);
                  const dateCol = isDateColumn(id) ? id : null;
                  return (
                    <div key={id} className="settings-cmd-row settings-col-row">
                      <label className="settings-col-check">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={id === 'name'}
                          onChange={(e) => setVisible(id, e.target.checked)}
                        />
                        <span className="terminal-cmd-name">{col.label}</span>
                        {id === 'name' && <span className="settings-col-note">always shown, always first</span>}
                      </label>
                      {dateCol && (
                        <div className="settings-col-opts">
                          <label>
                            Show
                            <select
                              className="modal-input"
                              value={colPrefs.dateShow[dateCol]}
                              onChange={(e) => setDate(dateCol, 'dateShow', e.target.value as DateMode)}
                            >
                              <option value="datetime">Date and time</option>
                              <option value="date">Date only</option>
                            </select>
                          </label>
                          <label title="Date only: files from the same day count as equal, so the next sort level decides their order">
                            Sort by
                            <select
                              className="modal-input"
                              value={colPrefs.dateSort[dateCol]}
                              onChange={(e) => setDate(dateCol, 'dateSort', e.target.value as DateMode)}
                            >
                              <option value="datetime">Date and time</option>
                              <option value="date">Date only</option>
                            </select>
                          </label>
                        </div>
                      )}
                      <div className="settings-cmd-actions">
                        <button onClick={() => moveColumn(id, -1)} disabled={id === 'name' || idx <= 1} title="Move left">
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() => moveColumn(id, 1)}
                          disabled={id === 'name' || idx >= colPrefs.order.length - 1}
                          title="Move right"
                        >
                          <ArrowDown size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="settings-cmd-row">
                  <label className="settings-col-check">
                    <input
                      type="checkbox"
                      checked={colPrefs.foldersFirst}
                      onChange={(e) => onColPrefsChange({ ...colPrefs, foldersFirst: e.target.checked })}
                    />
                    <span className="terminal-cmd-name">Keep folders above files when sorting</span>
                  </label>
                </div>

                <div className="settings-empty">
                  Dimensions, Length, Album, Artist, Actor, Genre and Rating are read from the file's own properties,
                  the same way Windows Explorer shows them, and only for pictures, videos and audio files. A file that has
                  no value for a column shows it empty, and empty values always sort last. Windows has no separate
                  "Actor" property: for videos the Actor column shows the "Contributing artists" tag.
                </div>
              </div>
            </div>
          ) : section === 'commands' ? (
            <div className="settings-commands">
              {/* Command groups: a dropdown, plus New / Rename / Delete (Rename and Delete for the groups the user made) */}
              <div className="settings-group-bar">
                <label className="modal-label" style={{ margin: 0 }}>Group</label>
                {groupEditing ? (
                  <form className="settings-group-form" onSubmit={handleGroupSave}>
                    <input
                      className="modal-input"
                      value={groupEditing.draft}
                      maxLength={MAX_GROUP_NAME}
                      onChange={(e) => setGroupEditing({ ...groupEditing, draft: e.target.value })}
                      placeholder="e.g. Cisco Network"
                      autoFocus
                    />
                    <button type="submit" className="active">
                      {groupEditing.mode === 'add' ? 'Add group' : 'Rename'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGroupEditing(null);
                        setGroupError('');
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <select
                      className="modal-input settings-group-select"
                      value={activeGroup.category}
                      onChange={(e) => selectGroup(e.target.value)}
                    >
                      {groups.map((g) => (
                        <option key={g.category} value={g.category}>
                          {g.category} ({g.items.length})
                        </option>
                      ))}
                    </select>
                    <button
                      className="settings-icon-btn"
                      onClick={() => {
                        setGroupError('');
                        setGroupNote('');
                        setGroupEditing({ mode: 'add', draft: '' });
                      }}
                      title="New group: make a group such as Cisco Network"
                    >
                      <FolderPlus size={14} style={{ color: '#22c55e' }} />
                    </button>
                    <button
                      className="settings-icon-btn"
                      disabled={!activeGroup.custom}
                      onClick={() => {
                        setGroupError('');
                        setGroupNote('');
                        setGroupEditing({ mode: 'rename', draft: activeGroup.category });
                      }}
                      title={activeGroup.custom ? 'Rename this group' : 'Rename: the built-in groups cannot be renamed'}
                    >
                      <Pencil size={14} style={{ color: '#3b82f6' }} />
                    </button>
                    <button
                      className="settings-icon-btn"
                      disabled={!activeGroup.custom}
                      onClick={handleGroupDelete}
                      title={activeGroup.custom ? 'Delete this group and its commands' : 'Delete: the built-in groups cannot be deleted'}
                    >
                      <Trash2 size={14} style={{ color: '#ef4444' }} />
                    </button>
                    <span className="settings-icon-sep" />
                    <button
                      className="settings-icon-btn"
                      onClick={handleImport}
                      title="Import: add commands from a .json or .csv file to this group"
                    >
                      <Download size={14} style={{ color: '#06b6d4' }} />
                    </button>
                    <button
                      className="settings-icon-btn"
                      disabled={activeGroup.items.length === 0}
                      onClick={handleExport}
                      title="Export: save this group's commands to a .json or .csv file"
                    >
                      <Upload size={14} style={{ color: '#f59e0b' }} />
                    </button>
                  </>
                )}
              </div>
              {groupError && <div className="settings-error" style={{ margin: '0 12px 6px' }}>{groupError}</div>}
              {groupNote && <div className="settings-note">{groupNote}</div>}

              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <GroupIcon icon={activeGroup.icon} />
                  <span>{activeGroup.category}</span>
                </div>
                <button onClick={startAdd} disabled={editing?.mode === 'add'} title="Add a command to this group">
                  <Plus size={13} />
                  <span>Add command</span>
                </button>
              </div>

              <div className="settings-commands-list">
                {editing?.mode === 'add' && renderForm(editing.draft, 'add')}

                {activeGroup.items.length === 0 && editing?.mode !== 'add' && (
                  <div className="settings-empty">
                    No commands in this group yet. Click <b>Add command</b> to create one.
                  </div>
                )}

                {activeGroup.items.map((item) =>
                  editing?.mode === 'edit' && editing.id === item.id ? (
                    <React.Fragment key={item.id}>{renderForm(editing.draft, 'edit')}</React.Fragment>
                  ) : (
                    <div key={item.id} className="settings-cmd-row" onDoubleClick={() => startEdit(item)}>
                      <div className="settings-cmd-info">
                        <div className="terminal-cmd-name">{item.name}</div>
                        {item.description && <div className="terminal-cmd-desc">{item.description}</div>}
                        {item.usage && <div className="terminal-cmd-usage-preview">Usage: {item.usage}</div>}
                        {item.hotkey && <div className="terminal-cmd-usage-preview">Hot key: <span className="hotkey-badge">{item.hotkey}</span></div>}
                      </div>
                      <div className="settings-cmd-actions">
                        <button onClick={() => startEdit(item)} title="Edit command">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleDelete(item)} title="Delete command">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          ) : section === 'consts' ? (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Lock size={13} style={{ color: '#a855f7' }} />
                  <span>CONST Global Var</span>
                </div>
                <button onClick={startConstAdd} disabled={constEditing?.mode === 'add'} title="Add a constant">
                  <Plus size={13} />
                  <span>Add constant</span>
                </button>
              </div>

              <div className="settings-commands-list">
                {constEditing?.mode === 'add' && renderConstForm(constEditing.draft, 'add')}

                {constVars.length === 0 && constEditing?.mode !== 'add' && (
                  <div className="settings-empty">
                    No constants yet. Click <b>Add constant</b> to create one, for example IP = 202.283.242.97.
                  </div>
                )}

                {constVars.map((v) =>
                  constEditing?.mode === 'edit' && constEditing.id === v.id ? (
                    <React.Fragment key={v.id}>{renderConstForm(constEditing.draft, 'edit')}</React.Fragment>
                  ) : (
                    <div key={v.id} className="settings-cmd-row" onDoubleClick={() => startConstEdit(v)}>
                      <div className="settings-cmd-info">
                        <div className="terminal-cmd-name settings-mono">{`{${v.name}} = ${v.value}`}</div>
                        {v.description && <div className="terminal-cmd-desc">{v.description}</div>}
                      </div>
                      <div className="settings-cmd-actions">
                        <button onClick={() => startConstEdit(v)} title="Edit or rename constant">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleConstDelete(v)} title="Delete constant">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          ) : (
            <div className="settings-commands">
              <div className="settings-commands-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Variable size={13} style={{ color: '#06b6d4' }} />
                  <span>Global Var</span>
                </div>
                <button onClick={startVarAdd} disabled={varEditing?.mode === 'add'} title="Add a global variable">
                  <Plus size={13} />
                  <span>Add variable</span>
                </button>
              </div>

              <div className="settings-commands-list">
                {varEditing?.mode === 'add' && renderVarForm(varEditing.draft, 'add')}

                {globalVars.length === 0 && varEditing?.mode !== 'add' && (
                  <div className="settings-empty">
                    No global variables. Click <b>Add variable</b> to create one.
                  </div>
                )}

                {globalVars.map((v) => {
                  if (varEditing?.mode === 'edit' && varEditing.id === v.id) {
                    return <React.Fragment key={v.id}>{renderVarForm(varEditing.draft, 'edit')}</React.Fragment>;
                  }
                  const values = pathVars[v.name] ?? [];
                  return (
                    <div key={v.id} className="settings-cmd-row" onDoubleClick={() => startVarEdit(v)}>
                      <div className="settings-cmd-info">
                        <div className="terminal-cmd-name settings-mono">{`{${v.name}}`}</div>
                        <div className="terminal-cmd-desc">
                          {v.description ? `${v.description} - ` : ''}
                          {v.takes === 'selection' ? 'takes every selected item' : 'takes the right-clicked item'}
                        </div>
                        <div className="terminal-cmd-usage-preview">
                          {values.length ? `Value: ${values.join('  ')}` : 'Not set'}
                        </div>
                      </div>
                      <div className="settings-cmd-actions">
                        <button onClick={() => startVarEdit(v)} title="Edit or rename variable">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleVarDelete(v)} title="Delete variable">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="settings-footer">
          {section === 'about' || section === 'manual' || section === 'consts' ? <span /> : <button onClick={handleReset} title={section === 'vars' ? 'Restore {SELEC} and {DEST} only' : section === 'columns' ? 'Restore the default columns' : section === 'frequent' ? 'Back to on, 3 folders' : section === 'quickaccess' ? 'Back to Home, Desktop, Downloads, Documents and C:' : 'Restore the built-in command list'}>
            <RotateCcw size={13} />
            <span>{section === 'vars' ? 'Reset variables' : section === 'columns' ? 'Reset columns' : section === 'frequent' ? 'Reset settings' : section === 'quickaccess' ? 'Reset Quick Access' : 'Reset commands'}</span>
          </button>}
          <button onClick={onClose} className="active">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
