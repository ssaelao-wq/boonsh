import { describe, expect, it } from 'vitest';
import {
  Clash,
  PasteProgress,
  SpeedSample,
  addSample,
  fillChoices,
  formatEta,
  keepBothName,
  progressFraction,
  progressText,
  speedOf,
} from '../paste';

const clash = (source: string): Clash => ({
  source,
  target: `D:\\out\\${source.split('\\').pop()}`,
  name: source.split('\\').pop()!,
  source_is_dir: false,
  target_is_dir: false,
  source_size: 1,
  target_size: 2,
  source_modified: 0,
  target_modified: 0,
  in_paste: false,
});

const progress = (p: Partial<PasteProgress>): PasteProgress => ({
  job: 1,
  phase: 'copy',
  ahead: 0,
  done_bytes: 0,
  total_bytes: 0,
  done_items: 0,
  total_items: 0,
  current: '',
  ...p,
});

describe('keepBothName', () => {
  it('numbers the name part, from -02', () => {
    expect(keepBothName('readme.txt', false)).toBe('readme-02.txt');
    expect(keepBothName('readme.txt', false, 3)).toBe('readme-03.txt');
    expect(keepBothName('archive.tar.gz', false)).toBe('archive.tar-02.gz');
  });
  it('keeps a folder name whole and handles names without an extension', () => {
    expect(keepBothName('Photos.2024', true)).toBe('Photos.2024-02');
    expect(keepBothName('Makefile', false)).toBe('Makefile-02');
    expect(keepBothName('.gitignore', false)).toBe('.gitignore-02');
  });
});

describe('fillChoices', () => {
  const list = [clash('C:\\a\\1.txt'), clash('C:\\a\\2.txt'), clash('C:\\a\\3.txt')];
  it('uses the answers one by one, then the "for all" choice', () => {
    expect(fillChoices(list, ['skip'], 'replace')).toEqual({
      'C:\\a\\1.txt': 'skip',
      'C:\\a\\2.txt': 'replace',
      'C:\\a\\3.txt': 'replace',
    });
  });
  it('leaves unanswered clashes out when there is no "for all" choice', () => {
    expect(fillChoices(list, ['keep', 'skip'], null)).toEqual({ 'C:\\a\\1.txt': 'keep', 'C:\\a\\2.txt': 'skip' });
  });
});

describe('progress', () => {
  it('has no bar length while measuring', () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction(progress({ phase: 'count' }))).toBeNull();
    expect(progressText(progress({ phase: 'count' }), null)).toBe('Measuring what to copy…');
    expect(progressFraction(progress({ phase: 'queued', ahead: 2 }))).toBeNull();
  });
  it('tells a waiting paste how many are before it', () => {
    expect(progressText(progress({ phase: 'queued', ahead: 1 }), null)).toBe('Waiting: 1 paste before this one');
    expect(progressText(progress({ phase: 'queued', ahead: 3 }), null)).toBe('Waiting: 3 pastes before this one');
  });
  it('shows Paused instead of the speed', () => {
    const p = progress({ done_bytes: 1024 * 1024, total_bytes: 4 * 1024 * 1024 });
    expect(progressText(p, 1000, true)).toBe('1.0 MB of 4.0 MB · Paused');
  });
  it('measures the speed over the last seconds only', () => {
    let s: SpeedSample[] = [];
    s = addSample(s, { t: 0, bytes: 0 });
    expect(speedOf(s)).toBeNull();
    s = addSample(s, { t: 500, bytes: 50 });
    expect(speedOf(s)).toBeNull(); // under a second
    s = addSample(s, { t: 1000, bytes: 100 });
    expect(speedOf(s)).toBe(100);
    // slow down: the fast start drops out of the window
    s = addSample(s, { t: 6000, bytes: 110 });
    s = addSample(s, { t: 7000, bytes: 120 });
    expect(s[0].t).toBe(1000);
    expect(speedOf(s)).toBe(3.3333333333333335);
    s = addSample(s, { t: 12000, bytes: 170 });
    expect(s.map((x) => x.t)).toEqual([7000, 12000]);
    expect(speedOf(s)).toBe(10);
  });
  it('goes by bytes, else by items', () => {
    expect(progressFraction(progress({ done_bytes: 25, total_bytes: 100 }))).toBe(0.25);
    expect(progressFraction(progress({ done_items: 1, total_items: 4 }))).toBe(0.25);
    expect(progressFraction(progress({ phase: 'done' }))).toBe(1);
  });
  it('shows bytes, speed and time left', () => {
    const p = progress({ done_bytes: 10 * 1024 * 1024, total_bytes: 40 * 1024 * 1024, total_items: 2 });
    expect(progressText(p, 5 * 1024 * 1024)).toBe('10.0 MB of 40.0 MB · 5.0 MB/s · about 6 s left');
    expect(progressText(progress({ done_items: 1, total_items: 3 }), 5)).toBe('1 of 3 items');
  });
  it('rounds the time left', () => {
    expect(formatEta(42.3)).toBe('about 43 s left');
    expect(formatEta(59.2)).toBe('about 1 min left');
    expect(formatEta(150)).toBe('about 3 min left');
    expect(formatEta(4800)).toBe('about 1 h 20 min left');
    expect(formatEta(Infinity)).toBe('');
  });
});
