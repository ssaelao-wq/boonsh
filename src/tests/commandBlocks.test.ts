import { describe, expect, it } from 'vitest';
import { blockAt, blockTooltip, formatDuration, isBarePrompt, jumpTarget, lineSent, onLineSent, parseCommandEnd } from '../commandBlocks';

describe('parseCommandEnd', () => {
  it('reads the exit code and the time', () => {
    expect(parseCommandEnd('D;0;1234')).toEqual({ ran: true, code: 0, ms: 1234 });
    expect(parseCommandEnd('D;3;20')).toEqual({ ran: true, code: 3, ms: 20 });
  });
  it('a bare D means nothing ran', () => {
    expect(parseCommandEnd('D')).toEqual({ ran: false });
    expect(parseCommandEnd('D;')).toEqual({ ran: false });
  });
  it('a missing time still gives a result; - is a PowerShell error with no exit code', () => {
    expect(parseCommandEnd('D;1')).toEqual({ ran: true, code: 1, ms: null });
    expect(parseCommandEnd('D;-;5')).toEqual({ ran: true, code: null, ms: 5 });
  });
  it('other OSC 133 reports are not ours', () => {
    expect(parseCommandEnd('A')).toBeNull();
    expect(parseCommandEnd('C')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('scales the unit', () => {
    expect(formatDuration(40)).toBe('0.0 s');
    expect(formatDuration(1234)).toBe('1.2 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(3_720_000)).toBe('1 h 02 min');
  });
});

describe('blockTooltip', () => {
  const at = new Date(2026, 9, 25, 14, 32, 5);
  it('says how it ended', () => {
    expect(blockTooltip('ok', at, 0, 1200)).toMatch(/^Worked · took 1\.2 s · started /);
    expect(blockTooltip('failed', at, 3, null)).toMatch(/^Failed \(exit code 3\) · started /);
    expect(blockTooltip('failed', at, null, 80)).toMatch(/^Failed \(PowerShell error\) · took 0\.1 s/);
    expect(blockTooltip('running', at)).toMatch(/^Running \(started /);
    expect(blockTooltip('done', at, undefined, 500)).toMatch(/^Finished · took 0\.5 s/);
  });
});

describe('jumpTarget', () => {
  const lines = [0, 10, 25, 40];
  it('Up goes to the command above the top line', () => {
    expect(jumpTarget(lines, 30, 'up')).toBe(25);
    expect(jumpTarget(lines, 25, 'up')).toBe(10); // already at one: the one before
    expect(jumpTarget(lines, 0, 'up')).toBe(0); // the first stays
  });
  it('Down goes to the command below the top line, or the bottom', () => {
    expect(jumpTarget(lines, 10, 'down')).toBe(25);
    expect(jumpTarget(lines, 40, 'down')).toBeNull();
  });
  it('no commands', () => {
    expect(jumpTarget([], 5, 'up')).toBeNull();
    expect(jumpTarget([], 5, 'down')).toBeNull();
  });
});

describe('blockAt', () => {
  it('finds the block that holds a line', () => {
    expect(blockAt([3, 10, 25], 2)).toBe(-1);
    expect(blockAt([3, 10, 25], 3)).toBe(0);
    expect(blockAt([3, 10, 25], 24)).toBe(1);
    expect(blockAt([3, 10, 25], 99)).toBe(2);
  });
});

describe('isBarePrompt', () => {
  it('a prompt with nothing typed', () => {
    expect(isBarePrompt('admin > ')).toBe(true);
    expect(isBarePrompt('John Smith > ')).toBe(true);
    expect(isBarePrompt('Surface >')).toBe(true); // cmd
  });
  it('not a command line or output', () => {
    expect(isBarePrompt('admin > dir')).toBe(false);
    expect(isBarePrompt('one')).toBe(false);
    expect(isBarePrompt('')).toBe(false);
  });
});

describe('lineSent', () => {
  it('reaches the listener, and nothing once it is gone', () => {
    const got: string[] = [];
    onLineSent((id) => got.push(id));
    lineSent('tab1');
    onLineSent(null);
    lineSent('tab2');
    expect(got).toEqual(['tab1']);
  });
});
