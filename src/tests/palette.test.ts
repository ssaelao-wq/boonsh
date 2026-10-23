import { describe, expect, it } from 'vitest';
import { PaletteItem, highlightRuns, matchToken, pathFromQuery, pushRecent, rankItems, splitPrefix } from '../palette';

const item = (id: string, title: string, kind: PaletteItem['kind'] = 'action', extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  title,
  kind,
  run: () => {},
  ...extra,
});

const items = [
  item('a1', 'Toggle preview drawer', 'action', { shortcut: 'Ctrl+P' }),
  item('a2', 'Two file panes: on / off', 'action'),
  item('a3', 'Switch to light theme', 'action', { keywords: 'dark white black colour' }),
  item('a4', 'Refresh the folder', 'action', { shortcut: 'Ctrl+R' }),
  item('c1', 'ipconfig', 'command', { detail: 'Network: ipconfig /all' }),
  item('c2', 'Ping a host', 'command', { detail: 'Network: ping ' }),
  item('v1', 'Type {SELEC} at the prompt', 'var'),
  item('q1', 'Downloads', 'quick', { detail: 'C:\\Users\\me\\Downloads' }),
  item('r1', 'Invoices 2026', 'recent', { detail: 'D:\\Work\\Invoices 2026' }),
];

describe('matching one word', () => {
  it('prefers a substring at the start of a word', () => {
    const start = matchToken('prev', 'Toggle preview drawer')!;
    expect(start.hits).toEqual([7, 8, 9, 10]);
    expect(matchToken('view', 'Toggle preview drawer')!.score).toBeLessThan(start.score);
  });
  it('matches letters in order and likes word starts', () => {
    const m = matchToken('tfp', 'Two file panes: on / off')!;
    expect(m.hits).toEqual([0, 4, 9]);
    expect(matchToken('xyz', 'Two file panes')).toBeNull();
  });
  it('ranks the word itself above letters spread over other words', () => {
    const list = [
      item('split', 'Split the command line Left-Right'),
      item('theme', 'Switch to the light theme'),
    ];
    expect(rankItems(list, 'light theme')[0].item.id).toBe('theme');
    expect(rankItems(list, '> light')[0].item.id).toBe('theme');
    expect(matchToken('light', 'Split the command line Left-Right')!.score).toBeLessThan(100);
  });
  it('ignores case', () => {
    expect(matchToken('ipc', 'IPConfig')!.hits).toEqual([0, 1, 2]);
  });
});

describe('ranking', () => {
  it('finds by initials and puts the best first', () => {
    expect(rankItems(items, 'tfp')[0].item.id).toBe('a2');
    expect(rankItems(items, 'prev')[0].item.id).toBe('a1');
  });
  it('needs every word, in the title, detail or keywords', () => {
    expect(rankItems(items, 'theme dark').map((r) => r.item.id)).toEqual(['a3']);
    expect(rankItems(items, 'ping all')).toEqual([]);
    expect(rankItems(items, 'invoices work')[0].item.id).toBe('r1');
  });
  it('filters by a leading character', () => {
    expect(rankItems(items, '>').every((r) => r.item.kind === 'action')).toBe(true);
    expect(rankItems(items, '$ ip').map((r) => r.item.id)).toEqual(['c1']);
    expect(rankItems(items, '$ ping').map((r) => r.item.id)).toEqual(['c2']);

    expect(rankItems(items, '{SELEC}').map((r) => r.item.id)).toEqual(['v1']);
    expect(rankItems(items, '/ down').map((r) => r.item.id)).toEqual(['q1']);
    expect(splitPrefix('  > refresh ')).toEqual({ kinds: ['action'], text: 'refresh' });
  });
  it('lists the recently picked first when nothing is typed, and boosts them when something is', () => {
    expect(rankItems(items, '', ['c2', 'a4']).slice(0, 3).map((r) => r.item.id)).toEqual(['c2', 'a4', 'a1']);
    // two equally good matches: the one picked lately comes first
    const twins = [item('x', 'Open folder Alpha'), item('y', 'Open folder Alpha')];
    expect(rankItems(twins, 'alpha').map((r) => r.item.id)).toEqual(['x', 'y']);
    expect(rankItems(twins, 'alpha', ['y']).map((r) => r.item.id)).toEqual(['y', 'x']);
  });
  it('keeps the newest pick first and no duplicates', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });
});

describe('highlighting', () => {
  it('splits into runs', () => {
    expect(highlightRuns('Refresh', [0, 1, 4])).toEqual([
      { text: 'Re', hit: true },
      { text: 'fr', hit: false },
      { text: 'e', hit: true },
      { text: 'sh', hit: false },
    ]);
  });
});

describe('a typed path', () => {
  const cwd = 'C:\\Work\\Project';
  it('takes absolute and network paths', () => {
    expect(pathFromQuery('D:\\Backup\\', cwd)).toBe('D:\\Backup');
    expect(pathFromQuery('d:', cwd)).toBe('d:\\');
    expect(pathFromQuery('"C:/Program Files"', cwd)).toBe('C:\\Program Files');
    expect(pathFromQuery('\\\\server\\share', cwd)).toBe('\\\\server\\share');
  });
  it('resolves relative paths against the folder', () => {
    expect(pathFromQuery('..', cwd)).toBe('C:\\Work');
    expect(pathFromQuery('.\\src\\..\\docs', cwd)).toBe('C:\\Work\\Project\\docs');
    expect(pathFromQuery('..\\..\\..', cwd)).toBe('C:\\');
  });
  it('is null for ordinary words', () => {
    expect(pathFromQuery('refresh', cwd)).toBeNull();
    expect(pathFromQuery('', cwd)).toBeNull();
  });
});
