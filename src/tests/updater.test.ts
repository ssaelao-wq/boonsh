import { describe, expect, it } from 'vitest';
import { CHECK_EVERY_MS, downloadPercent, shouldAutoCheck, shouldNotify } from '../updater';

describe('shouldAutoCheck', () => {
  const now = 1_800_000_000_000;
  it('checks once a day while it is on', () => {
    expect(shouldAutoCheck(now, 0, true)).toBe(true);
    expect(shouldAutoCheck(now, now - CHECK_EVERY_MS + 1000, true)).toBe(false);
    expect(shouldAutoCheck(now, now - CHECK_EVERY_MS, true)).toBe(true);
  });
  it('never checks when it is off', () => {
    expect(shouldAutoCheck(now, 0, false)).toBe(false);
  });
  it('checks again when the last check is in the future (clock changed)', () => {
    expect(shouldAutoCheck(now, now + 60_000, true)).toBe(true);
  });
});

describe('shouldNotify / downloadPercent', () => {
  it('stays quiet about a version the user put off', () => {
    expect(shouldNotify('0.10.5', '')).toBe(true);
    expect(shouldNotify('0.10.5', '0.10.5')).toBe(false);
    expect(shouldNotify('0.10.6', '0.10.5')).toBe(true);
  });
  it('shows a percentage only when the size is known', () => {
    expect(downloadPercent(50, 200)).toBe('25%');
    expect(downloadPercent(300, 200)).toBe('100%');
    expect(downloadPercent(50, undefined)).toBe('');
  });
});
