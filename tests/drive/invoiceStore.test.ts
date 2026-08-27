import type { DriveApi } from '../../src/lib/drive/api.js';
import type { DriveControl, InvoiceReservation } from '../../src/lib/drive/controlFile.js';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type {
  CurrentInvoiceSource,
  DriveInvoiceEntry,
} from '../../src/lib/drive/invoiceCatalog.js';
import { DriveInvoiceStore, type FinalizationInput } from '../../src/lib/drive/invoiceStore.js';
import { finalizedFilename } from '../../src/lib/invoice/finalization.js';
import {
  buildInvoiceSource,
  fingerprintInvoiceSource,
  sha256Hex,
} from '../../src/lib/invoice/sourceFingerprint.js';
import {
  DriveError,
  type DriveFileRecord,
  type LotusPdfProperties,
} from '../../src/lib/drive/types.js';
import type { AppConfig, Invoice } from '../../src/lib/types.js';
import { MemoryDriveApi, type MemoryDriveFile } from './memoryDriveApi.js';

const ROOT_ID = 'invoice-root';
const FINAL_ID = 'invoice-final';
const CONTROL_ID = 'invoice-control';
const FIXED_NOW = '2026-08-24T12:00:00.000Z';
const PDF_BYTES = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 49]);
const UPDATED_PDF_BYTES = Uint8Array.from([...PDF_BYTES, 10, 50]);

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
): MemoryDriveFile {
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
    capabilities: capabilities({
      canListChildren: true,
      canAddChildren: true,
      canDownload: false,
    }),
    etag: `"${id}-v1"`,
    bytes: new Uint8Array(),
  };
}

function stagedRoot(driveId: string | null = null): StagedDriveRoot {
  const root = folder(ROOT_ID, 'Lotus Invoices', driveId === null ? ['root'] : [], driveId);
  const final = folder(FINAL_ID, 'Final', [ROOT_ID], driveId);
  return {
    root: { folderId: ROOT_ID, driveId, folderName: root.name },
    rootFile: root,
    finalFolder: final,
  };
}

function config(): AppConfig {
  return {
    teacher: {
      name: 'Teacher',
      address: 'Teacher Street',
      taxNumber: 'Tax',
      bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
    },
    calendarId: 'calendar-id',
    outputDir: '/unused',
    lastInvoice: '8/2026',
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

function invoice(invoiceNumber?: string): Invoice {
  return {
    studioName: 'Studio A',
    invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    generatedAt: FIXED_NOW,
    issueDate: '2026-08-24',
    classes: [],
    totalClasses: 0,
    totalAmount: 0,
    ...(invoiceNumber === undefined ? {} : { invoiceNumber }),
  };
}

function finalizationInput(): FinalizationInput {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    invoice: invoice(),
    classes: [],
    config: config(),
  };
}

async function currentSource(
  invoiceNumber = '8/2026',
  overrides: Partial<CurrentInvoiceSource> = {}
): Promise<CurrentInvoiceSource> {
  const finalizedInvoice = invoice(invoiceNumber);
  const source = buildInvoiceSource({
    config: config(),
    classes: [],
    invoice: finalizedInvoice,
    calendarId: 'calendar-id',
    invoiceNumber,
  });
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    studioName: 'Studio A',
    invoice: finalizedInvoice,
    classes: [],
    config: config(),
    fingerprint: await fingerprintInvoiceSource(source),
    ...overrides,
  };
}

function initialControl(
  sequence2026 = 8,
  reservation: InvoiceReservation | null = null,
  root: StagedDriveRoot = stagedRoot()
): DriveControl {
  return {
    schemaVersion: 1,
    generation: 1,
    root: { ...root.root },
    finalFolderId: root.finalFolder.id,
    sequenceByYear: { '2026': sequence2026 },
    reservation,
  };
}

function controlFile(control: DriveControl): MemoryDriveFile {
  const bytes = new TextEncoder().encode(JSON.stringify(control));
  return {
    id: CONTROL_ID,
    name: '.lotus-teaching-invoices.json',
    mimeType: 'application/json',
    parents: [control.root.folderId],
    driveId: control.root.driveId,
    ownedByMe: control.root.driveId === null,
    trashed: false,
    version: '1',
    size: String(bytes.byteLength),
    md5Checksum: null,
    sha256Checksum: null,
    properties: { lotusConfigSchema: '1' },
    capabilities: capabilities(),
    etag: `"${CONTROL_ID}-v1"`,
    bytes,
  };
}

function configuredDrive(
  options: {
    sequence2026?: number;
    reservation?: InvoiceReservation | null;
    driveId?: string | null;
    extraFiles?: readonly MemoryDriveFile[];
  } = {}
): MemoryDriveFile[] {
  const root = stagedRoot(options.driveId ?? null);
  return [
    root.rootFile as MemoryDriveFile,
    root.finalFolder as MemoryDriveFile,
    controlFile(initialControl(options.sequence2026 ?? 8, options.reservation ?? null, root)),
    ...(options.extraFiles ?? []),
  ];
}

async function managedPdf(options: {
  id: string;
  invoiceNumber?: string;
  operationId?: string;
  source?: CurrentInvoiceSource;
  bytes?: Uint8Array;
  driveId?: string | null;
  sourceSha256?: string;
  etag?: string | null;
  extraProperties?: Record<string, string>;
  canEdit?: boolean;
  canDownload?: boolean;
}): Promise<MemoryDriveFile> {
  const invoiceNumber = options.invoiceNumber ?? '8/2026';
  const source = options.source ?? (await currentSource(invoiceNumber));
  const bytes = options.bytes ?? PDF_BYTES;
  const pdfSha = await sha256Hex(bytes);
  const properties: LotusPdfProperties = {
    lotusSchema: '1',
    lotusCalendarHash: source.fingerprint.calendarSha256,
    lotusStudioSlug: source.key.studioSlug,
    lotusMonth: source.key.monthKey,
    lotusInvoiceNumber: invoiceNumber,
    lotusSourceSha256: options.sourceSha256 ?? source.fingerprint.sourceSha256,
    lotusPdfSha256: pdfSha,
    lotusOperationId: options.operationId ?? 'existing-operation',
  };
  return {
    id: options.id,
    name: finalizedFilename('studio-a', '2026', '08', invoiceNumber),
    mimeType: 'application/pdf',
    parents: [FINAL_ID],
    driveId: options.driveId ?? null,
    ownedByMe: (options.driveId ?? null) === null,
    trashed: false,
    version: '3',
    size: String(bytes.byteLength),
    md5Checksum: null,
    sha256Checksum: pdfSha,
    properties: { ...options.extraProperties, ...properties },
    capabilities: capabilities({
      canEdit: options.canEdit ?? true,
      canDownload: options.canDownload ?? true,
    }),
    etag: options.etag === undefined ? `"${options.id}-v3"` : options.etag,
    bytes,
  };
}

function makeStore(
  api: DriveApi,
  options: {
    operationIds?: readonly string[];
    renderBytes?: Uint8Array;
    now?: string;
  } = {}
): DriveInvoiceStore {
  const operationIds = [...(options.operationIds ?? ['op-1', 'op-2', 'op-3'])];
  return new DriveInvoiceStore(api, {
    renderFinalPdf: vi.fn(async () => new Uint8Array(options.renderBytes ?? PDF_BYTES)),
    createOperationId: () => operationIds.shift() ?? 'op-fallback',
    now: () => options.now ?? FIXED_NOW,
  });
}

async function bootstrappedStore(
  api: DriveApi,
  source?: CurrentInvoiceSource,
  options: Parameters<typeof makeStore>[1] = {}
): Promise<DriveInvoiceStore> {
  const store = makeStore(api, options);
  await store.bootstrap([source ?? (await currentSource())]);
  return store;
}

function conflict412(fileId: string): DriveError {
  return new DriveError('conflict', 'secret response body', false, 412, fileId);
}

describe('DriveInvoiceStore activation and bootstrap', () => {
  it('scans before activation and seeds each year from scan plus one strict legacy number', async () => {
    const source2026 = await currentSource('12/2026');
    const existing = await managedPdf({
      id: 'pdf-12',
      invoiceNumber: '12/2026',
      source: source2026,
    });
    const root = stagedRoot();
    const api = new MemoryDriveApi([
      root.rootFile as MemoryDriveFile,
      root.finalFolder as MemoryDriveFile,
      existing,
    ]);
    const store = makeStore(api);

    const snapshot = await store.activateRoot(root, [source2026], '15/2026');

    expect(snapshot.control.control.sequenceByYear).toEqual({ '2026': 15 });
    expect(snapshot.scan.entries[0]).toMatchObject({ file: { id: 'pdf-12' }, state: 'fresh' });
    expect(api.mutations()).toEqual(['control:create:generated-file-1']);
  });

  it('rejects malformed legacy numbering without writing a control pointer', async () => {
    const root = stagedRoot();
    const api = new MemoryDriveApi([
      root.rootFile as MemoryDriveFile,
      root.finalFolder as MemoryDriveFile,
    ]);
    const store = makeStore(api);

    await expect(store.activateRoot(root, [], '15 / 2026')).rejects.toMatchObject({
      code: 'invalidState',
    });
    expect(api.mutations()).toEqual([]);
  });

  it.each(['', '   ', '\t\n'])(
    'treats blank legacy numbering %j as no activation seed',
    async (seed) => {
      const root = stagedRoot();
      const api = new MemoryDriveApi([
        root.rootFile as MemoryDriveFile,
        root.finalFolder as MemoryDriveFile,
      ]);

      const snapshot = await makeStore(api).activateRoot(root, [], seed);

      expect(snapshot.control.control.sequenceByYear).toEqual({});
      expect(api.mutations()).toEqual(['control:create:generated-file-1']);
    }
  );

  it('blocks root replacement while a reservation is active', async () => {
    const source9 = await currentSource('9/2026');
    const reservation: InvoiceReservation = {
      operationId: 'pending-op',
      year: 2026,
      invoiceNumber: '9/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'pending-file',
      sourceSha256: source9.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    const api = new MemoryDriveApi(configuredDrive({ reservation }));
    const store = makeStore(api);

    await expect(store.activateRoot(stagedRoot(), [source9], undefined)).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.mutations()).toEqual([]);
  });

  it('bootstraps only the recorded exact root and Final and never stages a replacement', async () => {
    const extraFinal = folder('other-final', 'Final', [ROOT_ID]);
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [extraFinal] }));
    const createFolder = vi.spyOn(api, 'createFolder');
    const store = makeStore(api);

    await expect(store.bootstrap([])).rejects.toMatchObject({ code: 'duplicate' });
    expect(createFolder).not.toHaveBeenCalled();
    expect(api.mutations()).toEqual([]);
  });

  it('moves a legacy root-level control file into its recorded Lotus folder during bootstrap', async () => {
    const api = new MemoryDriveApi(
      configuredDrive().map((file) =>
        file.id === CONTROL_ID
          ? { ...file, parents: ['root'], driveId: null, ownedByMe: true }
          : file
      )
    );

    const snapshot = await makeStore(api).bootstrap([]);

    expect(snapshot?.control.file.parents).toEqual([ROOT_ID]);
    expect(api.file(CONTROL_ID).parents).toEqual([ROOT_ID]);
  });

  it('blocks when the recorded Final is no longer its root direct child', async () => {
    const files = configuredDrive().map((file) =>
      file.id === FINAL_ID ? { ...file, parents: ['other-root'] } : file
    );
    const api = new MemoryDriveApi(files);

    await expect(makeStore(api).bootstrap([])).rejects.toMatchObject({ code: 'corrupt' });
    expect(api.mutations()).toEqual([]);
  });
});

describe('DriveInvoiceStore finalization transaction', () => {
  it('reserves, uploads, verifies, then commits one new number', async () => {
    const api = new MemoryDriveApi(configuredDrive({ sequence2026: 8 }));
    const store = await bootstrappedStore(api);
    const download = vi.spyOn(api, 'downloadFile');

    const result = await store.finalize(finalizationInput());

    expect(result.invoiceNumber).toBe('9/2026');
    expect(result.file.id).toBe('generated-file-1');
    expect(result.state).toBe('fresh');
    expect(api.control().sequenceByYear['2026']).toBe(9);
    expect(api.control().reservation).toBeNull();
    expect(api.mutations()).toEqual([
      'control:reserve:if-match',
      'pdf:create:generated-file-1',
      'pdf:get:generated-file-1',
      'control:commit:if-match',
    ]);
    expect(
      download.mock.calls.filter(([request]) => request.fileId === result.file.id)
    ).toHaveLength(1);
    expect(Object.keys(api.file('generated-file-1').properties).sort()).toEqual([
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

  it('does not render or upload when reservation CAS loses a pre-upload race', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const originalUpdate = api.updateFile.bind(api);
    const update = vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation !== null) throw conflict412(CONTROL_ID);
      return originalUpdate(request);
    });
    const render = vi.fn(async () => PDF_BYTES);
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'op-1',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([await currentSource()]);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    });
    expect(render).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(api.mutations()).toEqual([]);
    expect(api.control().reservation).toBeNull();
  });

  it('recognizes a reservation installed despite a lost control response', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const render = vi.fn(async () => PDF_BYTES);
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'op-1',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([await currentSource()]);
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation !== null) {
        await originalUpdate(request);
        throw new DriveError('server', 'lost reservation response', true, 503, CONTROL_ID);
      }
      return originalUpdate(request);
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(render).not.toHaveBeenCalled();
    expect(api.control().reservation).toMatchObject({
      operationId: 'op-1',
      fileId: 'generated-file-1',
      invoiceNumber: '9/2026',
    });
  });

  it.each([
    ['a 412 from a retried conditional write', conflict412(CONTROL_ID)],
    [
      'an invalid response after dispatch',
      new DriveError(
        'invalidResponse',
        'lost reservation response validation',
        false,
        undefined,
        CONTROL_ID
      ),
    ],
  ] as const)(
    'rediscovers an installed reservation after %s',
    async (_failureKind, postDispatchFailure) => {
      const api = new MemoryDriveApi(configuredDrive());
      const render = vi.fn(async () => PDF_BYTES);
      const store = new DriveInvoiceStore(api, {
        renderFinalPdf: render,
        createOperationId: () => 'op-1',
        now: () => FIXED_NOW,
      });
      await store.bootstrap([await currentSource()]);
      const originalUpdate = api.updateFile.bind(api);
      vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
        const next = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(request.bytes))
        ) as DriveControl;
        if (request.fileId === CONTROL_ID && next.reservation !== null) {
          await originalUpdate(request);
          throw postDispatchFailure;
        }
        return originalUpdate(request);
      });

      await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
        code: 'recoveryRequired',
      });
      expect(render).not.toHaveBeenCalled();
      expect(api.control().reservation).toMatchObject({
        operationId: 'op-1',
        fileId: 'generated-file-1',
        invoiceNumber: '9/2026',
      });
      expect(api.mutations()).toEqual(['control:reserve:if-match']);
    }
  );

  it('reports a competing reservation installed before a lost control response', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const render = vi.fn(async () => PDF_BYTES);
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'op-1',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([await currentSource()]);
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation !== null) {
        await originalUpdate({
          ...request,
          bytes: Array.from(
            new TextEncoder().encode(
              JSON.stringify({
                ...next,
                reservation: {
                  ...next.reservation,
                  operationId: 'competing-op',
                  fileId: 'competing-file',
                },
              })
            )
          ),
        });
        throw new DriveError('server', 'lost competing response', true, 503, CONTROL_ID);
      }
      return originalUpdate(request);
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({ code: 'conflict' });
    expect(render).not.toHaveBeenCalled();
    expect(api.control().reservation).toMatchObject({
      operationId: 'competing-op',
      fileId: 'competing-file',
    });
  });

  it('requires recovery when control cannot be reloaded after a lost reservation response', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = await bootstrappedStore(api);
    const originalUpdate = api.updateFile.bind(api);
    const originalList = api.listFiles.bind(api);
    let responseLost = false;
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation !== null) {
        await originalUpdate(request);
        responseLost = true;
        throw new DriveError('server', 'lost reservation response', true, 503, CONTROL_ID);
      }
      return originalUpdate(request);
    });
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      if (responseLost && request.query.includes('lotusConfigSchema')) {
        throw new DriveError('offline', 'reload unavailable', true);
      }
      return originalList(request);
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toMatchObject({
      operationId: 'op-1',
      fileId: 'generated-file-1',
    });
  });

  it('maps definite reservation permission and not-found failures precisely', async () => {
    for (const [lower, expected] of [
      [new DriveError('permission', 'denied', false, 403, CONTROL_ID), 'permission'],
      [new DriveError('notFound', 'gone', false, 404, CONTROL_ID), 'corrupt'],
    ] as const) {
      const api = new MemoryDriveApi(configuredDrive());
      const store = await bootstrappedStore(api);
      const originalUpdate = api.updateFile.bind(api);
      vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
        const next = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(request.bytes))
        ) as DriveControl;
        if (request.fileId === CONTROL_ID && next.reservation !== null) throw lower;
        return originalUpdate(request);
      });

      await expect(store.finalize(finalizationInput())).rejects.toMatchObject({ code: expected });
      expect(api.control().reservation).toBeNull();
    }
  });

  it('maps clearly pre-request authorization failure without ambiguous-write rediscovery', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = await bootstrappedStore(api);
    const originalUpdate = api.updateFile.bind(api);
    const list = vi.spyOn(api, 'listFiles');
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation !== null) {
        throw new DriveError('authorization', 'authorization expired before request', true);
      }
      return originalUpdate(request);
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'authorizationRequired',
    });
    expect(api.control().reservation).toBeNull();
    expect(
      list.mock.calls.filter(([request]) => request.query.includes('lotusConfigSchema'))
    ).toHaveLength(1);
    expect(
      list.mock.calls.filter(([request]) => request.query.includes(`'${FINAL_ID}' in parents`))
    ).toHaveLength(1);
  });

  it('leaves a durable reservation and upload after a lost create response', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const originalCreate = api.createFile.bind(api);
    vi.spyOn(api, 'createFile').mockImplementation(async (request) => {
      const created = await originalCreate(request);
      if (request.mimeType === 'application/pdf') {
        throw new DriveError('offline', 'access-token=must-not-leak', true, undefined, created.id);
      }
      return created;
    });
    const store = await bootstrappedStore(api);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
      message: expect.not.stringContaining('access-token'),
    });
    expect(api.control().reservation).toMatchObject({
      operationId: 'op-1',
      fileId: 'generated-file-1',
      invoiceNumber: '9/2026',
    });
    expect(api.file('generated-file-1').properties.lotusOperationId).toBe('op-1');
  });

  it('does not advance again when recovery follows a lost commit response', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation === null) {
        await originalUpdate(request);
        throw new DriveError('server', 'private server response', true, 503, CONTROL_ID);
      }
      return originalUpdate(request);
    });
    const store = await bootstrappedStore(api);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 9 },
      reservation: null,
    });
    expect(api.file('generated-file-1').id).toBe('generated-file-1');

    const mutations = api.mutations();
    vi.restoreAllMocks();
    const recovered = await makeStore(api).recoverReservation([await currentSource('9/2026')]);
    expect(recovered.control.control).toMatchObject({
      sequenceByYear: { '2026': 9 },
      reservation: null,
    });
    expect(api.mutations()).toEqual(mutations);
  });

  it('reports an invalid render as recovery after the reservation is durable', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = await bootstrappedStore(api, undefined, {
      renderBytes: new Uint8Array(),
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: { operationId: 'op-1', fileId: 'generated-file-1' },
    });
  });

  it('blocks an existing invoice identity before reserving another number', async () => {
    const source = await currentSource();
    const existing = await managedPdf({ id: 'pdf-8', source });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [existing] }));
    const store = await bootstrappedStore(api, source);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({ code: 'duplicate' });
    expect(api.control().reservation).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it('finalizes when the only catalog conflict belongs to another studio and month', async () => {
    const source = await currentSource();
    const unrelatedA = {
      ...(await managedPdf({ id: 'unrelated-a', source })),
      name: '1-2026-studio-b-2026-07.pdf',
    };
    const unrelatedB = {
      ...(await managedPdf({ id: 'unrelated-b', source })),
      name: '2-2026-studio-b-2026-07.pdf',
    };
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [unrelatedA, unrelatedB] }));
    const store = await bootstrappedStore(api, source);

    await expect(store.finalize(finalizationInput())).resolves.toMatchObject({
      invoiceNumber: '9/2026',
      state: 'fresh',
    });
    expect(api.control()).toMatchObject({ sequenceByYear: { '2026': 9 }, reservation: null });
  });

  it('keeps the reservation when exact upload verification finds changed properties', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const originalGet = api.getFile.bind(api);
    vi.spyOn(api, 'getFile').mockImplementation(async (request) => {
      const exact = await originalGet(request);
      return exact.mimeType === 'application/pdf'
        ? { ...exact, properties: { ...exact.properties, lotusInvoiceNumber: '99/2026' } }
        : exact;
    });
    const store = await bootstrappedStore(api);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).not.toBeNull();
    expect(api.control().sequenceByYear['2026']).toBe(8);
  });
});

describe('DriveInvoiceStore reservation recovery', () => {
  async function reservationFixture(sourceHash?: string): Promise<{
    source: CurrentInvoiceSource;
    reservation: InvoiceReservation;
  }> {
    const source = await currentSource('9/2026');
    return {
      source,
      reservation: {
        operationId: 'recover-op',
        year: 2026,
        invoiceNumber: '9/2026',
        studioSlug: 'studio-a',
        month: '2026-08',
        fileId: 'reserved-file',
        sourceSha256: sourceHash ?? source.fingerprint.sourceSha256,
        startedAt: FIXED_NOW,
      },
    };
  }

  it('commits exactly one verified upload bound to reserved file and operation IDs', async () => {
    const { source, reservation } = await reservationFixture();
    const uploaded = await managedPdf({
      id: reservation.fileId,
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [uploaded] }));
    const store = makeStore(api);
    const download = vi.spyOn(api, 'downloadFile');

    const snapshot = await store.recoverReservation([source]);

    expect(snapshot.control.control.reservation).toBeNull();
    expect(snapshot.control.control.sequenceByYear['2026']).toBe(9);
    expect(snapshot.scan.entries).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ id: 'reserved-file' }),
        state: 'fresh',
      }),
    ]);
    expect(api.mutations()).toEqual(['pdf:get:reserved-file', 'control:commit:if-match']);
    expect(
      download.mock.calls.filter(([request]) => request.fileId === reservation.fileId)
    ).toHaveLength(1);
  });

  it('resumes a zero-upload reservation only when its rebuilt canonical source matches', async () => {
    const { source, reservation } = await reservationFixture();
    const api = new MemoryDriveApi(configuredDrive({ reservation }));
    const store = makeStore(api);

    const snapshot = await store.recoverReservation([source]);

    expect(snapshot.control.control.sequenceByYear['2026']).toBe(9);
    expect(snapshot.control.control.reservation).toBeNull();
    expect(snapshot.scan.entries[0]).toMatchObject({
      file: { id: 'reserved-file' },
      invoiceNumber: '9/2026',
      state: 'fresh',
    });
    expect(api.mutations()).toEqual([
      'pdf:create:reserved-file',
      'pdf:get:reserved-file',
      'control:commit:if-match',
    ]);
  });

  it('blocks a zero-upload source mismatch without changing the reservation', async () => {
    const { source, reservation } = await reservationFixture('f'.repeat(64));
    const api = new MemoryDriveApi(configuredDrive({ reservation }));

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(reservation);
    expect(api.mutations()).toEqual([]);
  });

  it('blocks ambiguous operation uploads without changing the reservation', async () => {
    const { source, reservation } = await reservationFixture();
    const first = await managedPdf({
      id: reservation.fileId,
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const second = await managedPdf({
      id: 'other-file',
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [first, second] }), {
      maxPageSize: 1,
    });

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(reservation);
    expect(api.mutations()).toEqual([]);
  });

  it('deduplicates coherent reserved uploads repeated across reconciliation pages', async () => {
    const { source, reservation } = await reservationFixture();
    const uploaded = await managedPdf({
      id: reservation.fileId,
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [uploaded] }));
    const originalList = api.listFiles.bind(api);
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      if (
        !request.query.includes(`'${FINAL_ID}' in parents`) ||
        api.control().reservation === null
      ) {
        return originalList(request);
      }
      return {
        items: [{ ...uploaded, etag: null }],
        nextPageToken: request.pageToken === undefined ? 'duplicate-page' : null,
      };
    });

    const snapshot = await makeStore(api).recoverReservation([source]);

    expect(snapshot.control.control).toMatchObject({
      sequenceByYear: { '2026': 9 },
      reservation: null,
    });
    expect(api.mutations()).toEqual(['pdf:get:reserved-file', 'control:commit:if-match']);
  });

  it('rejects a repeated reconciliation page token without mutating Drive', async () => {
    const { source, reservation } = await reservationFixture();
    const uploaded = await managedPdf({
      id: reservation.fileId,
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [uploaded] }));
    const originalList = api.listFiles.bind(api);
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      if (!request.query.includes(`'${FINAL_ID}' in parents`)) return originalList(request);
      return {
        items: [{ ...uploaded, etag: null }],
        nextPageToken: 'repeated-page',
      };
    });

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'corrupt',
    });
    expect(api.control().reservation).toEqual(reservation);
    expect(api.mutations()).toEqual([]);
  });

  it('does not accept an operation match at a different file ID', async () => {
    const { source, reservation } = await reservationFixture();
    const wrongId = await managedPdf({
      id: 'other-file',
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [wrongId] }));

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(reservation);
  });

  it('does not commit beside another upload for the reserved invoice identity', async () => {
    const { source, reservation } = await reservationFixture();
    const reserved = await managedPdf({
      id: reservation.fileId,
      invoiceNumber: reservation.invoiceNumber,
      operationId: reservation.operationId,
      source,
    });
    const unrelatedOperation = await managedPdf({
      id: 'other-file',
      invoiceNumber: reservation.invoiceNumber,
      operationId: 'other-operation',
      source,
    });
    const api = new MemoryDriveApi(
      configuredDrive({ reservation, extraFiles: [reserved, unrelatedOperation] })
    );

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(reservation);
    expect(api.control().sequenceByYear['2026']).toBe(8);
  });

  it('blocks another finalized invoice number for the reserved studio and month', async () => {
    const { source, reservation } = await reservationFixture();
    const existingSource = await currentSource('8/2026');
    const otherNumber = await managedPdf({
      id: 'existing-number',
      invoiceNumber: '8/2026',
      operationId: 'existing-operation',
      source: existingSource,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [otherNumber] }));

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(reservation);
    expect(api.mutations()).toEqual([]);
  });
});

describe('DriveInvoiceStore guarded replacement and download', () => {
  it('preserves file ID and number during re-finalization and does not advance sequence', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source, {
      operationIds: ['refinalize-op'],
      renderBytes: UPDATED_PDF_BYTES,
    });
    const selected = (await store.refresh([source])).scan.entries[0]!;

    const result = await store.refinalize(finalizationInput(), selected);

    expect(result.file.id).toBe('pdf-8');
    expect(result.invoiceNumber).toBe('8/2026');
    expect(result.state).toBe('fresh');
    expect(api.updateRequest('pdf-8')?.ifMatch).toBe('"pdf-8-v3"');
    expect(api.control().sequenceByYear['2026']).toBe(8);
    expect(api.control().reservation).toBeNull();
  });

  it('re-finalizes when the only catalog conflict belongs to another studio and month', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const unrelatedA = {
      ...(await managedPdf({ id: 'unrelated-a', source })),
      name: '1-2026-studio-b-2026-07.pdf',
    };
    const unrelatedB = {
      ...(await managedPdf({ id: 'unrelated-b', source })),
      name: '2-2026-studio-b-2026-07.pdf',
    };
    const api = new MemoryDriveApi(
      configuredDrive({ extraFiles: [stale, unrelatedA, unrelatedB] })
    );
    const store = await bootstrappedStore(api, source, { renderBytes: UPDATED_PDF_BYTES });
    const selected = (await store.refresh([source])).scan.entries.find(
      (entry) => entry.file.id === stale.id
    )!;

    await expect(store.refinalize(finalizationInput(), selected)).resolves.toMatchObject({
      file: { id: 'pdf-8' },
      invoiceNumber: '8/2026',
      state: 'fresh',
    });
    expect(api.control()).toMatchObject({ sequenceByYear: { '2026': 8 }, reservation: null });
  });

  it.each([
    ['a 412 from a retried conditional write', conflict412('pdf-8')],
    [
      'an invalid response after dispatch',
      new DriveError(
        'invalidResponse',
        'lost PDF update response validation',
        false,
        undefined,
        'pdf-8'
      ),
    ],
  ] as const)(
    'verifies and commits an applied re-finalization after %s without another PDF update',
    async (_failureKind, postDispatchFailure) => {
      const source = await currentSource('8/2026');
      const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
      const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
      const store = await bootstrappedStore(api, source, {
        operationIds: ['refinalize-op'],
        renderBytes: UPDATED_PDF_BYTES,
      });
      const selected = (await store.refresh([source])).scan.entries[0]!;
      const originalUpdate = api.updateFile.bind(api);
      const update = vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
        if (request.fileId === 'pdf-8') {
          await originalUpdate(request);
          throw postDispatchFailure;
        }
        return originalUpdate(request);
      });
      const download = vi.spyOn(api, 'downloadFile');

      await expect(store.refinalize(finalizationInput(), selected)).resolves.toMatchObject({
        file: { id: 'pdf-8' },
        invoiceNumber: '8/2026',
        state: 'fresh',
      });
      expect(update.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(1);
      expect(api.mutations().filter((mutation) => mutation === 'pdf:update:pdf-8')).toHaveLength(1);
      expect(download.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(2);
      expect(api.file('pdf-8').bytes).toEqual(UPDATED_PDF_BYTES);
      expect(api.file('pdf-8').properties.lotusOperationId).toBe('refinalize-op');
      expect(api.control()).toMatchObject({
        sequenceByYear: { '2026': 8 },
        reservation: null,
      });
    }
  );

  it('never retries a re-finalization 412 remote-change conflict', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    const concurrentBytes = Uint8Array.from([...PDF_BYTES, 99]);
    const concurrentPdfSha = await sha256Hex(concurrentBytes);
    const originalUpdate = api.updateFile.bind(api);
    const update = vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === 'pdf-8') {
        const current = api.file(request.fileId);
        await originalUpdate({
          ...request,
          name: current.name,
          parents: [...current.parents],
          properties: {
            ...current.properties,
            lotusPdfSha256: concurrentPdfSha,
            concurrentWriter: 'preserved',
          },
          bytes: Array.from(concurrentBytes),
        });
        throw conflict412(request.fileId);
      }
      return originalUpdate(request);
    });
    const download = vi.spyOn(api, 'downloadFile');

    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(update.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(1);
    expect(api.control().sequenceByYear['2026']).toBe(8);
    expect(api.control().reservation).toBeNull();
    expect(download.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(2);
    expect(api.file('pdf-8').bytes).toEqual(concurrentBytes);
    expect(api.file('pdf-8').properties.concurrentWriter).toBe('preserved');
    expect(api.mutations().filter((mutation) => mutation === 'pdf:update:pdf-8')).toHaveLength(1);
  });

  it('requires recovery when re-finalization lease cleanup loses its response', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === 'pdf-8') throw conflict412(request.fileId);
      const next = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(request.bytes))
      ) as DriveControl;
      if (request.fileId === CONTROL_ID && next.reservation === null) {
        await originalUpdate(request);
        throw new DriveError('server', 'lost lease cleanup response', true, 503, CONTROL_ID);
      }
      return originalUpdate(request);
    });

    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control()).toMatchObject({ sequenceByYear: { '2026': 8 }, reservation: null });
    expect(api.mutations()).not.toContain('pdf:update:pdf-8');
  });

  it.each([
    [new DriveError('permission', 'denied', false, 403, 'pdf-8'), 'permission'],
    [new DriveError('notFound', 'gone', false, 404, 'pdf-8'), 'corrupt'],
  ] as const)(
    'clears the re-finalization lease after a definite %s update failure',
    async (lower, code) => {
      const source = await currentSource('8/2026');
      const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
      const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
      const store = await bootstrappedStore(api, source);
      const selected = (await store.refresh([source])).scan.entries[0]!;
      const originalUpdate = api.updateFile.bind(api);
      vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
        if (request.fileId === 'pdf-8') throw lower;
        return originalUpdate(request);
      });

      await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({ code });
      expect(api.control()).toMatchObject({ sequenceByYear: { '2026': 8 }, reservation: null });
      expect(api.mutations()).not.toContain('pdf:update:pdf-8');
    }
  );

  it('recovers an operation-bound re-finalized PDF after its update response is lost', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source, {
      operationIds: ['refinalize-op'],
      renderBytes: UPDATED_PDF_BYTES,
    });
    const selected = (await store.refresh([source])).scan.entries[0]!;
    const originalUpdate = api.updateFile.bind(api);
    let lost = false;
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === 'pdf-8' && !lost) {
        lost = true;
        await originalUpdate(request);
        throw new DriveError('server', 'lost PDF update response', true, 503, request.fileId);
      }
      return originalUpdate(request);
    });

    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toMatchObject({
      operationId: 'refinalize-op',
      invoiceNumber: '8/2026',
    });
    expect(api.file('pdf-8').properties.lotusOperationId).toBe('refinalize-op');

    vi.restoreAllMocks();
    const download = vi.spyOn(api, 'downloadFile');
    const recovered = await makeStore(api).recoverReservation([]);
    expect(recovered.control.control).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });
    expect(download.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(1);
    expect(api.mutations().filter((mutation) => mutation === 'pdf:update:pdf-8')).toHaveLength(1);
  });

  it('handles a nullable list ETag by selecting exact GET/download authority', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({
      id: 'pdf-8',
      source,
      sourceSha256: 'a'.repeat(64),
      etag: '"pdf-8-v3"',
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    expect(selected.file.etag).toBeNull();

    await expect(store.refinalize(finalizationInput(), selected)).resolves.toMatchObject({
      file: { id: 'pdf-8' },
      state: 'fresh',
    });
  });

  it('downloads bytes only for a unique fresh entry after exact checksum verification', async () => {
    const source = await currentSource('8/2026');
    const pdf = await managedPdf({ id: 'pdf-8', source });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [pdf] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;

    await expect(store.downloadVerified(selected)).resolves.toEqual(PDF_BYTES);
  });

  it('downloads a fresh adopted PDF that preserved unrelated metadata', async () => {
    const source = await currentSource('8/2026');
    const managed = await managedPdf({ id: 'pdf-8', source });
    const adoptedShape: MemoryDriveFile = {
      ...managed,
      properties: { unrelated: 'preserved', ...managed.properties },
    };
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [adoptedShape] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    expect(selected.state).toBe('fresh');

    await expect(store.downloadVerified(selected)).resolves.toEqual(PDF_BYTES);
  });

  it('downloads an integrity-verified stale PDF while preserving its stale classification', async () => {
    const source = await currentSource('8/2026');
    const stalePdf = await managedPdf({
      id: 'pdf-8',
      source,
      sourceSha256: 'a'.repeat(64),
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stalePdf] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    expect(selected.state).toBe('stale');

    await expect(store.downloadVerified(selected)).resolves.toEqual(PDF_BYTES);
  });

  it('downloads and verifies a managed PDF with download but no edit permission', async () => {
    const source = await currentSource('8/2026');
    const readOnly = await managedPdf({
      id: 'pdf-8',
      source,
      canDownload: true,
      canEdit: false,
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [readOnly] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries[0]!;

    expect(selected).toMatchObject({
      state: 'fresh',
      file: { capabilities: { canDownload: true, canEdit: false } },
    });
    await expect(store.downloadVerified(selected)).resolves.toEqual(PDF_BYTES);
  });

  it.each(['unmanaged', 'permission', 'duplicate', 'corrupt'] as const)(
    'rejects an unsafe %s entry before returning bytes',
    async (state) => {
      const source = await currentSource('8/2026');
      const pdf = await managedPdf({ id: 'pdf-8', source });
      const api = new MemoryDriveApi(configuredDrive({ extraFiles: [pdf] }));
      const store = await bootstrappedStore(api, source);
      const selected = (await store.refresh([source])).scan.entries[0]!;
      const unsafe: DriveInvoiceEntry = { ...selected, state };

      await expect(store.downloadVerified(unsafe)).rejects.toMatchObject({
        code: 'invalidState',
      });
    }
  );
});

describe('DriveInvoiceStore Shared Drive requests', () => {
  it('uses Shared Drive corpora and supportsAllDrives for every folder and PDF operation', async () => {
    const driveId = 'shared-drive-1';
    const api = new MemoryDriveApi(configuredDrive({ driveId }), {
      sharedDrives: [{ id: driveId, name: 'Shared invoices' }],
    });
    const listRequests: Parameters<DriveApi['listFiles']>[0][] = [];
    const getRequests: Parameters<DriveApi['getFile']>[0][] = [];
    const createRequests: Parameters<DriveApi['createFile']>[0][] = [];
    const originalList = api.listFiles.bind(api);
    const originalGet = api.getFile.bind(api);
    const originalCreate = api.createFile.bind(api);
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      listRequests.push(request);
      return originalList(request);
    });
    vi.spyOn(api, 'getFile').mockImplementation(async (request) => {
      getRequests.push(request);
      return originalGet(request);
    });
    vi.spyOn(api, 'createFile').mockImplementation(async (request) => {
      createRequests.push(request);
      return originalCreate(request);
    });
    const store = await bootstrappedStore(api);

    await store.finalize(finalizationInput());

    expect(
      listRequests.filter((request) => request.query.includes(`'${FINAL_ID}' in parents`))
    ).toEqual([
      expect.objectContaining({
        corpora: 'drive',
        driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
      expect.objectContaining({
        corpora: 'drive',
        driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
      expect.objectContaining({
        corpora: 'drive',
        driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
    ]);
    expect(getRequests.every((request) => request.supportsAllDrives)).toBe(true);
    expect(createRequests.find((request) => request.mimeType === 'application/pdf')).toMatchObject({
      parents: [FINAL_ID],
      supportsAllDrives: true,
    });
  });
});

describe('DriveInvoiceStore review hardening', () => {
  async function recoveryFixture(): Promise<{
    source: CurrentInvoiceSource;
    reservation: InvoiceReservation;
    uploaded: MemoryDriveFile;
  }> {
    const source = await currentSource('9/2026');
    const reservation: InvoiceReservation = {
      operationId: 'recover-without-source',
      year: 2026,
      invoiceNumber: '9/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'reserved-file',
      sourceSha256: source.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    return {
      source,
      reservation,
      uploaded: await managedPdf({
        id: reservation.fileId,
        invoiceNumber: reservation.invoiceNumber,
        operationId: reservation.operationId,
        source,
      }),
    };
  }

  it('commits one coherent reserved upload when the current source is unavailable', async () => {
    const { reservation, uploaded } = await recoveryFixture();
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [uploaded] }));

    const snapshot = await makeStore(api).recoverReservation([]);

    expect(snapshot.control.control).toMatchObject({
      sequenceByYear: { '2026': 9 },
      reservation: null,
    });
    expect(snapshot.scan.entries[0]).toMatchObject({
      file: expect.objectContaining({ id: reservation.fileId }),
      state: 'fresh',
    });
  });

  it('commits one coherent reserved upload when the current source has changed', async () => {
    const { reservation, uploaded } = await recoveryFixture();
    const changedConfig = config();
    changedConfig.teacher.name = 'Changed Teacher';
    const changedInvoice = invoice('9/2026');
    const changedFingerprint = await fingerprintInvoiceSource(
      buildInvoiceSource({
        config: changedConfig,
        classes: [],
        invoice: changedInvoice,
        calendarId: 'calendar-id',
        invoiceNumber: '9/2026',
      })
    );
    const changed = await currentSource('9/2026', {
      config: changedConfig,
      fingerprint: changedFingerprint,
    });
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [uploaded] }));

    await expect(makeStore(api).recoverReservation([changed])).resolves.toMatchObject({
      control: { control: { sequenceByYear: { '2026': 9 }, reservation: null } },
    });
  });

  it('does not adopt or patch a mismatching manual file while reconciling recovery', async () => {
    const { source, reservation, uploaded } = await recoveryFixture();
    const manual: MemoryDriveFile = {
      ...uploaded,
      properties: { unrelated: 'untouched' },
    };
    const api = new MemoryDriveApi(configuredDrive({ reservation, extraFiles: [manual] }));

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.patchRequest(manual.id)).toBeNull();
    expect(api.file(manual.id).properties).toEqual({ unrelated: 'untouched' });
    expect(api.control().reservation).toEqual(reservation);
  });

  it('uses one account-wide lease around re-finalization and preserves unrelated properties', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({
      id: 'pdf-8',
      source,
      sourceSha256: 'a'.repeat(64),
      extraProperties: { unrelated: 'preserved' },
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const render = vi.fn(async () => {
      expect(api.control().reservation).toMatchObject({
        invoiceNumber: '8/2026',
        fileId: 'pdf-8',
        operationId: 'refinalize-op',
      });
      return UPDATED_PDF_BYTES;
    });
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'refinalize-op',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([source]);
    const selected = (await store.refresh([source])).scan.entries[0]!;

    const result = await store.refinalize(finalizationInput(), selected);

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.file.properties.unrelated).toBe('preserved');
    expect(api.updateRequest('pdf-8')?.properties.unrelated).toBe('preserved');
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });
    const mutations = api.mutations();
    expect(mutations.indexOf('control:reserve:if-match')).toBeLessThan(
      mutations.indexOf('pdf:update:pdf-8')
    );
    expect(mutations.indexOf('pdf:update:pdf-8')).toBeLessThan(
      mutations.indexOf('control:commit:if-match')
    );
  });

  it('rejects re-finalization without edit permission before reserving or rendering', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({
      id: 'pdf-8',
      source,
      sourceSha256: 'a'.repeat(64),
      canDownload: true,
      canEdit: false,
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const render = vi.fn(async () => UPDATED_PDF_BYTES);
    const download = vi.spyOn(api, 'downloadFile');
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'refinalize-op',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([source]);
    const selected = (await store.refresh([source])).scan.entries[0]!;

    expect(selected).toMatchObject({
      state: 'stale',
      file: { capabilities: { canDownload: true, canEdit: false } },
    });
    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'permission',
      retryable: false,
    });
    expect(render).not.toHaveBeenCalled();
    expect(download.mock.calls.filter(([request]) => request.fileId === 'pdf-8')).toHaveLength(0);
    expect(api.mutations()).toEqual(['pdf:get:pdf-8']);
    expect(api.control().reservation).toBeNull();
  });

  it('blocks activation and new finalization while an existing-number lease is active', async () => {
    const source = await currentSource('8/2026');
    const lease: InvoiceReservation = {
      operationId: 'refinalize-op',
      year: 2026,
      invoiceNumber: '8/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'pdf-8',
      sourceSha256: source.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ reservation: lease, extraFiles: [stale] }));
    const store = makeStore(api);

    await expect(store.activateRoot(stagedRoot(), [source], undefined)).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(lease);
  });

  it('clears a non-coherent existing-number lease without patching the PDF', async () => {
    const source = await currentSource('8/2026');
    const lease: InvoiceReservation = {
      operationId: 'abandoned-refinalize-op',
      year: 2026,
      invoiceNumber: '8/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'pdf-8',
      sourceSha256: source.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ reservation: lease, extraFiles: [stale] }));

    const recovered = await makeStore(api).recoverReservation([source]);

    expect(recovered.control.control).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });
    expect(recovered.scan.entries[0]).toMatchObject({ file: { id: 'pdf-8' }, state: 'stale' });
    expect(api.file('pdf-8').bytes).toEqual(PDF_BYTES);
    expect(api.mutations()).toEqual(['control:commit:if-match']);
  });

  it('does not adopt a manual PDF while clearing a non-coherent existing-number lease', async () => {
    const source = await currentSource('8/2026');
    const lease: InvoiceReservation = {
      operationId: 'abandoned-refinalize-op',
      year: 2026,
      invoiceNumber: '8/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'pdf-8',
      sourceSha256: source.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    const manual: MemoryDriveFile = {
      ...(await managedPdf({ id: 'pdf-8', source })),
      properties: { unrelated: 'untouched' },
    };
    const api = new MemoryDriveApi(configuredDrive({ reservation: lease, extraFiles: [manual] }));

    const recovered = await makeStore(api).recoverReservation([source]);

    expect(recovered.control.control.reservation).toBeNull();
    expect(recovered.scan.entries[0]).toMatchObject({ file: { id: 'pdf-8' }, state: 'unmanaged' });
    expect(api.patchRequest('pdf-8')).toBeNull();
    expect(api.file('pdf-8').properties).toEqual({ unrelated: 'untouched' });
    expect(api.mutations()).toEqual(['control:commit:if-match']);
  });

  it('blocks an incoherent operation match at another file before clearing an existing lease', async () => {
    const source = await currentSource('8/2026');
    const lease: InvoiceReservation = {
      operationId: 'refinalize-op',
      year: 2026,
      invoiceNumber: '8/2026',
      studioSlug: 'studio-a',
      month: '2026-08',
      fileId: 'pdf-8',
      sourceSha256: source.fingerprint.sourceSha256,
      startedAt: FIXED_NOW,
    };
    const other = await managedPdf({
      id: 'other-file',
      invoiceNumber: '7/2026',
      operationId: lease.operationId,
      source,
    });
    other.name = '7-2026-studio-b-2026-07.pdf';
    other.properties = {
      ...other.properties,
      lotusInvoiceNumber: '7/2026',
      lotusStudioSlug: 'studio-b',
      lotusMonth: '2026-07',
    };
    const api = new MemoryDriveApi(configuredDrive({ reservation: lease, extraFiles: [other] }));

    await expect(makeStore(api).recoverReservation([source])).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control().reservation).toEqual(lease);
    expect(api.mutations()).toEqual([]);
  });

  it('does not release or advance again after a lost re-finalization commit response', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const store = await bootstrappedStore(api, source, {
      operationIds: ['refinalize-op'],
      renderBytes: UPDATED_PDF_BYTES,
    });
    const selected = (await store.refresh([source])).scan.entries[0]!;
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === CONTROL_ID) {
        const next = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(request.bytes))
        ) as DriveControl;
        if (next.reservation === null && api.control().reservation !== null) {
          await originalUpdate(request);
          throw new DriveError('server', 'lost commit response', true, 503, CONTROL_ID);
        }
      }
      return originalUpdate(request);
    });

    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'recoveryRequired',
    });
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });

    const mutations = api.mutations();
    vi.restoreAllMocks();
    const recovered = await makeStore(api).recoverReservation([]);
    expect(recovered.control.control).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });
    expect(api.mutations()).toEqual(mutations);
  });

  it('reloads real competing control and catalog state after reservation CAS 412', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = await bootstrappedStore(api, await currentSource(), {
      operationIds: ['stale-op', 'fresh-op'],
    });
    const originalList = api.listFiles.bind(api);
    const finalQueries: string[] = [];
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      if (request.query.includes(`'${FINAL_ID}' in parents`)) finalQueries.push(request.query);
      return originalList(request);
    });
    const originalUpdate = api.updateFile.bind(api);
    let raced = false;
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === CONTROL_ID && !raced) {
        const next = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(request.bytes))
        ) as DriveControl;
        if (next.reservation !== null) {
          raced = true;
          await originalUpdate({
            ...request,
            bytes: Array.from(
              new TextEncoder().encode(
                JSON.stringify({
                  ...next,
                  sequenceByYear: { ...next.sequenceByYear, '2026': 9 },
                  reservation: null,
                })
              )
            ),
          });
          throw conflict412(CONTROL_ID);
        }
      }
      return originalUpdate(request);
    });

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    });
    expect(finalQueries).toHaveLength(2);
    expect(api.control().sequenceByYear['2026']).toBe(9);

    const result = await store.finalize(finalizationInput());
    expect(result).toMatchObject({ invoiceNumber: '10/2026', file: { id: 'generated-file-2' } });
  });

  it('does not render when activation wins the control CAS against re-finalization', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({ id: 'pdf-8', source, sourceSha256: 'a'.repeat(64) });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const render = vi.fn(async () => UPDATED_PDF_BYTES);
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'refinalize-op',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([source]);
    const selected = (await store.refresh([source])).scan.entries[0]!;
    const originalList = api.listFiles.bind(api);
    const finalQueries: string[] = [];
    vi.spyOn(api, 'listFiles').mockImplementation(async (request) => {
      if (request.query.includes(`'${FINAL_ID}' in parents`)) finalQueries.push(request.query);
      return originalList(request);
    });
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      if (request.fileId === CONTROL_ID) {
        const proposed = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(request.bytes))
        ) as DriveControl;
        if (proposed.reservation !== null) {
          await originalUpdate({
            ...request,
            bytes: Array.from(
              new TextEncoder().encode(
                JSON.stringify({
                  ...proposed,
                  root: { ...proposed.root, folderName: 'stale activation label' },
                  reservation: null,
                })
              )
            ),
          });
          throw conflict412(CONTROL_ID);
        }
      }
      return originalUpdate(request);
    });

    await expect(store.refinalize(finalizationInput(), selected)).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    });
    expect(render).not.toHaveBeenCalled();
    expect(finalQueries).toHaveLength(2);
    expect(api.mutations()).not.toContain('pdf:update:pdf-8');
    expect(api.control().reservation).toBeNull();
  });

  it('returns a post-CAS activation refresh when Final changes during activation', async () => {
    const source = await currentSource('8/2026');
    const inserted = await managedPdf({ id: 'appeared-after-scan', source });
    const api = new MemoryDriveApi(configuredDrive());
    const originalUpdate = api.updateFile.bind(api);
    let added = false;
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const result = await originalUpdate(request);
      if (request.fileId === CONTROL_ID && !added) {
        added = true;
        await api.createFile({
          fileId: inserted.id,
          name: inserted.name,
          mimeType: inserted.mimeType,
          parents: [...inserted.parents],
          properties: { ...inserted.properties },
          bytes: Array.from(inserted.bytes),
          supportsAllDrives: true,
        });
      }
      return result;
    });

    const snapshot = await makeStore(api).activateRoot(stagedRoot(), [source], undefined);

    expect(snapshot.scan.entries).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ id: inserted.id }),
        state: 'fresh',
      }),
    ]);
  });

  it('treats stored root folderName as a label instead of identity authority', async () => {
    const files = configuredDrive().map((file) =>
      file.id === ROOT_ID ? { ...file, name: 'Renamed Lotus Folder' } : file
    );

    const snapshot = await makeStore(new MemoryDriveApi(files)).bootstrap([]);

    expect(snapshot?.stagedRoot).toMatchObject({
      root: { folderId: ROOT_ID, folderName: 'Renamed Lotus Folder' },
      rootFile: { id: ROOT_ID, name: 'Renamed Lotus Folder' },
    });
  });

  it('downloads a selected fresh invoice despite an unrelated blocking catalog row', async () => {
    const source = await currentSource('8/2026');
    const fresh = await managedPdf({ id: 'pdf-8', source });
    const unrelated = {
      ...(await managedPdf({ id: 'unrelated-corrupt', source })),
      name: 'bad.pdf',
    };
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [fresh, unrelated] }));
    const store = await bootstrappedStore(api, source);
    const selected = (await store.refresh([source])).scan.entries.find(
      (entry) => entry.file.id === fresh.id
    )!;
    expect(selected.state).toBe('fresh');

    await expect(store.downloadVerified(selected)).resolves.toEqual(PDF_BYTES);
  });

  it('deep-snapshots finalization input before a reservation interleaving mutates callers', async () => {
    const input = finalizationInput();
    input.invoice.classes = [
      {
        date: '2026-08-01',
        startTime: '10:00',
        endTime: '11:00',
        classType: 'Original Class',
        studentCount: 4,
        rateApplied: 50,
        lineTotal: 50,
      },
    ];
    input.invoice.totalClasses = 1;
    input.invoice.totalAmount = 50;
    input.classes = [
      {
        eventIdentity: {
          calendarId: 'calendar-id',
          eventId: 'event-1',
          recurringEventId: null,
          originalStartTime: null,
          etag: '"event-v1"',
        },
        sourceSummary: 'Studio A / Original Class',
        sourceDescription: '4',
        studioName: 'Studio A',
        classType: 'Original Class',
        date: '2026-08-01',
        startTime: '10:00',
        endTime: '11:00',
        studentCount: 4,
      },
    ];
    const originalInput = structuredClone(input);
    const expectedFingerprint = await fingerprintInvoiceSource(
      buildInvoiceSource({
        config: originalInput.config,
        classes: originalInput.classes,
        invoice: { ...originalInput.invoice, invoiceNumber: '9/2026' },
        calendarId: 'calendar-id',
        invoiceNumber: '9/2026',
      })
    );
    const api = new MemoryDriveApi(configuredDrive());
    const originalUpdate = api.updateFile.bind(api);
    let mutated = false;
    vi.spyOn(api, 'updateFile').mockImplementation(async (request) => {
      const result = await originalUpdate(request);
      if (request.fileId === CONTROL_ID && !mutated && api.control().reservation !== null) {
        mutated = true;
        input.config.teacher.name = 'Mutated Teacher';
        input.invoice.classes[0]!.classType = 'Mutated Class';
        (input.classes[0] as { sourceSummary: string }).sourceSummary = 'Mutated Summary';
      }
      return result;
    });
    const render = vi.fn(async (renderedInvoice: Invoice, renderedConfig: AppConfig) => {
      expect(renderedConfig.teacher.name).toBe('Teacher');
      expect(renderedInvoice.classes[0]?.classType).toBe('Original Class');
      return PDF_BYTES;
    });
    const store = new DriveInvoiceStore(api, {
      renderFinalPdf: render,
      createOperationId: () => 'snapshot-op',
      now: () => FIXED_NOW,
    });
    await store.bootstrap([await currentSource()]);

    const result = await store.finalize(input);

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.file.properties.lotusSourceSha256).toBe(expectedFingerprint.sourceSha256);
  });
});

describe('DriveInvoiceStore shared-account CAS', () => {
  it('allows only one of two simultaneously bootstrapped devices to reserve and upload', async () => {
    const source = await currentSource();
    const api = new MemoryDriveApi(configuredDrive());
    const desktop = makeStore(api, { operationIds: ['desktop-op'] });
    const android = makeStore(api, { operationIds: ['android-op'] });
    await Promise.all([desktop.bootstrap([source]), android.bootstrap([source])]);

    const outcomes = await Promise.allSettled([
      desktop.finalize(finalizationInput()),
      android.finalize(finalizationInput()),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: expect.stringMatching(/conflict|recoveryRequired/) }),
    });
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 9 },
      reservation: null,
    });
    expect(api.mutations().filter((mutation) => mutation.startsWith('pdf:create:'))).toHaveLength(
      1
    );
    expect(
      api.mutations().filter((mutation) => mutation === 'control:reserve:if-match')
    ).toHaveLength(1);
    expect(
      api.mutations().filter((mutation) => mutation === 'control:commit:if-match')
    ).toHaveLength(1);
  });

  it('allows only one stale device to replace a PDF and preserves its ID and number', async () => {
    const source = await currentSource('8/2026');
    const stale = await managedPdf({
      id: 'pdf-8',
      source,
      sourceSha256: 'a'.repeat(64),
    });
    const api = new MemoryDriveApi(configuredDrive({ extraFiles: [stale] }));
    const desktop = makeStore(api, {
      operationIds: ['desktop-refinalize'],
      renderBytes: UPDATED_PDF_BYTES,
    });
    const android = makeStore(api, {
      operationIds: ['android-refinalize'],
      renderBytes: Uint8Array.from([...UPDATED_PDF_BYTES, 99]),
    });
    await Promise.all([desktop.bootstrap([source]), android.bootstrap([source])]);
    const [desktopEntry, androidEntry] = await Promise.all([
      desktop.refresh([source]).then((snapshot) => snapshot.scan.entries[0]!),
      android.refresh([source]).then((snapshot) => snapshot.scan.entries[0]!),
    ]);

    const outcomes = await Promise.allSettled([
      desktop.refinalize(finalizationInput(), desktopEntry),
      android.refinalize(finalizationInput(), androidEntry),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(api.file('pdf-8')).toMatchObject({
      id: 'pdf-8',
      properties: expect.objectContaining({ lotusInvoiceNumber: '8/2026' }),
    });
    expect(api.mutations().filter((mutation) => mutation === 'pdf:update:pdf-8')).toHaveLength(1);
    expect(api.control()).toMatchObject({
      sequenceByYear: { '2026': 8 },
      reservation: null,
    });
  });
});
