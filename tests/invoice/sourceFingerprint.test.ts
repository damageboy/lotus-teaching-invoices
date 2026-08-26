import { describe, expect, it } from 'vitest';
import {
  buildInvoiceSource,
  fingerprintInvoiceSource,
  sha256Hex,
  type BuildInvoiceSourceInput,
  type InvoiceSource,
} from '../../src/lib/invoice/sourceFingerprint.js';
import type { AppConfig, Invoice, ParsedClass } from '../../src/lib/types.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

interface SourceOverrides {
  generatedAt?: string;
  issueDate?: string;
  studentCount?: number;
  eventId?: string;
  etag?: string | null;
  sourceSummary?: string;
  sourceDescription?: string;
  rateOverride?: number;
  teacherName?: string;
  teacherAddress?: string;
  taxNumber?: string;
  accountOwner?: string;
  iban?: string;
  bic?: string;
  studioFullName?: string;
  studioAddress?: string;
  invoiceEmail?: string;
  tierRate?: number;
  invoiceNumber?: string;
  calendarId?: string;
  invoiceStudioName?: string;
  periodFrom?: string;
  lineRate?: number;
  totalAmount?: number;
}

function sourceInput(overrides: SourceOverrides = {}): BuildInvoiceSourceInput {
  const studentCount = overrides.studentCount ?? 8;
  const lineRate = overrides.lineRate ?? 100;
  const studioName = overrides.invoiceStudioName ?? 'Studio A';
  const calendarId = overrides.calendarId ?? 'calendar-a';
  const classes: ParsedClass[] = [
    parsedClass({
      eventIdentity: {
        calendarId,
        eventId: overrides.eventId ?? 'event-a',
        recurringEventId: 'series-a',
        originalStartTime: '2026-08-03T09:00:00+02:00',
        etag: overrides.etag === undefined ? '"event-a-v1"' : overrides.etag,
      },
      sourceSummary: overrides.sourceSummary ?? 'Studio A / Flow',
      sourceDescription: overrides.sourceDescription ?? `${studentCount} students`,
      studioName,
      classType: 'Flow',
      location: 'Mitte',
      date: '2026-08-03',
      startTime: '09:00',
      endTime: '10:15',
      studentCount,
      ...(overrides.rateOverride === undefined ? {} : { rateOverride: overrides.rateOverride }),
      ambiguousStudentCount: false,
    }),
    parsedClass({
      eventIdentity: {
        calendarId,
        eventId: 'event-b',
        recurringEventId: null,
        originalStartTime: null,
        etag: '"event-b-v2"',
      },
      sourceSummary: 'Studio A / Yin',
      sourceDescription: '4 students',
      studioName,
      classType: 'Yin',
      date: '2026-08-10',
      startTime: '18:00',
      endTime: '19:00',
      studentCount: 4,
    }),
  ];
  const config: AppConfig = {
    teacher: {
      name: overrides.teacherName ?? 'Teacher Name',
      address: overrides.teacherAddress ?? 'Teacher Street 1',
      taxNumber: overrides.taxNumber ?? '12/345/67890',
      bankDetails: {
        accountOwner: overrides.accountOwner ?? 'Teacher Name',
        iban: overrides.iban ?? 'DE02120300000000202051',
        bic: overrides.bic ?? 'BYLADEM1001',
      },
    },
    calendarId,
    outputDir: '/render-only/output',
    lastInvoice: '7/2026',
    studios: {
      [studioName]: {
        fullName: overrides.studioFullName ?? 'Studio A GmbH',
        address: overrides.studioAddress ?? 'Studio Street 2',
        invoiceEmail: overrides.invoiceEmail ?? 'billing@studio.example',
        color: '#123456',
        rateTiers: [
          { minStudents: 1, maxStudents: 5, rate: 80 },
          { minStudents: 6, maxStudents: null, rate: overrides.tierRate ?? 100 },
        ],
      },
    },
  };
  const invoice: Invoice = {
    studioName,
    invoicePeriod: {
      from: overrides.periodFrom ?? '2026-08-01',
      to: '2026-08-31',
    },
    generatedAt: overrides.generatedAt ?? '2026-08-24T10:00:00Z',
    issueDate: overrides.issueDate ?? '2026-08-24',
    classes: [
      {
        date: '2026-08-03',
        startTime: '09:00',
        endTime: '10:15',
        classType: 'Flow',
        location: 'Mitte',
        studentCount,
        rateApplied: lineRate,
        lineTotal: lineRate,
      },
      {
        date: '2026-08-10',
        startTime: '18:00',
        endTime: '19:00',
        classType: 'Yin',
        studentCount: 4,
        rateApplied: 80,
        lineTotal: 80,
      },
    ],
    totalClasses: 2,
    totalAmount: overrides.totalAmount ?? lineRate + 80,
  };

  return {
    config,
    classes,
    invoice,
    calendarId,
    invoiceNumber: overrides.invoiceNumber ?? '8/2026',
  };
}

async function fingerprint(overrides: SourceOverrides = {}) {
  return fingerprintInvoiceSource(buildInvoiceSource(sourceInput(overrides)));
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)])
  );
}

describe('invoice source fingerprints', () => {
  it('hashes bytes as lowercase SHA-256 hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('ignores render time while detecting business changes', async () => {
    const first = buildInvoiceSource(
      sourceInput({
        generatedAt: '2026-08-24T10:00:00Z',
        issueDate: '2026-08-24',
      })
    );
    const later = buildInvoiceSource(
      sourceInput({
        generatedAt: '2026-08-25T10:00:00Z',
        issueDate: '2026-08-25',
      })
    );
    expect(await fingerprintInvoiceSource(first)).toEqual(await fingerprintInvoiceSource(later));

    const changed = buildInvoiceSource(sourceInput({ studentCount: 9 }));
    expect((await fingerprintInvoiceSource(changed)).sourceSha256).not.toBe(
      (await fingerprintInvoiceSource(first)).sourceSha256
    );
  });

  it('uses recursively stable object-key ordering', async () => {
    const source = buildInvoiceSource(sourceInput());
    const reordered = reverseObjectKeys(source) as InvoiceSource;

    expect(await fingerprintInvoiceSource(reordered)).toEqual(
      await fingerprintInvoiceSource(source)
    );
  });

  it('normalizes source-class and line-item order', async () => {
    const input = sourceInput();
    const first = buildInvoiceSource(input);
    const reordered = buildInvoiceSource({
      ...input,
      classes: [...input.classes].reverse(),
      invoice: { ...input.invoice, classes: [...input.invoice.classes].reverse() },
    });

    expect(reordered).toEqual(first);
    expect(await fingerprintInvoiceSource(reordered)).toEqual(
      await fingerprintInvoiceSource(first)
    );
  });

  it.each([
    ['event ID', { eventId: 'event-changed' }],
    ['event ETag', { etag: '"event-a-v2"' }],
    ['source summary', { sourceSummary: 'Studio A / Advanced Flow' }],
    ['source description', { sourceDescription: '8 students, manually checked' }],
  ] satisfies Array<[string, SourceOverrides]>)(
    'detects a %s change in both hashes',
    async (_, change) => {
      const baseline = await fingerprint();
      const changed = await fingerprint(change);

      expect(changed.calendarSha256).not.toBe(baseline.calendarSha256);
      expect(changed.sourceSha256).not.toBe(baseline.sourceSha256);
    }
  );

  it.each([
    ['rate tier', { tierRate: 110 }],
    ['manual euro override', { rateOverride: 110 }],
    ['teacher name', { teacherName: 'Another Teacher' }],
    ['teacher address', { teacherAddress: 'Another Street 9' }],
    ['tax number', { taxNumber: '98/765/43210' }],
    ['bank owner', { accountOwner: 'Another Teacher' }],
    ['IBAN', { iban: 'DE89370400440532013000' }],
    ['BIC', { bic: 'COBADEFFXXX' }],
    ['studio legal name', { studioFullName: 'Studio A UG' }],
    ['studio address', { studioAddress: 'New Studio Street 3' }],
    ['studio invoice email', { invoiceEmail: 'accounts@studio.example' }],
    ['invoice number', { invoiceNumber: '9/2026' }],
    ['calendar ID', { calendarId: 'calendar-b' }],
    ['studio slug', { invoiceStudioName: 'Studio Alpha' }],
    ['period', { periodFrom: '2026-08-02' }],
    ['normalized line item', { lineRate: 105 }],
    ['normalized total', { totalAmount: 185 }],
  ] satisfies Array<[string, SourceOverrides]>)(
    'detects a %s business change',
    async (_, change) => {
      expect((await fingerprint(change)).sourceSha256).not.toBe((await fingerprint()).sourceSha256);
    }
  );

  it('keeps non-calendar business changes out of the calendar hash', async () => {
    const baseline = await fingerprint();

    expect((await fingerprint({ tierRate: 110 })).calendarSha256).toBe(baseline.calendarSha256);
    expect((await fingerprint({ invoiceNumber: '9/2026' })).calendarSha256).toBe(
      baseline.calendarSha256
    );
  });
});
