import { describe, expect, it } from 'vitest';
import { canSplitCell, cellRect, closeCell, dividers, paneName } from '../splitLayout';

describe('Split Screen layout', () => {
  it('names the screens by direction', () => {
    expect(paneName('lr', 'a')).toBe('Left');
    expect(paneName('tb', 'b')).toBe('Bottom');
    expect(paneName('lr', 'b1')).toBe('Top-Right');
    expect(paneName('tb', 'a2')).toBe('Top-Right');
  });

  it('only splits a whole half', () => {
    expect(canSplitCell('a')).toBe(true);
    expect(canSplitCell('b1')).toBe(false);
    expect(canSplitCell(undefined)).toBe(false);
  });

  it('closing a quarter gives its room to its partner', () => {
    expect(closeCell('lr', ['a', 'b1', 'b2'], 'b2')).toEqual({ dir: 'lr', moves: { b1: 'b' } });
  });

  it('closing a half turns the split other half into the new halves', () => {
    expect(closeCell('lr', ['a', 'b1', 'b2'], 'a')).toEqual({ dir: 'tb', moves: { b1: 'a', b2: 'b' } });
  });

  it('closing one of two screens ends the split', () => {
    expect(closeCell('lr', ['a', 'b'], 'b')).toBeNull();
  });

  it('places a quarter with the gap around both lines', () => {
    const r = cellRect('lr', 'b2', { main: 0.5, a: 0.5, b: 0.3 }, 3);
    expect(r.x0).toEqual({ f: 0.5, px: 3 });
    expect(r.x1).toEqual({ f: 1, px: 0 });
    expect(r.y0).toEqual({ f: 0.3, px: 3 });
    expect(r.y1).toEqual({ f: 1, px: 0 });
  });

  it('draws the main line and one line per split half', () => {
    const d = dividers('lr', ['a', 'b1', 'b2'], { main: 0.6, a: 0.5, b: 0.4 }, 3);
    expect(d.map((x) => [x.key, x.vertical, x.at])).toEqual([
      ['main', true, 0.6],
      ['b', false, 0.4],
    ]);
  });
});
