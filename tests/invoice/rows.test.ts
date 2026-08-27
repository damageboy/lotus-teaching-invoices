import { describe, expect, it } from 'vitest';
import {
  buildCurrentInvoiceSources,
  buildInvoiceRows,
  currentInvoiceSourceInputKey,
  visibleCurrentInvoiceSourceBuild,
} from '../../src/lib/invoice/rows.js';
import type { DriveInvoiceEntry } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveFileRecord } from '../../src/lib/drive/types.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';
import type { AppConfig } from '../../src/lib/types.js';

function driveFile(id: string, name: string): DriveFileRecord {
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: ['final-folder'],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: '4',
    md5Checksum: null,
    sha256Checksum: 'a'.repeat(64),
    properties: {},
    capabilities: {
      canListChildren: false,
      canAddChildren: false,
      canEdit: true,
      canDownload: true,
    },
    etag: '"etag-1"',
  };
}

function driveEntry(
  studioSlug: string,
  monthKey: string,
  overrides: Partial<DriveInvoiceEntry> = {}
): DriveInvoiceEntry {
  const filename = `42-2026-${studioSlug}-${monthKey}.pdf`;
  return {
    key: { studioSlug, monthKey },
    file: driveFile(`${studioSlug}-${monthKey}`, filename),
    filename,
    invoiceNumber: '42/2025',
    state: 'fresh',
    sourceSha256: 'b'.repeat(64),
    pdfSha256: 'a'.repeat(64),
    message: null,
    ...overrides,
  };
}

describe('buildInvoiceRows', () => {
  describe('source build visibility', () => {
    it('does not invalidate invoice sources when only the allocation counter changes', () => {
      const classes = [parsedClass()];
      const current: AppConfig = {
        teacher: {
          name: 'Teacher',
          address: '',
          taxNumber: '',
          bankDetails: { accountOwner: '', iban: '', bic: '' },
        },
        calendarId: 'calendar-a',
        studios: {},
        invoiceSequenceByYear: {},
      };

      expect(
        currentInvoiceSourceInputKey(classes, {
          ...current,
          invoiceSequenceByYear: { '2026': 8 },
        })
      ).toBe(currentInvoiceSourceInputKey(classes, current));
    });

    it('synchronously masks a completed build from an older class/config input', () => {
      const source = { fingerprint: { sourceSha256: 'old' } } as any;

      expect(
        visibleCurrentInvoiceSourceBuild('new-input', {
          inputKey: 'old-input',
          sources: [source],
          error: null,
        })
      ).toEqual({ sources: [], ready: false, error: null });
    });

    it('keeps a matching failed build inactive while exposing its blocker', () => {
      expect(
        visibleCurrentInvoiceSourceBuild('current-input', {
          inputKey: 'current-input',
          sources: [],
          error: 'Current source is invalid',
        })
      ).toEqual({ sources: [], ready: false, error: 'Current source is invalid' });
    });
  });
  it('builds unnumbered semantic sources before the first Drive scan', async () => {
    const lesson = parsedClass({
      eventIdentity: { calendarId: 'calendar-a', eventId: 'event-a' },
      studioName: 'Alpha Studio',
      date: '2026-02-03',
      studentCount: 5,
    });
    const config: AppConfig = {
      teacher: {
        name: 'Teacher',
        address: '',
        taxNumber: '',
        bankDetails: { accountOwner: '', iban: '', bic: '' },
      },
      calendarId: 'calendar-a',
      studios: {
        'Alpha Studio': {
          fullName: 'Alpha Studio',
          address: '',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
        },
      },
    };

    const [source] = await buildCurrentInvoiceSources([lesson], config);
    const [changed] = await buildCurrentInvoiceSources([lesson], {
      ...config,
      studios: {
        'Alpha Studio': {
          ...config.studios['Alpha Studio'],
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 60 }],
        },
      },
    });

    expect(source).toMatchObject({
      key: { studioSlug: 'alpha-studio', monthKey: '2026-02' },
      studioName: 'Alpha Studio',
      fingerprint: {
        sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        calendarSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(source.invoice).not.toHaveProperty('invoiceNumber');
    expect(changed.fingerprint.sourceSha256).not.toBe(source.fingerprint.sourceSha256);
  });

  it('merges current Calendar classes with authoritative Drive entries by invoice key', () => {
    const current = parsedClass({
      studioName: 'Alpha Studio',
      date: '2026-02-03',
      studentCount: 5,
    });
    const finalized = driveEntry('alpha-studio', '2026-02');

    const rows = buildInvoiceRows([current], [finalized]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: { studioSlug: 'alpha-studio', monthKey: '2026-02' },
      studioName: 'Alpha Studio',
      monthKey: '2026-02',
      classCount: 1,
      classes: [current],
      driveEntries: [finalized],
    });
  });

  it('keeps historical Drive-only invoices visible and ignores unmapped warnings', () => {
    const historical = driveEntry('former-studio', '2025-11');
    const malformed = driveEntry('ignored', '2025-10', {
      key: null,
      filename: 'invoice.pdf',
      file: driveFile('malformed', 'invoice.pdf'),
      invoiceNumber: null,
      state: 'malformed',
      sourceSha256: null,
      pdfSha256: null,
      message: 'Malformed finalized invoice filename: invoice.pdf',
    });

    const rows = buildInvoiceRows([], [historical, malformed]);

    expect(rows).toEqual([
      expect.objectContaining({
        key: { studioSlug: 'former-studio', monthKey: '2025-11' },
        studioName: 'former-studio',
        classCount: 0,
        classes: [],
        driveEntries: [historical],
      }),
    ]);
  });

  it('retains every duplicate entry so the affected row stays blocked', () => {
    const first = driveEntry('alpha', '2026-01', {
      state: 'duplicate',
      message: 'Multiple Drive files map to alpha 2026-01',
    });
    const second = driveEntry('alpha', '2026-01', {
      file: driveFile('second', '43-2026-alpha-2026-01.pdf'),
      filename: '43-2026-alpha-2026-01.pdf',
      invoiceNumber: '43/2026',
      state: 'duplicate',
      message: 'Multiple Drive files map to alpha 2026-01',
    });

    const [row] = buildInvoiceRows([], [first, second]);

    expect(row.driveEntries).toEqual([first, second]);
  });

  describe('conservative current-source construction', () => {
    it('rejects a current Calendar key whose studio configuration is missing', async () => {
      const lesson = parsedClass({
        eventIdentity: { calendarId: 'calendar-a', eventId: 'missing-studio' },
        studioName: 'Missing Studio',
        date: '2026-02-03',
        studentCount: 5,
      });
      const config: AppConfig = {
        teacher: {
          name: 'Teacher',
          address: '',
          taxNumber: '',
          bankDetails: { accountOwner: '', iban: '', bic: '' },
        },
        calendarId: 'calendar-a',
        studios: {},
      };

      await expect(buildCurrentInvoiceSources([lesson], config)).rejects.toThrow(
        'Missing Studio 2026-02: studio configuration is unavailable'
      );
    });

    it('rejects a current key whose slug matches multiple configured studios', async () => {
      const lesson = parsedClass({
        eventIdentity: { calendarId: 'calendar-a', eventId: 'ambiguous-studio' },
        studioName: 'Studio A',
        date: '2026-02-03',
        studentCount: 5,
      });
      const studio = {
        fullName: 'Studio',
        address: '',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
      };
      const config: AppConfig = {
        teacher: {
          name: 'Teacher',
          address: '',
          taxNumber: '',
          bankDetails: { accountOwner: '', iban: '', bic: '' },
        },
        calendarId: 'calendar-a',
        studios: { 'Studio A': studio, 'Studio-A': studio },
      };

      await expect(buildCurrentInvoiceSources([lesson], config)).rejects.toThrow(
        'studio slug "studio-a" matches multiple configurations'
      );
    });

    it('rejects current source input that cannot produce a complete invoice', async () => {
      const lesson = parsedClass({
        eventIdentity: { calendarId: 'calendar-a', eventId: 'zero-students' },
        studioName: 'Alpha Studio',
        date: '2026-02-03',
        studentCount: 0,
      });
      const config: AppConfig = {
        teacher: {
          name: 'Teacher',
          address: '',
          taxNumber: '',
          bankDetails: { accountOwner: '', iban: '', bic: '' },
        },
        calendarId: 'calendar-a',
        studios: {
          'Alpha Studio': {
            fullName: 'Alpha Studio',
            address: '',
            rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
          },
        },
      };

      await expect(buildCurrentInvoiceSources([lesson], config)).rejects.toThrow(
        'Alpha Studio 2026-02: invoice input contains unbillable classes'
      );
    });
  });

  describe('historical studio resolution', () => {
    const configuredStudio = {
      fullName: 'Former Studio GmbH',
      address: '',
      invoiceEmail: 'former@example.com',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    };
    const baseConfig: AppConfig = {
      teacher: {
        name: 'Teacher',
        address: '',
        taxNumber: '',
        bankDetails: { accountOwner: '', iban: '', bic: '' },
      },
      calendarId: 'calendar-a',
      studios: { 'Former Studio': configuredStudio },
    };

    it('uses the unique configured studio name for a Drive-only row', () => {
      const [row] = buildInvoiceRows([], [driveEntry('former-studio', '2025-11')], baseConfig);

      expect(row.studioName).toBe('Former Studio');
      expect(row.studioConfigReason).toBeNull();
    });

    it('keeps a missing historical mapping visible with an explicit config blocker', () => {
      const [row] = buildInvoiceRows([], [driveEntry('unknown-studio', '2025-11')], baseConfig);

      expect(row.studioName).toBe('unknown-studio');
      expect(row.studioConfigReason).toBe(
        'No configured studio matches Drive slug "unknown-studio".'
      );
    });

    it('blocks ambiguous historical mappings instead of selecting one arbitrarily', () => {
      const ambiguousConfig: AppConfig = {
        ...baseConfig,
        studios: { 'Former Studio': configuredStudio, 'Former-Studio': configuredStudio },
      };
      const [row] = buildInvoiceRows([], [driveEntry('former-studio', '2025-11')], ambiguousConfig);

      expect(row.studioConfigReason).toContain(
        'Drive slug "former-studio" matches multiple configured studios'
      );
    });
  });
});
