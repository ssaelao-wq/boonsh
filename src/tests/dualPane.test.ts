import { describe, expect, it } from 'vitest';
import { clampRatio, otherSide, parseDual, sameFolder, transferProblem, transferQuestion } from '../dualPane';

describe('saved two-pane settings', () => {
  it('falls back to off, no folder, half and half', () => {
    expect(parseDual(null)).toEqual({ on: false, path: '', ratio: 0.5 });
    expect(parseDual('not json')).toEqual({ on: false, path: '', ratio: 0.5 });
  });
  it('reads a saved value and keeps the ratio in range', () => {
    expect(parseDual('{"on":true,"path":"D:\\\\x","ratio":0.95}')).toEqual({ on: true, path: 'D:\\x', ratio: 0.8 });
    expect(clampRatio(0.05)).toBe(0.2);
  });
});

describe('copy / move between the panes', () => {
  const from = 'C:\\Work';
  it('names the side across', () => {
    expect(otherSide('left')).toBe('right');
    expect(otherSide('right')).toBe('left');
  });
  it('compares folders ignoring case and a trailing slash', () => {
    expect(sameFolder('C:\\Work\\', 'c:\\work')).toBe(true);
    expect(sameFolder('C:\\Work', 'C:\\Work2')).toBe(false);
  });
  it('needs a selection and another folder', () => {
    expect(transferProblem([], from, 'D:\\', false)).toBe('Select the items to copy first.');
    expect(transferProblem(['C:\\Work\\a.txt'], from, 'c:\\work\\', true)).toMatch(/^Both panes show the same folder/);
    expect(transferProblem(['C:\\Work\\a.txt'], from, '', false)).toBe('The other pane shows no folder.');
  });
  it('refuses a folder into itself or below it', () => {
    expect(transferProblem(['C:\\Work\\Photos'], from, 'C:\\Work\\Photos\\2026', false)).toBe(
      'Cannot copy the folder "Photos" into itself.'
    );
    // a folder whose name only starts the same is fine
    expect(transferProblem(['C:\\Work\\Photo'], from, 'C:\\Work\\Photos', true)).toBeNull();
    expect(transferProblem(['C:\\Work\\a.txt', 'C:\\Work\\b'], from, 'D:\\Backup', true)).toBeNull();
  });
  it('asks with the name or the count', () => {
    expect(transferQuestion(['C:\\Work\\a.txt'], 'D:\\Backup', false)).toBe('Copy "a.txt" to\nD:\\Backup?');
    expect(transferQuestion(['C:\\a', 'C:\\b', 'C:\\c'], 'D:\\Backup', true)).toBe('Move 3 items to\nD:\\Backup?');
  });
});
