import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import {
  adoptManualPdf,
  scanFinalFolder,
  verifyDrivePdf,
  type CurrentInvoiceSource,
} from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveFileRecord, LotusPdfProperties } from '../../src/lib/drive/types.js';
import {
  buildInvoiceSource,
  fingerprintInvoiceSource,
  sha256Hex,
} from '../../src/lib/invoice/sourceFingerprint.js';
import type { AppConfig, Invoice } from '../../src/lib/types.js';
import { MemoryDriveApi, type MemoryDriveFile } from './memoryDriveApi.js';

const PDF_BYTES = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 37, 226, 227, 207, 211]);
const OTHER_PDF_BYTES = Uint8Array.from([...PDF_BYTES, 10, 49]);
const FINAL_FOLDER_ID = 'final-folder';
const ROOT_FOLDER_ID = 'root-folder';
const SOURCE_SHA = '3f2824379671b527733f09142105a093ae034b496e6f7749f10a6649bb5a5c7b';
const CALENDAR_SHA = '64fb5e7d24fa6e0c884a8c0c9e100bc2bc3cec0b5db9a4a2390128fcd3d69a5c';

function capabilities(overrides: Partial<DriveFileRecord['capabilities']> = {}) {
  return {
    canListChildren: false,
    canAddChildren: false,
    canEdit: true,
    canDownload: true,
    ...overrides,
  };
}

function folder(
  id: string,
  name: string,
  parents: string[],
  driveId: string | null = null
): DriveFileRecord {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents,
    driveId,
    ownedByMe: driveId === null,
    trashed: false,
    version: '1',
    size: null,
    md5Checksum: null,
    sha256Checksum: null,
    properties: {},
    capabilities: capabilities({ canListChildren: true, canAddChildren: true }),
    etag: `"${id}-v1"`,
  };
}

function stagedRoot(driveId: string | null = null): StagedDriveRoot {
  return {
    root: {
      folderId: ROOT_FOLDER_ID,
      driveId,
      folderName: 'Lotus Invoices',
    },
    rootFile: folder(ROOT_FOLDER_ID, 'Lotus Invoices', driveId === null ? ['root'] : [], driveId),
    finalFolder: folder(FINAL_FOLDER_ID, 'Final', [ROOT_FOLDER_ID], driveId),
  };
}

interface PdfOptions {
  id?: string;
  name?: string;
  bytes?: Uint8Array;
  driveId?: string | null;
  parents?: string[];
  properties?: Record<string, string>;
  sha256Checksum?: string | null;
  etag?: string | null;
  mimeType?: string;
  canEdit?: boolean;
  canDownload?: boolean;
}

function manualPdf(options: PdfOptions = {}): MemoryDriveFile {
  const id = options.id ?? 'pdf-1';
  const bytes = options.bytes ?? PDF_BYTES;
  return {
    id,
    name: options.name ?? '8-2026-studio-a-2026-08.pdf',
    mimeType: options.mimeType ?? 'application/pdf',
    parents: options.parents ?? [FINAL_FOLDER_ID],
    driveId: options.driveId ?? null,
    ownedByMe: (options.driveId ?? null) === null,
    trashed: false,
    version: '1',
    size: String(bytes.byteLength),
    md5Checksum: null,
    sha256Checksum: options.sha256Checksum === undefined ? null : options.sha256Checksum,
    properties: options.properties ?? { unrelated: 'preserved' },
    capabilities: capabilities({
      canEdit: options.canEdit ?? true,
      canDownload: options.canDownload ?? true,
    }),
    etag: options.etag === undefined ? `"${id}-v1"` : options.etag,
    bytes,
  };
}

function managedProperties(overrides: Partial<LotusPdfProperties> = {}): LotusPdfProperties {
  return {
    lotusSchema: '1',
    lotusCalendarHash: CALENDAR_SHA,
    lotusStudioSlug: 'studio-a',
    lotusMonth: '2026-08',
    lotusInvoiceNumber: '8/2026',
    lotusSourceSha256: SOURCE_SHA,
    lotusPdfSha256: 'pending',
    lotusOperationId: 'finalize-operation-1',
    ...overrides,
  };
}

async function managedPdf(id = 'pdf-1', options: PdfOptions = {}): Promise<MemoryDriveFile> {
  const bytes = options.bytes ?? PDF_BYTES;
  const pdfSha = await sha256Hex(bytes);
  const properties = {
    ...managedProperties({ lotusPdfSha256: pdfSha }),
    ...(options.properties ?? {}),
  };
  return manualPdf({
    ...options,
    id,
    bytes,
    properties,
    sha256Checksum: options.sha256Checksum === undefined ? pdfSha : options.sha256Checksum,
  });
}

function config(): AppConfig {
  return {
    teacher: {
      name: 'Teacher',
      address: 'Street',
      taxNumber: 'Tax',
      bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
    },
    calendarId: 'calendar-id',
    outputDir: '/unused',
    lastInvoice: '7/2026',
    studios: {
      'Studio A': {
        fullName: 'Studio A GmbH',
        address: 'Studio Street',
        invoiceEmail: 'studio@example.com',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
      },
    },
  };
}

function invoice(invoiceNumber = '8/2026'): Invoice {
  return {
    studioName: 'Studio A',
    invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    generatedAt: '2026-08-24T12:00:00Z',
    issueDate: '2026-08-24',
    classes: [],
    totalClasses: 0,
    totalAmount: 0,
    invoiceNumber,
  };
}

function currentSource(
  studioSlug = 'studio-a',
  monthKey = '2026-08',
  overrides: Partial<CurrentInvoiceSource> = {}
): CurrentInvoiceSource {
  return {
    key: { studioSlug, monthKey },
    studioName: 'Studio A',
    invoice: invoice(),
    classes: [],
    config: config(),
    fingerprint: { sourceSha256: SOURCE_SHA, calendarSha256: CALENDAR_SHA },
    ...overrides,
  };
}

describe('Drive invoice catalog', () => {
  it('adopts one valid manually copied PDF without changing bytes or identity', async () => {
    const before = manualPdf({ id: 'pdf-1' });
    const api = new MemoryDriveApi([before]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({
      file: { id: 'pdf-1', name: before.name, parents: before.parents },
      key: { studioSlug: 'studio-a', monthKey: '2026-08' },
      invoiceNumber: '8/2026',
      state: 'fresh',
      sourceSha256: SOURCE_SHA,
      pdfSha256: await sha256Hex(PDF_BYTES),
      message: null,
    });
    const after = api.file('pdf-1');
    expect(after.bytes).toEqual(PDF_BYTES);
    expect(after).toMatchObject({
      id: before.id,
      name: before.name,
      mimeType: before.mimeType,
      parents: before.parents,
      properties: {
        unrelated: 'preserved',
        lotusSchema: '1',
        lotusCalendarHash: CALENDAR_SHA,
        lotusStudioSlug: 'studio-a',
        lotusMonth: '2026-08',
        lotusInvoiceNumber: '8/2026',
        lotusSourceSha256: SOURCE_SHA,
        lotusPdfSha256: await sha256Hex(PDF_BYTES),
      },
    });
    expect(api.patchRequest('pdf-1')).toMatchObject({
      fileId: 'pdf-1',
      ifMatch: '"pdf-1-v1"',
      supportsAllDrives: true,
    });
    expect(Object.keys(api.patchRequest('pdf-1')!.properties).sort()).toEqual([
      'lotusCalendarHash',
      'lotusInvoiceNumber',
      'lotusMonth',
      'lotusOperationId',
      'lotusPdfSha256',
      'lotusSchema',
      'lotusSourceSha256',
      'lotusStudioSlug',
    ]);
  });

  it('uses a deterministic idempotency property when adoption is retried', async () => {
    const firstApi = new MemoryDriveApi([manualPdf()]);
    await scanFinalFolder(firstApi, stagedRoot(), [currentSource()]);
    const firstOperationId = firstApi.file('pdf-1').properties.lotusOperationId;

    const secondApi = new MemoryDriveApi([manualPdf()]);
    await scanFinalFolder(secondApi, stagedRoot(), [currentSource()]);

    expect(firstOperationId).toMatch(/^adopt:[0-9a-f]{64}$/);
    expect(secondApi.file('pdf-1').properties.lotusOperationId).toBe(firstOperationId);
  });

  it('blocks every file when two filenames map to one studio and month', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([
        await managedPdf('a'),
        await managedPdf('b', { name: '9-2026-studio-a-2026-08.pdf' }),
      ]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries).toEqual([
      expect.objectContaining({ file: expect.objectContaining({ id: 'a' }), state: 'duplicate' }),
      expect.objectContaining({ file: expect.objectContaining({ id: 'b' }), state: 'duplicate' }),
    ]);
    expect(scan.blockingConflicts).toEqual([
      {
        scope: 'invoice',
        kind: 'duplicate',
        key: { studioSlug: 'studio-a', monthKey: '2026-08' },
        message: expect.stringContaining('a, b'),
      },
    ]);
  });

  it('does not adopt either duplicate manual file', async () => {
    const api = new MemoryDriveApi([
      manualPdf({ id: 'a' }),
      manualPdf({ id: 'b', name: '9-2026-studio-a-2026-08.pdf' }),
    ]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries.map((entry) => entry.state)).toEqual(['duplicate', 'duplicate']);
    expect(api.patchRequest('a')).toBeNull();
    expect(api.patchRequest('b')).toBeNull();
  });

  it('warns about malformed filenames without treating them as invoice actions', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([manualPdf({ name: 'invoice.pdf' })]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({
      key: null,
      invoiceNumber: null,
      state: 'malformed',
      sourceSha256: null,
      pdfSha256: null,
    });
    expect(scan.warnings).toEqual([expect.stringContaining('invoice.pdf')]);
    expect(scan.blockingConflicts).toEqual([]);
  });

  it('blocks a parse-failed filename that contains a Lotus managed property', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([manualPdf({ name: 'invoice.pdf', properties: { lotusSchema: '1' } })]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({
      key: null,
      invoiceNumber: null,
      state: 'corrupt',
    });
    expect(scan.warnings).toEqual([]);
    expect(scan.blockingConflicts).toEqual([
      {
        scope: 'global',
        kind: 'sequenceAmbiguity',
        message: expect.stringContaining('invoice.pdf'),
      },
    ]);
  });

  it('leaves a valid manual file unmanaged when no current studio source maps to it', async () => {
    const api = new MemoryDriveApi([manualPdf({ name: '8-2026-unknown-studio-2026-08.pdf' })]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({
      key: { studioSlug: 'unknown-studio', monthKey: '2026-08' },
      state: 'unmanaged',
    });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it('does not adopt when two current sources ambiguously map to one key', async () => {
    const api = new MemoryDriveApi([manualPdf()]);

    const scan = await scanFinalFolder(api, stagedRoot(), [
      currentSource(),
      currentSource('studio-a', '2026-08', {
        fingerprint: { sourceSha256: '3'.repeat(64), calendarSha256: '4'.repeat(64) },
      }),
    ]);

    expect(scan.entries[0]).toMatchObject({ state: 'unmanaged' });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it.each([
    ['one missing property', { lotusOperationId: undefined }],
    ['invalid schema', { lotusSchema: '2' }],
    ['invalid calendar hash', { lotusCalendarHash: 'not-a-hash' }],
    ['invalid source hash', { lotusSourceSha256: 'ABC' }],
    ['invalid PDF hash', { lotusPdfSha256: 'abc' }],
    ['blank operation ID', { lotusOperationId: ' ' }],
  ])('blocks managed metadata with %s', async (_label, propertyChange) => {
    const valid = await managedPdf();
    const properties = { ...valid.properties } as Record<string, string | undefined>;
    Object.assign(properties, propertyChange);
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) delete properties[key];
    }

    const scan = await scanFinalFolder(
      new MemoryDriveApi([{ ...valid, properties: properties as Record<string, string> }]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
    expect(scan.blockingConflicts).toHaveLength(1);
  });

  it.each([
    ['studio slug', { lotusStudioSlug: 'studio-b' }],
    ['month', { lotusMonth: '2026-09' }],
    ['invoice number', { lotusInvoiceNumber: '9/2026' }],
  ])('blocks managed metadata when the %s disagrees with the filename', async (_label, change) => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([await managedPdf('pdf-1', { properties: change })]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
  });

  it('allows unrelated standard properties beside the eight Lotus properties', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([
        await managedPdf('pdf-1', {
          properties: { anotherApplication: 'kept', lotusFutureHint: 'ignored' },
        }),
      ]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({ state: 'fresh' });
  });

  it('classifies a Drive SHA-256 mismatch as corrupt without downloading', async () => {
    const api = new MemoryDriveApi([await managedPdf('pdf-1', { sha256Checksum: 'f'.repeat(64) })]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
  });

  it('downloads and hashes exact bytes when Drive has no SHA-256', async () => {
    const file = await managedPdf('pdf-1', { sha256Checksum: null });
    const api = new MemoryDriveApi([file]);

    await expect(verifyDrivePdf(api, file)).resolves.toBe(await sha256Hex(PDF_BYTES));
    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);
    expect(scan.entries[0]).toMatchObject({ state: 'fresh' });
  });

  it('uses Drive SHA-256 for integrity even when download permission is unavailable', async () => {
    const file = await managedPdf('pdf-1', { canDownload: false });
    const api = new MemoryDriveApi([file]);

    await expect(verifyDrivePdf(api, file)).resolves.toBe(await sha256Hex(PDF_BYTES));
    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);
    expect(scan.entries[0]).toMatchObject({ state: 'permission' });
  });

  it('detects exact downloaded byte corruption when Drive has no SHA-256', async () => {
    const file = await managedPdf('pdf-1', { sha256Checksum: null });
    const api = new MemoryDriveApi([
      { ...file, bytes: OTHER_PDF_BYTES, size: String(OTHER_PDF_BYTES.byteLength) },
    ]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
  });

  it('rejects a managed fallback download that changes before fresh metadata GET', async () => {
    const file = await managedPdf('pdf-1', { sha256Checksum: null });
    class RacingManagedApi extends MemoryDriveApi {
      override async downloadFile(request: Parameters<MemoryDriveApi['downloadFile']>[0]) {
        const downloaded = await super.downloadFile(request);
        await super.patchMetadata({
          fileId: request.fileId,
          properties: { external: 'changed-after-download' },
          ifMatch: downloaded.file.etag!,
          supportsAllDrives: true,
        });
        return downloaded;
      }
    }
    const api = new RacingManagedApi([file]);

    await expect(verifyDrivePdf(api, api.file('pdf-1'))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('classifies a current canonical source mismatch as stale', async () => {
    const scan = await scanFinalFolder(new MemoryDriveApi([await managedPdf()]), stagedRoot(), [
      currentSource('studio-a', '2026-08', {
        config: {
          ...config(),
          teacher: { ...config().teacher, name: 'Changed Teacher' },
        },
      }),
    ]);

    expect(scan.entries[0]).toMatchObject({
      state: 'stale',
      sourceSha256: SOURCE_SHA,
      pdfSha256: await sha256Hex(PDF_BYTES),
    });
  });

  it('keeps a managed downloadable invoice verified when edit permission is absent', async () => {
    const readOnly = await managedPdf('pdf-1', { canEdit: false, canDownload: true });
    const api = new MemoryDriveApi([readOnly]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({
      state: 'fresh',
      file: { capabilities: { canDownload: true, canEdit: false } },
      pdfSha256: await sha256Hex(PDF_BYTES),
    });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it('derives first-scan freshness from the Drive entry invoice number', async () => {
    const numberedInvoice = invoice('8/2026');
    const expected = await fingerprintInvoiceSource(
      buildInvoiceSource({
        config: config(),
        classes: [],
        invoice: numberedInvoice,
        calendarId: 'calendar-id',
        invoiceNumber: '8/2026',
      })
    );
    const managed = await managedPdf('pdf-1', {
      properties: {
        lotusSourceSha256: expected.sourceSha256,
        lotusCalendarHash: expected.calendarSha256,
      },
    });
    const { invoiceNumber: _invoiceNumber, ...unnumberedInvoice } = numberedInvoice;
    const source = currentSource('studio-a', '2026-08', {
      invoice: unnumberedInvoice,
      fingerprint: {
        sourceSha256: '9'.repeat(64),
        calendarSha256: '8'.repeat(64),
      },
    });

    const scan = await scanFinalFolder(new MemoryDriveApi([managed]), stagedRoot(), [source]);

    expect(scan.entries[0]).toMatchObject({
      state: 'fresh',
      invoiceNumber: '8/2026',
      sourceSha256: expected.sourceSha256,
    });
  });

  it('keeps a historical managed file visible and integrity-checked without a current source', async () => {
    const good = await managedPdf('old', { name: '3-2025-old-studio-2025-02.pdf' });
    good.properties = {
      ...good.properties,
      lotusStudioSlug: 'old-studio',
      lotusMonth: '2025-02',
      lotusInvoiceNumber: '3/2025',
    };
    good.sha256Checksum = null;
    const api = new MemoryDriveApi([good]);

    const scan = await scanFinalFolder(api, stagedRoot(), []);

    expect(scan.entries[0]).toMatchObject({
      key: { studioSlug: 'old-studio', monthKey: '2025-02' },
      state: 'fresh',
      pdfSha256: await sha256Hex(PDF_BYTES),
    });
    expect(api.patchRequest('old')).toBeNull();
  });

  it.each([
    ['download', { canDownload: false, canEdit: true }],
    ['edit', { canDownload: true, canEdit: false }],
  ])('does not adopt without %s permission', async (_label, permissions) => {
    const api = new MemoryDriveApi([manualPdf(permissions)]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({ state: 'permission' });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it('does not label old downloaded bytes after the file changes before fresh metadata GET', async () => {
    const base = new MemoryDriveApi([manualPdf()]);
    class RacingApi extends MemoryDriveApi {
      private changed = false;

      constructor() {
        super([manualPdf()]);
      }

      override async getFile(request: Parameters<MemoryDriveApi['getFile']>[0]) {
        if (!this.changed && request.fileId === 'pdf-1') {
          this.changed = true;
          await base.patchMetadata({
            fileId: 'pdf-1',
            properties: { external: 'change' },
            ifMatch: '"pdf-1-v1"',
            supportsAllDrives: true,
          });
          return base.getFile(request);
        }
        return super.getFile(request);
      }
    }
    const api = new RacingApi();

    await expect(adoptManualPdf(api, api.file('pdf-1'), currentSource())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it('refuses adoption when Drive SHA-256 disagrees with the exact downloaded bytes', async () => {
    const api = new MemoryDriveApi([manualPdf({ sha256Checksum: 'f'.repeat(64) })]);

    await expect(adoptManualPdf(api, api.file('pdf-1'), currentSource())).rejects.toMatchObject({
      code: 'corrupt',
    });
    expect(api.patchRequest('pdf-1')).toBeNull();

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);
    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
    expect(api.patchRequest('pdf-1')).toBeNull();
  });

  it('uses the patched record and returns permission when adoption loses download capability', async () => {
    class CapabilityLossApi extends MemoryDriveApi {
      override async patchMetadata(request: Parameters<MemoryDriveApi['patchMetadata']>[0]) {
        const patched = await super.patchMetadata(request);
        return {
          ...patched,
          capabilities: { ...patched.capabilities, canDownload: false },
        };
      }
    }
    const api = new CapabilityLossApi([manualPdf()]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({
      file: {
        id: 'pdf-1',
        version: '2',
        etag: '"pdf-1-v2"',
        capabilities: { canDownload: false },
      },
      state: 'permission',
    });
    expect(scan.entries[0].file.properties.lotusSchema).toBe('1');
    expect(api.file('pdf-1').bytes).toEqual(PDF_BYTES);
  });

  it('uses the patched record as a verified read-only invoice when adoption loses edit capability', async () => {
    class CapabilityLossApi extends MemoryDriveApi {
      override async patchMetadata(request: Parameters<MemoryDriveApi['patchMetadata']>[0]) {
        const patched = await super.patchMetadata(request);
        return {
          ...patched,
          capabilities: { ...patched.capabilities, canEdit: false },
        };
      }
    }
    const api = new CapabilityLossApi([manualPdf()]);

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({
      file: {
        id: 'pdf-1',
        version: '2',
        etag: '"pdf-1-v2"',
        capabilities: { canDownload: true, canEdit: false },
      },
      state: 'fresh',
    });
    expect(api.file('pdf-1').bytes).toEqual(PDF_BYTES);
  });

  it('follows every page, de-duplicates repeated IDs, and sorts deterministically', async () => {
    class RepeatingFirstItemApi extends MemoryDriveApi {
      override async listFiles(request: Parameters<MemoryDriveApi['listFiles']>[0]) {
        const page = await super.listFiles(request);
        return request.pageToken == null && page.items[0] != null
          ? { ...page, items: [page.items[0], page.items[0]] }
          : page;
      }
    }
    const api = new RepeatingFirstItemApi(
      [
        await managedPdf('z', {
          name: '9-2026-studio-b-2026-09.pdf',
          properties: {
            lotusStudioSlug: 'studio-b',
            lotusMonth: '2026-09',
            lotusInvoiceNumber: '9/2026',
          },
        }),
        await managedPdf('a'),
        manualPdf({ id: 'm', name: 'bad.pdf' }),
      ],
      { maxPageSize: 1 }
    );

    const scan = await scanFinalFolder(api, stagedRoot(), [currentSource()]);

    expect(scan.entries.map((entry) => entry.file.id)).toEqual(['a', 'm', 'z']);
  });

  it('tracks the maximum safe parsed sequence independently for each year', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([
        manualPdf({ id: 'one', name: '8-2026-studio-a-2026-08.pdf' }),
        manualPdf({ id: 'two', name: '12-2026-studio-b-2026-09.pdf' }),
        manualPdf({ id: 'three', name: '7-2025-studio-a-2025-01.pdf' }),
        manualPdf({ id: 'bad', name: '9007199254740992-2026-studio-c-2026-10.pdf' }),
      ]),
      stagedRoot(),
      []
    );

    expect(scan.maxSequenceByYear).toEqual({ '2025': 7, '2026': 12 });
  });

  it('uses Shared Drive list scope and adopts through supportsAllDrives', async () => {
    const driveId = 'shared-drive-1';
    const file = manualPdf({ driveId });
    const api = new MemoryDriveApi([file]);

    const scan = await scanFinalFolder(api, stagedRoot(driveId), [currentSource()]);

    expect(scan.entries[0]).toMatchObject({ state: 'fresh' });
  });

  it('rejects a staged root whose Final folder location is incoherent', async () => {
    const staged = stagedRoot();
    staged.finalFolder = { ...staged.finalFolder, parents: ['somewhere-else'] };

    await expect(
      scanFinalFolder(new MemoryDriveApi([manualPdf()]), staged, [currentSource()])
    ).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('blocks a canonical filename with a non-PDF MIME type', async () => {
    const scan = await scanFinalFolder(
      new MemoryDriveApi([manualPdf({ mimeType: 'text/plain' })]),
      stagedRoot(),
      [currentSource()]
    );

    expect(scan.entries[0]).toMatchObject({ state: 'corrupt' });
  });

  it('increments opaque Drive versions above Number.MAX_SAFE_INTEGER exactly', async () => {
    const api = new MemoryDriveApi([
      {
        ...manualPdf(),
        version: '9007199254740992',
        etag: '"pdf-1-v9007199254740992"',
      },
    ]);

    const patched = await api.patchMetadata({
      fileId: 'pdf-1',
      properties: { external: 'changed' },
      ifMatch: '"pdf-1-v9007199254740992"',
      supportsAllDrives: true,
    });

    expect(patched.version).toBe('9007199254740993');
    expect(patched.etag).toBe('"pdf-1-v9007199254740993"');
  });

  it('mirrors Drive PATCH property merge semantics during media updates', async () => {
    const before = manualPdf({ properties: { unrelated: 'preserved', lotusSchema: 'old' } });
    const finalFolder: MemoryDriveFile = {
      ...folder(FINAL_FOLDER_ID, 'Final', [ROOT_FOLDER_ID]),
      bytes: new Uint8Array(),
    };
    const api = new MemoryDriveApi([finalFolder, before]);

    await api.updateFile({
      fileId: before.id,
      name: before.name,
      mimeType: before.mimeType,
      parents: [...before.parents],
      properties: { lotusSchema: '1' },
      bytes: Array.from(OTHER_PDF_BYTES),
      supportsAllDrives: true,
      ifMatch: before.etag!,
    });

    expect(api.file(before.id).properties).toEqual({
      unrelated: 'preserved',
      lotusSchema: '1',
    });
  });

  it('mirrors production by omitting ETags from Memory Drive list records only', async () => {
    const api = new MemoryDriveApi([manualPdf()]);

    const page = await api.listFiles({
      query: "'final-folder' in parents and trashed = false",
      corpora: 'user',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    expect(page.items[0].etag).toBeNull();
    expect(api.file('pdf-1').etag).toBe('"pdf-1-v1"');
    const downloaded = await api.downloadFile({ fileId: 'pdf-1', supportsAllDrives: true });
    expect(downloaded.file.etag).toBe('"pdf-1-v1"');
  });
});
