import { describe, it, expect } from 'vitest';
import {
  studioColor,
  nextUnusedColor,
  effectiveHex,
  PALETTE_HEX,
} from '../../src/lib/studioColors';

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

describe('effectiveHex', () => {
  it('returns stored hex when provided', () => {
    expect(effectiveHex('Any Studio', '#ff0000')).toBe('#ff0000');
  });

  it('returns hash-derived palette hex when stored is absent', () => {
    const result = effectiveHex('Test Studio');
    expect(PALETTE_HEX).toContain(result);
  });

  it('two studios with same name get same fallback color', () => {
    expect(effectiveHex('Yoga Place')).toBe(effectiveHex('Yoga Place'));
  });

  it('two studios with different names may get different fallback colors', () => {
    // These two hash to different palette entries
    const a = effectiveHex('Zen Yoga');
    const b = effectiveHex('Power House');
    // They may or may not collide, but both must be valid palette colors
    expect(PALETTE_HEX).toContain(a);
    expect(PALETTE_HEX).toContain(b);
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

  it('treats uppercase and lowercase hex as the same color', () => {
    expect(nextUnusedColor([PALETTE_HEX[0].toUpperCase()])).toBe(PALETTE_HEX[1]);
  });
});
