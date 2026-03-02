import {
  parseLastInvoice,
  formatInvoiceNumber,
  studioSlug,
  previewFilename,
  finalizedFilename,
  extractInvoiceNumberFromFilename,
  matchesFinalizedInvoice,
} from '../../src/lib/invoice/finalization';

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
});
