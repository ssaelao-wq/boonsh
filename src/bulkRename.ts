// Types, defaults, presets and undo history for Bulk Rename (engine: src-tauri/src/bulk_rename.rs).
// The *Dto types match what Rust deserializes (snake_case, one object per rule with a "kind").

export type ApplyTo = 'name' | 'ext' | 'both';
export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence';
export type NumberPosition = 'prefix' | 'suffix' | 'replace';
export type IrMode = 'insert' | 'remove';
export type InsertWhere = 'start' | 'end' | 'position';
export type RemoveWhere = 'first' | 'last' | 'position';
export type ExtMode = 'set' | 'lower' | 'upper' | 'remove';

export type RuleDto =
  | { kind: 'find'; find: string; replace: string; regex: boolean; match_case: boolean; all_matches: boolean; apply_to: ApplyTo }
  | { kind: 'case'; mode: CaseMode; apply_to: ApplyTo }
  | {
      kind: 'insert_remove';
      mode: IrMode;
      apply_to: ApplyTo;
      text: string;
      insert_where: InsertWhere;
      remove_where: RemoveWhere;
      count: number;
      position: number;
    }
  | { kind: 'numbering'; start: number; step: number; pad: number; position: NumberPosition; separator: string; restart_per_folder: boolean }
  | { kind: 'extension'; mode: ExtMode; text: string; only_ext: string }
  | { kind: 'template'; template: string; apply_to: 'name' | 'both'; start: number; step: number; restart_per_folder: boolean };

/** What to do with an item whose new name is already taken. */
export type CollisionPolicy = 'skip' | 'block' | 'number';

export interface RenameRulesDto {
  rules: RuleDto[]; // run top to bottom, in this order
  on_collision: CollisionPolicy;
}

export interface PreviewRow {
  path: string;
  folder: string;
  old_name: string;
  new_name: string;
  is_dir: boolean;
  error: string | null;
  skipped: string | null; // set when the item is left out because its new name is already taken
}

export interface PreviewResult {
  rows: PreviewRow[]; // only names that would change (and skipped ones, so you can see them)
  total: number; // all items considered, including what is inside selected folders when sub-folders are included
  changed: number; // rows that will be renamed
  skipped: number;
  unchanged: number;
  problems: number;
}

export interface RenameOp {
  from: string;
  to: string;
}

export interface ApplyResult {
  renamed: number;
  ops: RenameOp[];
  new_paths: string[];
}

export interface UndoResult {
  restored: number;
  failed: { from: string; to: string; error: string }[];
}

// ---------------- the dialog's rules ----------------

export type RuleKind = RuleDto['kind'];

export const MAX_RULES = 30; // same limit as the engine

export const RULE_TITLES: Record<RuleKind, string> = {
  find: 'Find & Replace',
  case: 'Change case',
  insert_remove: 'Insert / Remove',
  numbering: 'Numbering',
  extension: 'Extension',
  template: 'Name template',
};

interface RuleBase {
  id: string;
  on: boolean;
}

/** One rule as the dialog edits it. Numbers stay strings so the user can clear a field while typing. */
export type RuleForm =
  | (RuleBase & { kind: 'find'; find: string; replace: string; regex: boolean; matchCase: boolean; allMatches: boolean; applyTo: ApplyTo })
  | (RuleBase & { kind: 'case'; mode: CaseMode; applyTo: ApplyTo })
  | (RuleBase & {
      kind: 'insert_remove';
      mode: IrMode;
      applyTo: ApplyTo;
      text: string;
      insertWhere: InsertWhere;
      removeWhere: RemoveWhere;
      count: string;
      position: string;
    })
  | (RuleBase & { kind: 'numbering'; start: string; step: string; pad: string; position: NumberPosition; separator: string; restart: boolean })
  | (RuleBase & { kind: 'extension'; mode: ExtMode; text: string; only: string })
  | (RuleBase & { kind: 'template'; template: string; applyTo: 'name' | 'both'; start: string; step: string; restart: boolean });

export interface RulesForm {
  rules: RuleForm[];
  onCollision: CollisionPolicy;
}

let idCounter = 0;
export const newId = () => `r${++idCounter}${Date.now().toString(36)}`;

/** A new rule with its starting values. */
export function newRule(kind: RuleKind, patch: Record<string, unknown> = {}, on = true): RuleForm {
  const base = { id: newId(), on };
  let rule: RuleForm;
  switch (kind) {
    case 'find':
      rule = { ...base, kind, find: '', replace: '', regex: false, matchCase: false, allMatches: true, applyTo: 'name' };
      break;
    case 'case':
      rule = { ...base, kind, mode: 'lower', applyTo: 'name' };
      break;
    case 'insert_remove':
      rule = { ...base, kind, mode: 'insert', applyTo: 'name', text: '', insertWhere: 'start', removeWhere: 'first', count: '1', position: '1' };
      break;
    case 'numbering':
      rule = { ...base, kind, start: '1', step: '1', pad: '2', position: 'suffix', separator: '_', restart: true };
      break;
    case 'extension':
      rule = { ...base, kind, mode: 'set', text: '', only: '' };
      break;
    case 'template':
      rule = { ...base, kind, template: '', applyTo: 'name', start: '1', step: '1', restart: true };
      break;
  }
  return { ...rule, ...patch } as RuleForm;
}

/** The dialog starts with one Find & Replace rule. */
export const defaultForm = (): RulesForm => ({ rules: [newRule('find')], onCollision: 'skip' });

const toInt = (s: string, min: number, max: number, fallback: number) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * The number fields of one rule, checked exactly as typed. A bad value gets a message; it is never changed
 * silently into another number (an earlier version turned a typed Step of 0 into 1, which gave 01, 12, 23...).
 */
function numberProblem(r: RuleForm, index: number): string | null {
  const label = `Rule ${index + 1} (${RULE_TITLES[r.kind]})`;
  const check = (name: string, value: string, min: number, max: number): string | null => {
    const v = value.trim();
    if (v === '') return `${label}: ${name} is empty. Enter a whole number from ${min} to ${max}.`;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      return `${label}: ${name} must be a whole number from ${min} to ${max}, not "${value}".`;
    }
    return null;
  };
  switch (r.kind) {
    case 'numbering':
      return check('Start', r.start, 0, 999_999_999) ?? check('Step', r.step, 0, 999_999) ?? check('Digits', r.pad, 0, 12);
    case 'insert_remove':
      return (
        (r.mode === 'remove' ? check('How many', r.count, 0, 9999) : null) ??
        ((r.mode === 'insert' ? r.insertWhere : r.removeWhere) === 'position' ? check('Number', r.position, 1, 9999) : null)
      );
    case 'template':
      return r.template.includes('{n') ? check('Start', r.start, 0, 999_999_999) ?? check('Step', r.step, 0, 999_999) : null;
    default:
      return null;
  }
}

/** The first problem with the numbers in the rules that are switched on, or null. */
export function formProblem(f: RulesForm): string | null {
  for (let i = 0; i < f.rules.length; i++) {
    if (!f.rules[i].on) continue;
    const p = numberProblem(f.rules[i], i);
    if (p) return p;
  }
  return null;
}

/** A rule becomes a DTO only if it is on and has something to do (like the engine, which skips idle rules). */
function ruleToDto(r: RuleForm): RuleDto | null {
  if (!r.on) return null;
  switch (r.kind) {
    case 'find':
      return r.find === ''
        ? null
        : { kind: 'find', find: r.find, replace: r.replace, regex: r.regex, match_case: r.matchCase, all_matches: r.allMatches, apply_to: r.applyTo };
    case 'case':
      return { kind: 'case', mode: r.mode, apply_to: r.applyTo };
    case 'insert_remove':
      // Insert needs text and Remove needs a count, otherwise the rule would do nothing
      return (r.mode === 'insert' ? r.text !== '' : toInt(r.count, 0, 9999, 0) > 0)
        ? {
            kind: 'insert_remove',
            mode: r.mode,
            apply_to: r.applyTo,
            text: r.text,
            insert_where: r.insertWhere,
            remove_where: r.removeWhere,
            count: toInt(r.count, 0, 9999, 0),
            position: toInt(r.position, 1, 9999, 1),
          }
        : null;
    case 'numbering':
      return {
        kind: 'numbering',
        start: toInt(r.start, 0, 999_999_999, 1),
        step: toInt(r.step, 0, 999_999, 1),
        pad: toInt(r.pad, 0, 12, 0),
        position: r.position,
        separator: r.separator,
        restart_per_folder: r.restart,
      };
    case 'extension':
      return r.mode !== 'set' || r.text.trim().replace(/^\.+/, '') !== '' ? { kind: 'extension', mode: r.mode, text: r.text, only_ext: r.only } : null;
    case 'template':
      return r.template.trim() === ''
        ? null
        : {
            kind: 'template',
            template: r.template,
            apply_to: r.applyTo,
            start: toInt(r.start, 0, 999_999_999, 1),
            step: toInt(r.step, 0, 999_999, 1),
            restart_per_folder: r.restart,
          };
  }
}

export function formToRules(f: RulesForm): RenameRulesDto {
  return {
    rules: f.rules.map(ruleToDto).filter((r): r is RuleDto => r !== null),
    on_collision: f.onCollision,
  };
}

/** The same rules with new ids (a preset can be applied more than once; ids must stay unique in the list). */
export const withFreshIds = (f: RulesForm): RulesForm => ({ ...f, rules: f.rules.map((r) => ({ ...r, id: newId() })) });

// ---------------- presets: named sets of rules ----------------

export interface RenamePreset {
  name: string;
  form: RulesForm;
}

const rules = (...list: RuleForm[]): RulesForm => ({ rules: list, onCollision: 'skip' });

/** Ready-made presets. They can't be deleted; "Save rules as..." with the same name is refused. */
export const BUILTIN_PRESETS: RenamePreset[] = [
  { name: 'Spaces to underscores', form: rules(newRule('find', { find: '\\s+', replace: '_', regex: true })) },
  { name: 'Remove a "(1)" suffix', form: rules(newRule('find', { find: '\\s*\\(\\d+\\)$', replace: '', regex: true })) },
  {
    name: 'Remove "(1)" suffixes, add (2), (3) if names collide',
    form: { rules: [newRule('find', { find: '\\s*\\(\\d+\\)$', replace: '', regex: true })], onCollision: 'number' },
  },
  { name: 'lower case (name and extension)', form: rules(newRule('case', { mode: 'lower', applyTo: 'both' })) },
  { name: 'Title Case (name only)', form: rules(newRule('case', { mode: 'title' })) },
  { name: 'Add a date prefix 2026_', form: rules(newRule('insert_remove', { mode: 'insert', text: '2026_', insertWhere: 'start' })) },
  { name: 'Remove the first 4 characters', form: rules(newRule('insert_remove', { mode: 'remove', removeWhere: 'first', count: '4' })) },
  { name: 'Number 001, 002... after the name', form: rules(newRule('numbering', { pad: '3', position: 'suffix', separator: '_' })) },
  { name: "File's own date in front: 2026-07-06_name", form: rules(newRule('template', { template: '{date}_{name}' })) },
  { name: 'Folder name + number: Trip_001', form: rules(newRule('template', { template: '{parent}_{n:3}' })) },
  { name: 'Extension .jpeg to .jpg', form: rules(newRule('extension', { mode: 'set', text: 'jpg', only: 'jpeg' })) },
  { name: 'Extension to lower case', form: rules(newRule('extension', { mode: 'lower' })) },
];

const PRESETS_KEY = 'boonsh_rename_presets';
export const MAX_USER_PRESETS = 30;

const KINDS: RuleKind[] = ['find', 'case', 'insert_remove', 'numbering', 'extension', 'template'];

/**
 * Turn a saved form into the current shape. Understands the first version, which had one fixed slot per
 * rule (findOn, caseOn, irOn, numOn, extOn): those become a list in the old fixed order.
 */
export function normalizeForm(raw: any): RulesForm {
  if (raw && Array.isArray(raw.rules)) {
    const list: RuleForm[] = raw.rules
      .filter((r: any) => r && KINDS.includes(r.kind))
      .map((r: any) => ({ ...newRule(r.kind as RuleKind), ...r, id: newId(), on: r.on !== false }));
    // The previous version had a yes/no "add (2), (3)" setting; "no" now means the new default, skipping
    const policy: CollisionPolicy = ['skip', 'block', 'number'].includes(raw.onCollision)
      ? raw.onCollision
      : raw.autoNumberDuplicates
      ? 'number'
      : 'skip';
    return { rules: list.slice(0, MAX_RULES), onCollision: policy };
  }
  if (raw && typeof raw === 'object' && 'findOn' in raw) {
    const list: RuleForm[] = [];
    if (raw.findOn)
      list.push(newRule('find', { find: raw.find ?? '', replace: raw.replace ?? '', regex: !!raw.regex, matchCase: !!raw.matchCase, allMatches: raw.allMatches !== false, applyTo: raw.findApplyTo ?? 'name' }));
    if (raw.caseOn) list.push(newRule('case', { mode: raw.caseMode ?? 'lower', applyTo: raw.caseApplyTo ?? 'name' }));
    if (raw.irOn)
      list.push(
        newRule('insert_remove', {
          mode: raw.irMode ?? 'insert',
          applyTo: raw.irApplyTo ?? 'name',
          text: raw.irText ?? '',
          insertWhere: raw.irInsertWhere ?? 'start',
          removeWhere: raw.irRemoveWhere ?? 'first',
          count: raw.irCount ?? '1',
          position: raw.irPosition ?? '1',
        })
      );
    if (raw.numOn)
      list.push(
        newRule('numbering', {
          start: raw.numStart ?? '1',
          step: raw.numStep ?? '1',
          pad: raw.numPad ?? '2',
          position: raw.numPosition ?? 'suffix',
          separator: raw.numSeparator ?? '_',
          restart: raw.numRestart !== false,
        })
      );
    if (raw.extOn) list.push(newRule('extension', { mode: raw.extMode ?? 'set', text: raw.extText ?? '', only: raw.extOnly ?? '' }));
    return { rules: list, onCollision: 'skip' };
  }
  return defaultForm();
}

export function loadUserPresets(): RenamePreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.name === 'string' && p.form && typeof p.form === 'object')
      .map((p) => ({ name: p.name, form: normalizeForm(p.form) }))
      .slice(0, MAX_USER_PRESETS);
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: RenamePreset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets.slice(0, MAX_USER_PRESETS)));
  } catch {
    // Storage unavailable: presets last until the app is closed
  }
}

// ---------------- highlighting what changed ----------------

export interface DiffSeg {
  text: string;
  changed: boolean;
}

/**
 * Compare an old and a new name character by character (longest common subsequence), so every changed spot
 * is marked, not just everything between the first and last difference. `oldSegs` marks what was removed,
 * `newSegs` what was added; the unmarked text is the same in both.
 */
export function diffSegments(a: string, b: string): { oldSegs: DiffSeg[]; newSegs: DiffSeg[] } {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = A.length;
  const m = B.length;
  const oldSegs: DiffSeg[] = [];
  const newSegs: DiffSeg[] = [];
  const push = (segs: DiffSeg[], ch: string, changed: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += ch;
    else segs.push({ text: ch, changed });
  };

  if (n * m > 250_000) {
    // Very long names: just trim the common start and end
    let p = 0;
    while (p < n && p < m && A[p] === B[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
    for (let i = 0; i < n; i++) push(oldSegs, A[i], i >= p && i < n - s);
    for (let j = 0; j < m; j++) push(newSegs, B[j], j >= p && j < m - s);
    return { oldSegs, newSegs };
  }

  // dp[i][j] = length of the longest common subsequence of A[i..] and B[j..]
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      push(oldSegs, A[i], false);
      push(newSegs, B[j], false);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      push(newSegs, B[j], true); // added
      j++;
    } else {
      push(oldSegs, A[i], true); // removed
      i++;
    }
  }
  return { oldSegs, newSegs };
}

// ---------------- Undo history: the last few batches, kept across restarts ----------------

export interface RenameBatch {
  id: string;
  time: number;
  count: number; // items renamed
  ops: RenameOp[]; // executed single renames (see bulk_rename.rs)
}

const HISTORY_KEY = 'boonsh_rename_history';
export const MAX_BATCHES = 5;
const MAX_STORED_BYTES = 2_000_000; // stay well under the browser's storage limit

export function loadRenameHistory(): RenameBatch[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b) => b && typeof b.id === 'string' && Array.isArray(b.ops))
      .slice(0, MAX_BATCHES);
  } catch {
    return [];
  }
}

/** Newest first. Drops the oldest batches if the stored size would get too big. */
export function saveRenameHistory(history: RenameBatch[]) {
  try {
    let list = history.slice(0, MAX_BATCHES);
    let json = JSON.stringify(list);
    while (json.length > MAX_STORED_BYTES && list.length > 1) {
      list = list.slice(0, -1);
      json = JSON.stringify(list);
    }
    localStorage.setItem(HISTORY_KEY, json.length > MAX_STORED_BYTES ? '[]' : json);
  } catch {
    // Storage unavailable: undo still works until the app is closed
  }
}

// ---------------- rules written by the AI Assistant ----------------

const DTO_FIELD: Record<string, string> = {
  match_case: 'matchCase',
  all_matches: 'allMatches',
  apply_to: 'applyTo',
  insert_where: 'insertWhere',
  remove_where: 'removeWhere',
  restart_per_folder: 'restart',
  only_ext: 'only',
};

/**
 * Rules in the engine's wire shape (RuleDto, snake_case, numbers as numbers) turned into the dialog's form.
 * Used for rules the AI Assistant writes: unknown kinds and fields are dropped, missing fields get the dialog's
 * starting values, so the user always sees a valid form to check before Preview / Rename.
 */
export function dtoToForm(raw: { rules?: unknown; on_collision?: unknown }): RulesForm {
  const list: RuleForm[] = [];
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!r || typeof r !== 'object' || !KINDS.includes((r as any).kind)) continue;
    const kind = (r as any).kind as RuleKind;
    const base = newRule(kind) as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const key = DTO_FIELD[k] ?? k;
      if (key === 'kind' || key === 'id' || key === 'on' || !(key in base) || v === null || v === undefined) continue;
      // the form keeps numbers as text (the user may clear a field while typing)
      patch[key] = typeof base[key] === 'string' && typeof v === 'number' ? String(v) : v;
      if (typeof patch[key] !== typeof base[key]) delete patch[key];
    }
    list.push(newRule(kind, patch));
  }
  const policy = ['skip', 'block', 'number'].includes(raw.on_collision as string) ? (raw.on_collision as CollisionPolicy) : 'skip';
  return { rules: (list.length ? list : [newRule('find')]).slice(0, MAX_RULES), onCollision: policy };
}
