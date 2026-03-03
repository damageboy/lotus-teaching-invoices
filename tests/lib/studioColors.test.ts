import { describe, it, expect } from 'vitest';
import { studioColor, nextUnusedColor, PALETTE_HEX } from '../../src/lib/studioColors';

describe('PALETTE_HEX', () => {
  it('has 6 entries, all valid hex', () => {
    expect(PALETTE_HEX).toHaveLength(6);
    for (const h of PALETTE_HEX) {
      expect(h).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('studioColor', () => {
  it('returns an object with backgroundColor, color, borderColor', () => {
    const s = studioColor('My Studio');
    expect(s).toHaveProperty('backgroundColor');
    expect(s).toHaveProperty('color');
    expect(s).toHaveProperty('borderColor');
  });

  it('uses provided hex when given', () => {
    const s = studioColor('Any Name', '#ff0000');
    expect(s.backgroundColor).toContain('hsl(');
    expect(s.color).toContain('hsl(');
    expect(s.borderColor).toContain('hsl(');
  });

  it('two studios with same name get same color when no hex override', () => {
    expect(studioColor('Yogibar')).toEqual(studioColor('Yogibar'));
  });

  it('backgroundColor is lighter than borderColor (higher lightness)', () => {
    const s = studioColor('Test', '#059669');
    // bg is hsl(h,s%,93%), border is hsl(h,s%,70%) — bg lightness number is higher
    const bgL = parseInt(s.backgroundColor.match(/(\d+)%\)/)![1]);
    const borderL = parseInt(s.borderColor.match(/(\d+)%\)/)![1]);
    expect(bgL).toBeGreaterThan(borderL);
  });
});

describe('nextUnusedColor', () => {
  it('returns the first palette color when none are used', () => {
    expect(nextUnusedColor([])).toBe(PALETTE_HEX[0]);
  });

  it('skips already-used colors', () => {
    expect(nextUnusedColor([PALETTE_HEX[0]])).toBe(PALETTE_HEX[1]);
    expect(nextUnusedColor([PALETTE_HEX[0], PALETTE_HEX[1]])).toBe(PALETTE_HEX[2]);
  });

  it('wraps around when all palette colors are used', () => {
    expect(nextUnusedColor(PALETTE_HEX)).toBe(PALETTE_HEX[0]);
  });
});
