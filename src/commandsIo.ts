// Import / export of one command group, as JSON or CSV. Pure functions (no React, no Tauri) so they are easy to test.
//
// JSON is the main format: it keeps every character exactly (commas, quotes, line breaks, Thai text), names the group
// and carries a version, so the file can grow later. CSV is there for editing in Excel / Sheets: one row per command,
// with a header row.

import type { CommandItem } from './commands';
import { isHotkey } from './hotkey';

export const FORMAT_NAME = 'boonsh-commands';
export const FORMAT_VERSION = 1;

export type ExportFormat = 'json' | 'csv';

// A command as written in a file (no id: ids are made on import)
export interface FileCommand {
  name: string;
  insertText: string;
  description: string;
  usage: string;
  hotkey: string;
}

const COLUMNS: (keyof FileCommand)[] = ['name', 'insertText', 'description', 'usage', 'hotkey'];

const toFile = (i: CommandItem): FileCommand => ({
  name: i.name,
  insertText: i.insertText,
  description: i.description,
  usage: i.usage,
  hotkey: i.hotkey ?? '',
});

export function toJson(group: string, items: CommandItem[]): string {
  return JSON.stringify({ format: FORMAT_NAME, version: FORMAT_VERSION, group, commands: items.map(toFile) }, null, 2) + '\n';
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// Starts with a BOM so Excel reads the UTF-8 (Thai) text correctly; rows end with CRLF.
export function toCsv(items: CommandItem[]): string {
  const rows = [COLUMNS.join(','), ...items.map((i) => COLUMNS.map((c) => csvCell(toFile(i)[c])).join(','))];
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// Splits CSV text into rows of cells: quotes, doubled quotes and line breaks inside quotes follow RFC 4180.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const ALIASES: Record<keyof FileCommand, string[]> = {
  name: ['name', 'command', 'commandname'],
  insertText: ['inserttext', 'terminaltext', 'text', 'commandtext'],
  description: ['description', 'desc'],
  usage: ['usage', 'usageexample', 'example'],
  hotkey: ['hotkey', 'shortcut', 'key'],
};

function fromCsv(text: string): FileCommand[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('The CSV file is empty.');
  const head = rows[0].map(norm);
  const col = {} as Record<keyof FileCommand, number>;
  for (const c of COLUMNS) col[c] = head.findIndex((h) => ALIASES[c].includes(h));
  if (col.name < 0) throw new Error('The CSV file needs a header row with a "name" column (and normally "insertText").');
  const get = (r: string[], c: keyof FileCommand) => (col[c] >= 0 ? (r[col[c]] ?? '').trim() : '');
  return rows.slice(1).map((r) => ({
    name: get(r, 'name'),
    insertText: col.insertText >= 0 ? (r[col.insertText] ?? '').replace(/^\s+/, '') : get(r, 'name'), // keeps a trailing space
    description: get(r, 'description'),
    usage: get(r, 'usage'),
    hotkey: get(r, 'hotkey'),
  }));
}

function fromJson(text: string): FileCommand[] {
  let data: any;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.commands) ? data.commands : null;
  if (!list) throw new Error('The JSON file has no "commands" list.');
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return list
    .filter((c: any) => c && typeof c === 'object')
    .map((c: any) => ({
      name: s(c.name),
      insertText: typeof c.insertText === 'string' ? c.insertText.replace(/^\s+/, '') : s(c.name),
      description: s(c.description),
      usage: s(c.usage),
      hotkey: s(c.hotkey),
    }));
}

// Reads a file's text. The format comes from the file name's extension; without a known one it is guessed from the
// first character ({ or [ = JSON).
export function parseImport(text: string, fileName: string): FileCommand[] {
  const ext = fileName.toLowerCase().split('.').pop();
  const json = ext === 'json' || (ext !== 'csv' && /^\s*[{[]/.test(text.replace(/^﻿/, '')));
  return json ? fromJson(text) : fromCsv(text);
}

export interface MergeResult {
  items: CommandItem[]; // the group's commands after the import
  added: number;
  duplicates: number; // skipped: the group already has a command with the same name and text
  invalid: number; // skipped: no name or no terminal text
  hotkeysDropped: number; // imported without their hot key (invalid, or already used by another command)
}

// Adds the file's commands to a group. `usedHotkeys` are the hot keys of every command of every group.
export function mergeImport(
  existing: CommandItem[],
  incoming: FileCommand[],
  usedHotkeys: Set<string>,
  newId: () => string
): MergeResult {
  const items = [...existing];
  const seen = new Set(existing.map((i) => `${i.name.toLowerCase()}\u0000${i.insertText}`));
  const used = new Set(usedHotkeys);
  let added = 0;
  let duplicates = 0;
  let invalid = 0;
  let hotkeysDropped = 0;
  for (const c of incoming) {
    if (!c.name || !c.insertText) {
      invalid++;
      continue;
    }
    const key = `${c.name.toLowerCase()}\u0000${c.insertText}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    let hotkey: string | undefined;
    if (c.hotkey) {
      if (isHotkey(c.hotkey) && !used.has(c.hotkey)) {
        hotkey = c.hotkey;
        used.add(c.hotkey);
      } else {
        hotkeysDropped++;
      }
    }
    items.push({ id: newId(), name: c.name, insertText: c.insertText, description: c.description, usage: c.usage, hotkey });
    added++;
  }
  return { items, added, duplicates, invalid, hotkeysDropped };
}

// "Imported 3 commands. Skipped 1 duplicate ..." for the Settings message line
export function importMessage(r: MergeResult): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [`Imported ${plural(r.added, 'command')}.`];
  if (r.duplicates) parts.push(`Skipped ${plural(r.duplicates, 'duplicate')} (already in the group).`);
  if (r.invalid) parts.push(`Skipped ${plural(r.invalid, 'row')} without a name or terminal text.`);
  if (r.hotkeysDropped) parts.push(`${plural(r.hotkeysDropped, 'hot key')} not kept (not valid or already used).`);
  return parts.join(' ');
}
