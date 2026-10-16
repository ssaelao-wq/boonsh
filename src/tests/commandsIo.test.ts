import { describe, expect, it } from 'vitest';
import { importMessage, mergeImport, parseCsv, parseImport, toCsv, toJson } from '../commandsIo';
import type { CommandItem } from '../commands';

const item = (name: string, insertText: string, hotkey?: string): CommandItem => ({
  id: name,
  name,
  insertText,
  description: 'd',
  usage: '',
  hotkey,
});

describe('CSV', () => {
  it('follows RFC 4180 quotes, doubled quotes and line breaks', () => {
    expect(parseCsv('a,"b,c","say ""hi""","x\r\ny"\r\n1,2,3,4\n')).toEqual([
      ['a', 'b,c', 'say "hi"', 'x\r\ny'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('round-trips, keeping a trailing space and Thai text', () => {
    const items = [item('ls', 'Get-ChildItem '), item('ไทย', 'echo "สวัสดี, โลก"')];
    const csv = toCsv(items);
    expect(csv.startsWith('﻿')).toBe(true);
    const back = parseImport(csv, 'cmds.csv');
    expect(back.map((c) => [c.name, c.insertText])).toEqual([
      ['ls', 'Get-ChildItem '],
      ['ไทย', 'echo "สวัสดี, โลก"'],
    ]);
  });

  it('matches columns by header name', () => {
    const back = parseImport('Command,Terminal Text\nping,ping -t \n', 'x.csv');
    expect(back[0]).toMatchObject({ name: 'ping', insertText: 'ping -t ' });
  });
});

describe('JSON', () => {
  it('round-trips a group', () => {
    const json = toJson('Network', [item('ping', 'ping ', 'Ctrl+Alt+P')]);
    expect(JSON.parse(json)).toMatchObject({ format: 'boonsh-commands', version: 1, group: 'Network' });
    expect(parseImport(json, 'g.json')[0]).toMatchObject({ name: 'ping', insertText: 'ping ', hotkey: 'Ctrl+Alt+P' });
  });

  it('is recognised without an extension and rejects broken files', () => {
    expect(parseImport('[{"name":"a","insertText":"b"}]', 'noext')).toHaveLength(1);
    expect(() => parseImport('{ broken', 'x.json')).toThrow('not valid JSON');
  });
});

describe('mergeImport', () => {
  it('skips duplicates and nameless rows, and drops used or invalid hot keys', () => {
    let n = 0;
    const r = mergeImport(
      [item('ls', 'Get-ChildItem ')],
      [
        { name: 'LS', insertText: 'Get-ChildItem ', description: '', usage: '', hotkey: '' },
        { name: '', insertText: 'x', description: '', usage: '', hotkey: '' },
        { name: 'a', insertText: 'a', description: '', usage: '', hotkey: 'Ctrl+Alt+K' },
        { name: 'b', insertText: 'b', description: '', usage: '', hotkey: 'Ctrl+K' },
      ],
      new Set(['Ctrl+Alt+K']),
      () => `new${++n}`
    );
    expect([r.added, r.duplicates, r.invalid, r.hotkeysDropped]).toEqual([2, 1, 1, 2]);
    expect(r.items.map((i) => i.id)).toEqual(['ls', 'new1', 'new2']);
    expect(importMessage(r)).toBe(
      'Imported 2 commands. Skipped 1 duplicate (already in the group). Skipped 1 row without a name or terminal text. 2 hot keys not kept (not valid or already used).'
    );
  });
});
