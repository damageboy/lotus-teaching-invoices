import { describe, expect, it } from 'vitest';
import {
  parseStudentDescription,
  proposeConfiguredRate,
  proposeEuroOverride,
  proposeStudentCount,
  rewriteStudioSummary,
} from '../../src/lib/calendar/edit-format.js';

describe('parseStudentDescription', () => {
  it.each([
    ['9', { studentCount: 9, ambiguous: false, safeToReplace: true }],
    [' 9 ', { studentCount: 9, ambiguous: false, safeToReplace: true }],
    ['9/30EUR', { studentCount: 9, rateOverride: 30, ambiguous: false, safeToReplace: true }],
    [
      ' 9 / 30.50 eur ',
      { studentCount: 9, rateOverride: 30.5, ambiguous: false, safeToReplace: true },
    ],
    [
      '0/30.123EUR',
      { studentCount: 0, rateOverride: 30.123, ambiguous: false, safeToReplace: true },
    ],
  ])('strictly recognizes complete legacy value %j', (raw, expected) => {
    expect(parseStudentDescription(raw)).toEqual(expected);
  });

  it('keeps compatible prose display parsing separate from replacement safety', () => {
    expect(parseStudentDescription('students: 9')).toEqual({
      studentCount: 9,
      ambiguous: false,
      safeToReplace: false,
    });
  });

  it('marks multiple-number prose ambiguous and unsafe', () => {
    expect(parseStudentDescription('9 students at 30 euros')).toEqual({
      studentCount: null,
      ambiguous: true,
      safeToReplace: false,
    });
  });
});

describe('description proposals', () => {
  it('preserves a recognized override when changing students', () => {
    expect(proposeStudentCount('9/30EUR', 12)).toEqual({
      current: '9/30EUR',
      proposed: '12/30EUR',
      requiresConfirmation: false,
    });
  });

  it('canonicalizes a legacy override at its existing precision when changing students', () => {
    expect(proposeStudentCount('9 / 30.123 eur', 12)).toEqual({
      current: '9 / 30.123 eur',
      proposed: '12/30.123EUR',
      requiresConfirmation: false,
    });
  });

  it('clears an override when using the configured rate', () => {
    expect(proposeConfiguredRate('9/30EUR', 9)).toEqual({
      current: '9/30EUR',
      proposed: '9',
      requiresConfirmation: false,
    });
  });

  it('includes complete old and proposed values for unsupported prose', () => {
    expect(proposeEuroOverride('students: 9', 9, '30.25')).toEqual({
      current: 'students: 9',
      proposed: '9/30.25EUR',
      requiresConfirmation: true,
    });
  });

  it.each([
    [0, '9/0EUR'],
    ['30', '9/30EUR'],
    ['30.5', '9/30.5EUR'],
    ['30.25', '9/30.25EUR'],
  ])('serializes valid new euro input %j canonically', (euros, proposed) => {
    expect(proposeEuroOverride('9', 9, euros)).toMatchObject({
      proposed,
      requiresConfirmation: false,
    });
  });

  it.each([0, -1, 1.5, '9', '', ' 9 '])('rejects invalid student count %j', (students) => {
    expect(() => proposeStudentCount('9', students as number)).toThrow('student count');
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Infinity])(
    'rejects an unsafe student count %j',
    (students) => {
      expect(() => proposeStudentCount('9', students)).toThrow('student count');
    }
  );

  it.each(['', '30,25', '3e1', '-1', '30.123', '.', ' 30 '])(
    'rejects invalid euro input %j',
    (euros) => {
      expect(() => proposeEuroOverride('9', 9, euros)).toThrow('euro override');
    }
  );

  it.each(['90071992547409.92', '999999999999999999999', Infinity])(
    'rejects a non-finite or unsafe euro amount %j',
    (euros) => {
      expect(() => proposeEuroOverride('9', 9, euros)).toThrow('euro override');
    }
  );

  it('canonicalizes euro input lexically without changing safe cents', () => {
    expect(proposeEuroOverride('9', 9, '90071992547409.01')).toMatchObject({
      proposed: '9/90071992547409.01EUR',
    });
  });

  it('makes every successful proposal safe to parse as a replacement', () => {
    const proposals = [
      proposeStudentCount('9/30EUR', Number.MAX_SAFE_INTEGER),
      proposeEuroOverride('students: 9', 9, '30.50'),
      proposeConfiguredRate('9 / 30.123 eur', 12),
    ];

    for (const { proposed } of proposals) {
      expect(parseStudentDescription(proposed).safeToReplace).toBe(true);
    }
  });
});

describe('rewriteStudioSummary', () => {
  it('replaces only the first trimmed segment and keeps the raw suffix', () => {
    expect(
      rewriteStudioSummary(' Wrong Studio / Kreuzberg / Pilates ', ' Correct Studio ')
    ).toEqual({
      ok: true,
      value: 'Correct Studio / Kreuzberg / Pilates ',
      changed: true,
    });
  });

  it.each([
    'Studio',
    'Studio / ',
    ' / Class',
    'Studio / Location / ',
    'Studio / Class / Extra / More',
  ])('rejects unsupported summary structure %j', (summary) => {
    expect(rewriteStudioSummary(summary, 'Correct Studio')).toEqual({
      ok: false,
      reason: 'unsupportedStructure',
    });
  });

  it.each([' ', 'Correct/Studio', ' / '])(
    'rejects an invalid replacement studio name %j',
    (studioName) => {
      expect(rewriteStudioSummary('Wrong Studio / Pilates', studioName)).toEqual({
        ok: false,
        reason: 'unsupportedStructure',
      });
    }
  );
});
