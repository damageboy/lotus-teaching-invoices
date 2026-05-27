import React from 'react';
import { describe, expect, it } from 'vitest';
import { InvoiceDocument } from '../../src/lib/pdf/InvoiceDocument';
import { AppConfig, Invoice } from '../../src/lib/types';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const config: AppConfig = {
  teacher: {
    name: 'Jane Teacher',
    address: 'Teacher Street 1',
    taxNumber: '12/345/67890',
    bankDetails: {
      accountOwner: 'Jane Teacher',
      iban: 'DE02120300000000202051',
      bic: 'BYLADEM1001',
    },
  },
  outputDir: '/tmp/invoices',
  lastInvoice: '',
  studios: {
    'Zen Yoga': {
      fullName: 'Zen Yoga GmbH',
      address: 'Studio Street 2',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 100 }],
    },
  },
};

const invoice: Invoice = {
  studioName: 'Zen Yoga',
  invoicePeriod: { from: '2026-01-01', to: '2026-01-31' },
  generatedAt: '2026-05-26T12:34:56.000Z',
  issueDate: '2026-05-26',
  classes: [
    {
      date: '2026-01-03',
      startTime: '09:00',
      endTime: '10:15',
      classType: 'Vinyasa',
      studentCount: 8,
      rateApplied: 100,
      lineTotal: 100,
    },
  ],
  totalClasses: 1,
  totalAmount: 100,
};

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (!React.isValidElement(node)) return [];
  return collectText(node.props.children);
}

describe('InvoiceDocument', () => {
  it('renders the invoice issue date in the document header', () => {
    const document = InvoiceDocument({ invoice, config });
    const text = collectText(document);

    expect(text).toContain('Invoice date');
    expect(text).toContain('2026-05-26');
  });
});
