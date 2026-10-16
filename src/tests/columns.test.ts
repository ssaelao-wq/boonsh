import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, SortLevel, compareItems, sortClick, sortRemove, sortSet } from '../columns';
import { isoWeek, layoutItems, toggleBucket } from '../grouping';
import { hotkeyFromEvent, isHotkey, validateHotkey } from '../hotkey';
import { defaultQuickAccess, parseSaved, samePath } from '../quickAccess';
import type { FileItem } from '../types';

const file = (name: string, p: Partial<FileItem> = {}): FileItem => ({
  name,
  path: `C:\\x\\${name}`,
  is_dir: false,
  size: 0,
  size_formatted: '',
  modified: '2026-05-10 10:00',
  modified_timestamp: 0,
  created: '2026-05-10 10:00',
  created_timestamp: 0,
  ext: name.includes('.') ? name.split('.').pop()! : '',
  is_hidden: false,
  ...p,
});

describe('smart sort', () => {
  const byName: SortLevel[] = [{ column: 'name', order: 'asc' }];
  it('a plain click sorts by one column and flips on the second click', () => {
    expect(sortClick(byName, 'size', false)).toEqual([{ column: 'size', order: 'asc' }]);
    expect(sortClick(byName, 'name', false)).toEqual([{ column: 'name', order: 'desc' }]);
  });
  it('Shift/Ctrl+click adds, flips, then removes a level', () => {
    const two = sortClick(byName, 'size', true);
    expect(two).toEqual([...byName, { column: 'size', order: 'asc' }]);
    const flipped = sortClick(two, 'size', true);
    expect(flipped[1].order).toBe('desc');
    expect(sortClick(flipped, 'size', true)).toEqual(byName);
  });
  it('the header menu sets or removes a level; nothing left falls back to the name', () => {
    expect(sortSet(byName, 'size', 'desc', 'then')).toEqual([...byName, { column: 'size', order: 'desc' }]);
    expect(sortSet(byName, 'size', 'desc', 'only')).toEqual([{ column: 'size', order: 'desc' }]);
    expect(sortRemove([{ column: 'size', order: 'asc' }], 'size')).toEqual(byName);
  });
  it('puts folders first and sorts names with numbers naturally', () => {
    const items = [file('file10.txt'), file('file2.txt'), file('Zed', { is_dir: true })];
    const sorted = [...items].sort((a, b) => compareItems(a, b, byName, { ...DEFAULT_PREFS, foldersFirst: true }, {}));
    expect(sorted.map((i) => i.name)).toEqual(['Zed', 'file2.txt', 'file10.txt']);
  });
});

describe('group view', () => {
  it('date parts add up in tick order; relative replaces them', () => {
    expect(toggleBucket('modified', ['year'], 'month')).toEqual(['year', 'month']);
    expect(toggleBucket('modified', ['year', 'month'], 'year')).toEqual(['month']);
    expect(toggleBucket('modified', ['year'], 'relative')).toEqual(['relative']);
    expect(toggleBucket('ext', ['category'], 'category')).toEqual([]);
  });
  it('uses ISO weeks (a week belongs to the year of its Thursday)', () => {
    expect(isoWeek(2026, 1, 1)).toEqual([2026, 1]);
    expect(isoWeek(2027, 1, 1)).toEqual([2026, 53]);
    expect(isoWeek(2024, 12, 30)).toEqual([2025, 1]);
  });
  it('makes one header per group and hides collapsed items', () => {
    const items = [file('a.txt'), file('b.png'), file('c.txt')];
    const groups = [{ column: 'ext' as const, buckets: ['extension' as const] }];
    const levels: SortLevel[] = [{ column: 'ext', order: 'asc' }];
    const open = layoutItems(items, groups, levels, DEFAULT_PREFS, {}, new Set());
    expect(open.rows.filter((r) => r.kind === 'group').map((r) => (r.kind === 'group' ? r.labels[0] : ''))).toEqual(['PNG', 'TXT']);
    const folded = layoutItems(items, groups, levels, DEFAULT_PREFS, {}, new Set(['e.txt']));
    expect(folded.flat.map((i) => i.name)).toEqual(['b.png']);
  });
});

describe('hot keys and Quick Access', () => {
  it('only Ctrl+Alt plus a letter, digit or F-key', () => {
    expect(isHotkey('Ctrl+Alt+K')).toBe(true);
    expect(isHotkey('Ctrl+K')).toBe(false);
    const ev = (code: string, shift = false) => ({ ctrlKey: true, altKey: true, shiftKey: shift, metaKey: false, code }) as KeyboardEvent;
    expect(hotkeyFromEvent(ev('KeyK'))).toBe('Ctrl+Alt+K');
    expect(hotkeyFromEvent(ev('F12'))).toBe('Ctrl+Alt+F12');
    expect(hotkeyFromEvent(ev('KeyK', true))).toBeNull();
    const groups = [{ id: 'g', name: 'G', items: [{ id: '1', name: 'one', insertText: 'x', description: '', usage: '', hotkey: 'Ctrl+Alt+K' }] }];
    expect(validateHotkey('Ctrl+Alt+K', groups as never, '2')).toContain('already used by "one"');
    expect(validateHotkey('Ctrl+Alt+K', groups as never, '1')).toBe('');
  });
  it('compares paths without case or a trailing slash, and keeps a saved empty list', () => {
    expect(samePath('C:\\Users\\', 'c:\\users')).toBe(true);
    expect(parseSaved('[]')).toEqual([]);
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved('nonsense')).toBeNull();
    const all = [
      { label: 'Home', path: 'C:\\Users\\me', icon_type: 'home' },
      { label: 'D:', path: 'D:\\', icon_type: 'drive' },
      { label: 'C:', path: 'C:\\', icon_type: 'drive' },
    ];
    expect(defaultQuickAccess(all).map((i) => i.label)).toEqual(['Home', 'C:']);
  });
});
