import { describe, expect, it } from 'vitest';
import { buildInvoiceRows } from '../../src/lib/invoice/rows.js';
import type { InvoiceFreshnessRow } from '../../src/lib/invoice/freshness.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

function staleRow(studioName: string, monthKey: string): InvoiceFreshnessRow {
  return {
    key: {
      calendarId: 'calendar-a',
      outputDir: '/output-a',
      studioName,
      monthKey,
    },
    invoiceNumber: '42/2025',
    finalFilename: `42-2025-${studioName.toLowerCase()}-${monthKey}.pdf`,
    staleAt: '2026-08-15T12:00:00Z',
    reason: 'Lesson changed',
    clearedAt: null,
    revision: 3,
    lastOperationId: 'operation-1',
  };
}

describe('buildInvoiceRows', () => {
  it('returns the deduplicated union of current and stale invoice keys', () => {
    const current = parsedClass({
      studioName: 'Alpha',
      date: '2026-02-03',
      studentCount: 5,
    });
    const alphaFreshness = staleRow('Alpha', '2026-02');
    const betaFreshness = staleRow('Beta', '2026-01');

    const rows = buildInvoiceRows([current], [alphaFreshness, alphaFreshness, betaFreshness]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      studioName: 'Alpha',
      monthKey: '2026-02',
      classCount: 1,
      classes: [current],
      freshness: alphaFreshness,
    });
    expect(rows[1]).toMatchObject({
      studioName: 'Beta',
      monthKey: '2026-01',
      classCount: 0,
      classes: [],
      freshness: betaFreshness,
    });
  });
});
