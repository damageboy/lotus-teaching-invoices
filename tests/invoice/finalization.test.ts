import { describe, expect, it } from 'vitest';
import {
  parseLastInvoice,
  formatInvoiceNumber,
  studioSlug,
  previewFilename,
  finalizedFilename,
  extractInvoiceNumberFromFilename,
  matchesFinalizedInvoice,
  parseFinalizedInvoiceFilename,
} from '../../src/lib/invoice/finalization.js';

describe('parseLastInvoice', () => {
  it('parses a valid string', () => {
    expect(parseLastInvoice('7/2026')).toEqual({ n: 7, year: 2026 });
  });
  it('returns null for empty string', () => {
    expect(parseLastInvoice('')).toBeNull();
  });
  it('returns null for invalid format', () => {
    expect(parseLastInvoice('abc')).toBeNull();
    expect(parseLastInvoice('7-2026')).toBeNull();
  });
});

describe('formatInvoiceNumber', () => {
  it('formats n and year correctly', () => {
    expect(formatInvoiceNumber(8, 2026)).toBe('8/2026');
  });
});

describe('studioSlug', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(studioSlug('Yoga Studio GmbH')).toBe('yoga-studio-gmbh');
  });
  it('strips leading and trailing hyphens', () => {
    expect(studioSlug('--Test--')).toBe('test');
  });
  it.each([
    ['Yoga Studio GmbH', 'yoga-studio-gmbh'],
    ['--Test--', 'test'],
    ['Bikram Yoga', 'bikram-yoga'],
    ['İ Yoga', 'i-yoga'],
    ['Crème & Co.', 'cr-me-co'],
  ])('matches the Rust cross-language fixture %j', (studio, expected) => {
    expect(studioSlug(studio)).toBe(expected);
  });
});

describe('previewFilename', () => {
  it('returns slug-year-month.pdf', () => {
    expect(previewFilename('Yoga Studio', '2026-01-01', '2026-01-31')).toBe(
      'yoga-studio-2026-01.pdf'
    );
  });
});

describe('finalizedFilename', () => {
  it('encodes invoice number at the start', () => {
    expect(finalizedFilename('yogibar', '2026', '01', '8/2026')).toBe('8-2026-yogibar-2026-01.pdf');
  });
});

describe('parseFinalizedInvoiceFilename', () => {
  it('parses the complete finalized identity', () => {
    expect(parseFinalizedInvoiceFilename('8-2026-studio-a-2026-08.pdf')).toEqual({
      invoiceNumber: '8/2026',
      sequence: 8,
      invoiceYear: 2026,
      studioSlug: 'studio-a',
      monthKey: '2026-08',
    });
  });

  it('preserves slugs containing multiple hyphens', () => {
    expect(parseFinalizedInvoiceFilename('18-2027-yoga-studio-berlin-2026-12.pdf')).toEqual({
      invoiceNumber: '18/2027',
      sequence: 18,
      invoiceYear: 2027,
      studioSlug: 'yoga-studio-berlin',
      monthKey: '2026-12',
    });
  });

  it.each([
    '8-2026-studio-a-2026-00.pdf',
    '8-2026-studio-a-2026-13.pdf',
    '8-2026-studio-a-2026-8.pdf',
  ])('rejects an invalid month in %s', (filename) => {
    expect(parseFinalizedInvoiceFilename(filename)).toBeNull();
  });

  it.each([
    'studio-a-2026-08.pdf',
    '8-26-studio-a-2026-08.pdf',
    '8-2026--2026-08.pdf',
    '8-2026-Studio-A-2026-08.pdf',
    '8-2026-studio_a-2026-08.pdf',
    '8-2026-studio-a-2026-08.pdf.bak',
  ])('rejects the non-canonical filename %s', (filename) => {
    expect(parseFinalizedInvoiceFilename(filename)).toBeNull();
  });
});

describe('extractInvoiceNumberFromFilename', () => {
  it('extracts from a finalized filename', () => {
    expect(extractInvoiceNumberFromFilename('8-2026-yogibar-2026-01.pdf')).toBe('8/2026');
  });
  it('returns null for a preview filename', () => {
    expect(extractInvoiceNumberFromFilename('yogibar-2026-01.pdf')).toBeNull();
  });
});

describe('matchesFinalizedInvoice', () => {
  it('matches the correct studio/period', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      true
    );
  });
  it('does not match a different month', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-02.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
  it('does not match a different studio', () => {
    expect(matchesFinalizedInvoice('8-2026-other-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
  it('does not match a slug that is a suffix of another studio slug', () => {
    expect(matchesFinalizedInvoice('8-2026-bikram-yoga-2026-01.pdf', 'yoga', '2026', '01')).toBe(
      false
    );
  });
  it.each(['8-26-yoga-2026-01.pdf', '8-2026-yoga-2026-1.pdf', '8-2026-yoga-2026-01.pdf.bak'])(
    'rejects malformed finalized filename %s',
    (filename) => {
      expect(matchesFinalizedInvoice(filename, 'yoga', '2026', '01')).toBe(false);
    }
  );
});
