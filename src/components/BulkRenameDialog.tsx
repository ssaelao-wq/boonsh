import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Search, Check, AlertTriangle } from 'lucide-react';
import {
  ApplyResult,
  BUILTIN_PRESETS,
  CollisionPolicy,
  MAX_RULES,
  MAX_USER_PRESETS,
  PreviewResult,
  RULE_TITLES,
  RenameOp,
  RenamePreset,
  RuleKind,
  RulesForm,
  defaultForm,
  diffSegments,
  formProblem,
  formToRules,
  loadUserPresets,
  newRule,
  saveUserPresets,
  withFreshIds,
} from '../bulkRename';
import { RuleCard } from './RuleCard';

interface BulkRenameDialogProps {
  paths: string[]; // selected items, in the file panel's current sort order (numbering follows it)
  folderCount: number; // how many of them are folders (the Include sub-folders option needs at least one)
  onClose: () => void;
  onApplied: (r: { renamed: number; ops: RenameOp[]; newPaths: string[] }) => void;
}

const ROW_H = 26;

// Tested recipes for the regex help (see bulk_rename.rs tests). Clicking one fills the first Find & Replace rule.
const RECIPES: { goal: string; find: string; replace: string }[] = [
  { goal: 'Remove a "(1)" suffix', find: '\\s*\\(\\d+\\)$', replace: '' },
  { goal: 'Spaces to underscores', find: '\\s+', replace: '_' },
  { goal: '"Last, First" to "First Last"', find: '^(\\w+),\\s*(\\w+)$', replace: '$2 $1' },
  { goal: '31-12-2026 to 2026-12-31', find: '(\\d{2})-(\\d{2})-(\\d{4})', replace: '$3-$2-$1' },
  { goal: 'Remove a leading "IMG_"', find: '^IMG_', replace: '' },
  { goal: 'A single digit 1..9 to 01..09', find: '^(\\d)$', replace: '0$1' },
];

const RULE_KINDS: RuleKind[] = ['find', 'case', 'insert_remove', 'numbering', 'extension', 'template'];

export const BulkRenameDialog: React.FC<BulkRenameDialogProps> = ({ paths, folderCount, onClose, onApplied }) => {
  const [form, setForm] = useState<RulesForm>(defaultForm);
  // Also rename what is inside the selected folders, at any depth. Off by default; not saved in presets because
  // it depends on what is selected.
  const [includeSub, setIncludeSub] = useState<boolean>(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [stale, setStale] = useState<boolean>(false); // rules changed since the preview was made
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Problems of the ticked rows. Starts as the preview's own, and is re-checked (without a new preview)
  // whenever rows are ticked or unticked, because a collision can disappear when one of its rows is left out.
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [validating, setValidating] = useState<boolean>(false);
  const [onlyProblems, setOnlyProblems] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const seqRef = useRef(0);
  const validateSeqRef = useRef(0);

  // Presets: built-in ones are keyed "b:<name>", the user's own "u:<name>"
  const [userPresets, setUserPresets] = useState<RenamePreset[]>(loadUserPresets);
  const [presetKey, setPresetKey] = useState<string>('');
  const [savingPreset, setSavingPreset] = useState<boolean>(false);
  const [presetName, setPresetName] = useState<string>('');
  const isUserPreset = presetKey.startsWith('u:');

  // Any change to the rules makes the current preview stale: Rename stays disabled until Preview is clicked again
  const changed = (next: RulesForm) => {
    setForm(next);
    setPresetKey(''); // the rules no longer match the chosen preset
    if (preview) setStale(true);
  };
  const setRules = (fn: (rules: RulesForm['rules']) => RulesForm['rules']) => changed({ ...form, rules: fn(form.rules) });
  const updateRule = (id: string, patch: Record<string, unknown>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? ({ ...r, ...patch } as typeof r) : r)));
  const moveRule = (id: string, dir: -1 | 1) =>
    setRules((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removeRule = (id: string) => setRules((rs) => rs.filter((r) => r.id !== id));
  const addRule = (kind: RuleKind) => {
    if (form.rules.length >= MAX_RULES) return setError(`You can use up to ${MAX_RULES} rules.`);
    setRules((rs) => [...rs, newRule(kind)]);
  };

  const applyPreset = (key: string) => {
    const preset = key.startsWith('b:')
      ? BUILTIN_PRESETS.find((p) => 'b:' + p.name === key)
      : userPresets.find((p) => 'u:' + p.name === key);
    if (!preset) {
      setPresetKey('');
      return;
    }
    setForm(withFreshIds(preset.form));
    setPresetKey(key);
    setError('');
    if (preview) setStale(true);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return setError('Give the preset a name first.');
    if (name.length > 40) return setError('Keep the preset name to 40 characters or fewer.');
    if (BUILTIN_PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return setError(`"${name}" is the name of a built-in preset. Choose another name.`);
    }
    const existing = userPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0 && !confirm(`Replace your preset "${userPresets[existing].name}" with the current rules?`)) return;
    if (existing < 0 && userPresets.length >= MAX_USER_PRESETS) {
      return setError(`You can keep up to ${MAX_USER_PRESETS} presets. Delete one first.`);
    }
    const saved: RenamePreset = { name, form };
    const next = existing >= 0 ? userPresets.map((p, i) => (i === existing ? saved : p)) : [...userPresets, saved];
    setUserPresets(next);
    saveUserPresets(next);
    setPresetKey('u:' + name);
    setSavingPreset(false);
    setError('');
  };

  const deletePreset = () => {
    if (!isUserPreset) return;
    const name = presetKey.slice(2);
    if (!confirm(`Delete your preset "${name}"?`)) return;
    const next = userPresets.filter((p) => p.name !== name);
    setUserPresets(next);
    saveUserPresets(next);
    setPresetKey('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (showHelp) setShowHelp(false);
      else if (savingPreset) setSavingPreset(false);
      else if (!renaming) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHelp, savingPreset, renaming, onClose]);

  const runPreview = () => {
    if (previewing || renaming) return;
    // Numbers are used exactly as typed: a value that is empty, not a whole number or out of range is reported
    const problem = formProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    const rules = formToRules(form);
    if (rules.rules.length === 0) {
      setError('Nothing to do yet: switch on a rule and fill it in (for example, enter the text to find).');
      return;
    }
    const seq = ++seqRef.current;
    setPreviewing(true);
    setError('');
    invoke<PreviewResult>('bulk_rename_preview', { paths, rules, includeSubfolders: includeSub })
      .then((res) => {
        if (seq !== seqRef.current) return;
        setPreview(res);
        setChecked(new Set(res.rows.filter((r) => !r.skipped).map((r) => r.path))); // skipped items are never ticked
        setRowErrors(Object.fromEntries(res.rows.map((r) => [r.path, r.error])));
        validateSeqRef.current++;
        setValidating(false);
        setStale(false);
        setScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
      })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        setError(String(err));
        if (preview) setStale(true);
      })
      .finally(() => {
        if (seq === seqRef.current) setPreviewing(false);
      });
  };

  const rows = preview?.rows ?? [];
  const selectable = rows.filter((r) => !r.skipped); // skipped rows can't be ticked
  const tickedRows = rows.filter((r) => checked.has(r.path));
  const errorOf = (r: { path: string }) => (checked.has(r.path) ? rowErrors[r.path] ?? null : null);
  const tickedProblems = tickedRows.filter((r) => errorOf(r)).length;
  const shownRows = onlyProblems ? rows.filter((r) => errorOf(r)) : rows;
  const canRename =
    !!preview && !stale && !previewing && !renaming && !validating && tickedRows.length > 0 && tickedProblems === 0;
  const showFolder = new Set(rows.map((r) => r.folder)).size > 1;

  const doRename = () => {
    if (!canRename) return;
    if (tickedRows.length > 100 && !confirm(`Rename ${tickedRows.length} items?`)) return;
    setRenaming(true);
    setError('');
    invoke<ApplyResult>('bulk_rename_apply', {
      pairs: tickedRows.map((r) => ({ path: r.path, new_name: r.new_name })),
    })
      .then((res) => onApplied({ renamed: res.renamed, ops: res.ops, newPaths: res.new_paths }))
      .catch((err) => {
        setError(String(err));
        setStale(true); // the files changed or something failed: look at a fresh preview first
      })
      .finally(() => setRenaming(false));
  };

  // Tick/untick: re-check just the ticked rows against each other and the disk (the list itself stays as previewed)
  const changeTicks = (next: Set<string>) => {
    setChecked(next);
    const pairs = rows.filter((r) => next.has(r.path)).map((r) => ({ path: r.path, new_name: r.new_name }));
    const seq = ++validateSeqRef.current;
    if (pairs.length === 0) {
      setValidating(false);
      return;
    }
    setValidating(true);
    invoke<(string | null)[]>('bulk_rename_validate', { pairs })
      .then((errs) => {
        if (seq !== validateSeqRef.current) return;
        setRowErrors(Object.fromEntries(pairs.map((p, i) => [p.path, errs[i] ?? null])));
      })
      .catch((err) => {
        if (seq === validateSeqRef.current) setError(String(err));
      })
      .finally(() => {
        if (seq === validateSeqRef.current) setValidating(false);
      });
  };
  const toggleRow = (path: string) => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    changeTicks(next);
  };
  const allTicked = selectable.length > 0 && tickedRows.length === selectable.length;

  // Only the rows in view are drawn, so very long previews stay fast
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewH, setViewH] = useState<number>(320);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const last = Math.min(shownRows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6);

  const gridClass = `br-grid ${showFolder ? 'with-folder' : ''}`;

  const hint = !preview
    ? ''
    : stale
    ? 'Rules changed. Click Preview to update.'
    : tickedProblems > 0
    ? 'Fix the rules or untick the red rows.'
    : tickedRows.length === 0
    ? 'Nothing is ticked.'
    : '';

  return (
    <div className="modal-overlay" onClick={() => !renaming && onClose()}>
      <div className="br-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Bulk Rename</span>
            <span className="settings-header-sub">/ {paths.length} items selected</span>
          </div>
          <button onClick={onClose} disabled={renaming} title="Close (Esc)" style={{ padding: 2 }}>
            <X size={14} />
          </button>
        </div>

        {/* ---- Rules (top) ---- */}
        <form
          className="br-rules"
          onSubmit={(e) => {
            e.preventDefault();
            runPreview();
          }}
        >
          {/* Presets: named sets of rules */}
          <div className="br-presets">
            <span className="modal-label">Preset</span>
            <select className="modal-input br-select" value={presetKey} onChange={(e) => applyPreset(e.target.value)} title="Load a ready-made or saved set of rules">
              <option value="">Choose a preset...</option>
              <optgroup label="Built-in">
                {BUILTIN_PRESETS.map((p) => (
                  <option key={p.name} value={'b:' + p.name}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              {userPresets.length > 0 && (
                <optgroup label="Your presets">
                  {userPresets.map((p) => (
                    <option key={p.name} value={'u:' + p.name}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {savingPreset ? (
              <>
                <input
                  className="modal-input"
                  style={{ width: 200 }}
                  value={presetName}
                  placeholder="Name for these rules"
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault(); // Enter here saves the preset, it must not start a preview
                      savePreset();
                    }
                  }}
                  autoFocus
                />
                <button type="button" className="active" onClick={savePreset}>
                  Save
                </button>
                <button type="button" onClick={() => setSavingPreset(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setPresetName(isUserPreset ? presetKey.slice(2) : '');
                    setSavingPreset(true);
                  }}
                  title="Save the current rules under a name"
                >
                  Save rules as...
                </button>
                <button type="button" onClick={deletePreset} disabled={!isUserPreset} title="Delete the selected preset (your own presets only)">
                  Delete preset
                </button>
              </>
            )}
          </div>

          {/* The stack of rules: they run from top to bottom */}
          {form.rules.length === 0 && <div className="br-note">No rules yet. Add one below.</div>}
          {form.rules.map((rule, index) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              index={index}
              count={form.rules.length}
              onChange={(patch) => updateRule(rule.id, patch)}
              onMove={(dir) => moveRule(rule.id, dir)}
              onRemove={() => removeRule(rule.id)}
              helpOpen={showHelp}
              onToggleHelp={() => setShowHelp((v) => !v)}
            />
          ))}

          <div className="br-addrow">
            <select
              className="modal-input br-select"
              value=""
              onChange={(e) => {
                if (e.target.value) addRule(e.target.value as RuleKind);
              }}
              title="Add another rule at the end of the list"
            >
              <option value="">+ Add a rule...</option>
              {RULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RULE_TITLES[k]}
                </option>
              ))}
            </select>
            <span className="br-note">Rules run from top to bottom. Use the arrows on a rule to change the order, and add the same kind more than once if you need to.</span>
          </div>

          <div className="br-actions">
            <div className="br-actions-left">
              <label
                className="br-check"
                title={
                  folderCount === 0
                    ? 'No folder is selected, so there are no sub-folders to include.'
                    : 'Also rename everything inside the selected folders, at any depth. Off: only the selected items themselves.'
                }
              >
                <input
                  type="checkbox"
                  checked={includeSub}
                  disabled={folderCount === 0}
                  onChange={(e) => {
                    setIncludeSub(e.target.checked);
                    if (preview) setStale(true); // the list of items changes
                  }}
                />
                Include sub-folders
              </label>
              <label className="br-check" title="What to do when a new name is already taken by another item or by a file that stays">
                If a new name is already taken:
                <select
                  className="modal-input br-select"
                  style={{ width: 'auto' }}
                  value={form.onCollision}
                  onChange={(e) => changed({ ...form, onCollision: e.target.value as CollisionPolicy })}
                >
                  <option value="skip">skip that item</option>
                  <option value="block">show a problem</option>
                  <option value="number">add (2), (3)...</option>
                </select>
              </label>
            </div>
            <button type="submit" className="active" disabled={previewing || renaming} title="Show what would change (Enter in any field does the same)">
              <Search size={13} />
              <span>{previewing ? 'Working...' : 'Preview'}</span>
            </button>
          </div>
          {showHelp && (
            <div className="br-help">
              <div className="br-help-title">Regular expression recipes (click one to use it in the Find & Replace rule)</div>
              {RECIPES.map((r) => (
                <div
                  key={r.goal}
                  className="search-help-row"
                  onClick={() => {
                    const target = form.rules.find((x) => x.kind === 'find');
                    const patch = { on: true, find: r.find, replace: r.replace, regex: true };
                    if (target) updateRule(target.id, patch);
                    else changed({ ...form, rules: [...form.rules, newRule('find', patch)] });
                    setShowHelp(false);
                  }}
                >
                  <code>{r.find}</code>
                  <code>{r.replace === '' ? '(empty)' : r.replace}</code>
                  <span>{r.goal}</span>
                </div>
              ))}
              <div className="search-help-footer">
                Same engine and syntax as the <b>filename:</b> search. In the replacement, <b>$1</b>, <b>$2</b> insert what
                the brackets matched, and <b>$$</b> is a dollar sign. Write <b>${'{1}'}</b>_ if a letter or underscore follows the
                number (<b>$1_</b> would be read as a group called "1_"). The pattern is matched against the name only, and
                ignores case unless <b>Match case</b> is on. With <b>Regular expression</b> off, both fields are plain text.
              </div>
            </div>
          )}
        </form>

        {error && <div className="br-error">{error}</div>}

        {/* ---- Preview (bottom) ---- */}
        <div className="br-preview-head">
          {!preview ? (
            <span>Set your rules, then click <b>Preview</b>. Nothing is renamed until you click <b>Rename</b>.</span>
          ) : (
            <span className={stale ? 'br-stale' : ''}>
              <b>{preview.changed}</b> of {preview.total} names will change
              {preview.skipped > 0 && <> · {preview.skipped} skipped (new name already taken)</>}
              {preview.unchanged > 0 && <> · {preview.unchanged} unchanged (not listed)</>}
              {tickedProblems > 0 && <span className="br-problem-count"> · {tickedProblems} with problems</span>}
              {selectable.length > tickedRows.length && <> · {selectable.length - tickedRows.length} left out (unticked)</>}
              {stale && <b> · Rules changed. Click Preview to update.</b>}
            </span>
          )}
          {preview && (tickedProblems > 0 || onlyProblems) && (
            <label className="br-check" title="Hide the rows that are fine">
              <input
                type="checkbox"
                checked={onlyProblems}
                onChange={(e) => {
                  setOnlyProblems(e.target.checked);
                  setScrollTop(0);
                  if (listRef.current) listRef.current.scrollTop = 0;
                }}
              />
              Show only problems
            </label>
          )}
        </div>
        <div className={`br-list-head ${gridClass}`}>
          <span>
            <input type="checkbox" checked={allTicked} disabled={selectable.length === 0} onChange={() => changeTicks(allTicked ? new Set() : new Set(selectable.map((r) => r.path)))} title="Tick or untick all" />
          </span>
          {showFolder && <span>Folder</span>}
          <span>Current name</span>
          <span />
          <span>New name</span>
          <span>Status</span>
        </div>
        <div className={`br-list ${stale ? 'stale' : ''}`} ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          {preview && rows.length === 0 && <div className="br-empty">No names match these rules.</div>}
          {preview && rows.length > 0 && shownRows.length === 0 && <div className="br-empty">No problems. Untick "Show only problems" to see every row.</div>}
          <div style={{ height: shownRows.length * ROW_H, position: 'relative' }}>
            {shownRows.slice(first, last).map((r, k) => {
              const i = first + k;
              const d = diffSegments(r.old_name, r.new_name);
              const ticked = checked.has(r.path);
              const err = errorOf(r);
              return (
                <div key={r.path} className={`br-row ${gridClass} ${err ? 'bad' : ''} ${ticked ? '' : 'skipped'}`} style={{ top: i * ROW_H, height: ROW_H }}>
                  <span>
                    <input type="checkbox" checked={ticked} disabled={!!r.skipped} onChange={() => toggleRow(r.path)} />
                  </span>
                  {showFolder && (
                    <span className="br-cell dim" title={r.folder}>
                      {r.folder}
                    </span>
                  )}
                  <span className="br-cell" title={r.old_name}>
                    {d.oldSegs.map((s, n) => (s.changed ? <del key={n}>{s.text}</del> : <React.Fragment key={n}>{s.text}</React.Fragment>))}
                  </span>
                  <span className="dim">→</span>
                  <span className="br-cell" title={r.new_name}>
                    {d.newSegs.map((s, n) => (s.changed ? <ins key={n}>{s.text}</ins> : <React.Fragment key={n}>{s.text}</React.Fragment>))}
                  </span>
                  <span className="br-cell status" title={r.skipped ?? (!ticked ? 'Left out: this item will not be renamed' : err ?? 'Ready')}>
                    {r.skipped ? (
                      <span className="dim">Skipped: name already taken</span>
                    ) : !ticked ? (
                      <span className="dim">Left out</span>
                    ) : err ? (
                      <>
                        <AlertTriangle size={12} /> {err}
                      </>
                    ) : (
                      <Check size={12} />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="settings-footer">
          <span className="br-note">{hint}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={renaming}>
              Cancel
            </button>
            <button className="active" onClick={doRename} disabled={!canRename} title={canRename ? 'Rename the ticked names exactly as previewed' : hint || 'Click Preview first'}>
              {renaming ? 'Renaming...' : `Rename ${tickedRows.length > 0 ? tickedRows.length + ' items' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
