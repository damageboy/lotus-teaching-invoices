import { parseConfigYaml, serializeConfigYaml } from '../../src/lib/config/schema.js';
import type { DriveApi } from '../../src/lib/drive/api.js';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type { CurrentInvoiceSource } from '../../src/lib/drive/invoiceCatalog.js';
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
const CONFIG_ID = 'invoice-config';
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

function folder(id: string, name: string, parents: string[]): MemoryDriveFile {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents,
    driveId: null,
    ownedByMe: true,
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

function stagedRoot(): StagedDriveRoot {
  const root = folder(ROOT_ID, 'Lotus Invoices', ['root']);
  const finalFolder = folder(FINAL_ID, 'Final', [ROOT_ID]);
  return {
    root: { folderId: ROOT_ID, driveId: null, folderName: root.name },
    rootFile: root,
    finalFolder,
  };
}

function config(sequence = 8): AppConfig {
  return {
    teacher: {
      name: 'Teacher',
      address: 'Teacher Street',
      taxNumber: 'Tax',
      bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
    },
    calendarId: 'calendar-id',
    studios: {
      'Studio A': {
        fullName: 'Studio A GmbH',
        address: 'Studio Street',
        invoiceEmail: 'studio@example.com',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
      },
    },
    invoiceSequenceByYear: sequence === 0 ? {} : { '2026': sequence },
  };
}

function configFile(value = config(), overrides: Partial<MemoryDriveFile> = {}): MemoryDriveFile {
  const bytes = new TextEncoder().encode(serializeConfigYaml(value));
  return {
    id: CONFIG_ID,
    name: 'lotus-invoices-config.yaml',
    mimeType: 'application/yaml',
    parents: [ROOT_ID],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: String(bytes.byteLength),
    md5Checksum: null,
    sha256Checksum: null,
    properties: { lotusConfigSchema: '1' },
    capabilities: capabilities(),
    etag: `"${CONFIG_ID}-v1"`,
    bytes,
    ...overrides,
  };
}

function legacyFile(id = CONFIG_ID, parentId = ROOT_ID): MemoryDriveFile {
  const bytes = new TextEncoder().encode(JSON.stringify({ sequenceByYear: { '2026': 17 } }));
  return configFile(config(0), {
    id,
    name: '.lotus-teaching-invoices.json',
    mimeType: 'application/json',
    parents: [parentId],
    etag: `"${id}-v1"`,
    bytes,
    size: String(bytes.byteLength),
  });
}

function configDiscoveryRequests(api: MemoryDriveApi) {
  return api
    .listRequests()
    .filter(
      ({ query }) =>
        query.includes("name = 'lotus-invoices-config.yaml'") ||
        query.includes("name = '.lotus-teaching-invoices.json'")
    );
}

function configuredDrive(extraFiles: readonly MemoryDriveFile[] = []): MemoryDriveFile[] {
  const root = stagedRoot();
  return [
    root.rootFile as MemoryDriveFile,
    root.finalFolder as MemoryDriveFile,
    configFile(),
    ...extraFiles,
  ];
}

function invoice(invoiceNumber?: string): Invoice {
  return {
    studioName: 'Studio A',
    invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    generatedAt: '2026-08-24T12:00:00.000Z',
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

async function currentSource(invoiceNumber = '8/2026'): Promise<CurrentInvoiceSource> {
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
  };
}

async function managedPdf(sourceSha256: string): Promise<MemoryDriveFile> {
  const source = await currentSource();
  const pdfSha = await sha256Hex(PDF_BYTES);
  const properties: LotusPdfProperties = {
    lotusSchema: '1',
    lotusCalendarHash: source.fingerprint.calendarSha256,
    lotusStudioSlug: 'studio-a',
    lotusMonth: '2026-08',
    lotusInvoiceNumber: '8/2026',
    lotusSourceSha256: sourceSha256,
    lotusPdfSha256: pdfSha,
    lotusOperationId: 'existing-operation',
  };
  return {
    id: 'existing-pdf',
    name: finalizedFilename('studio-a', '2026', '08', '8/2026'),
    mimeType: 'application/pdf',
    parents: [FINAL_ID],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '3',
    size: String(PDF_BYTES.byteLength),
    md5Checksum: null,
    sha256Checksum: pdfSha,
    properties,
    capabilities: capabilities(),
    etag: '"existing-pdf-v3"',
    bytes: PDF_BYTES,
  };
}

function makeStore(
  api: DriveApi,
  renderFinalPdf = vi.fn(async () => new Uint8Array(PDF_BYTES))
): DriveInvoiceStore {
  return new DriveInvoiceStore(api, {
    renderFinalPdf,
    createOperationId: () => 'operation-1',
  });
}

describe('DriveInvoiceStore cloud configuration', () => {
  it('publishes an exact pointed configuration before resolving invoice folders', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = makeStore(api);

    const loadedConfig = await store.loadConfigByFileId(CONFIG_ID);

    expect(loadedConfig.file.id).toBe(CONFIG_ID);
    expect(loadedConfig.config.calendarId).toBe('calendar-id');
    expect(api.listRequests()).toEqual([]);

    const snapshot = await store.loadInvoicesForConfig(loadedConfig, []);

    expect(snapshot.config).toEqual(loadedConfig);
    expect(snapshot.stagedRoot.root.folderId).toBe(ROOT_ID);
    expect(api.listRequests()).toHaveLength(2);
  });

  it('loads the pointed configuration and root without whole-Drive discovery', async () => {
    const otherRoot = folder('other-root', 'Other', ['root']);
    const otherFinal = folder('other-final', 'Final', [otherRoot.id]);
    const api = new MemoryDriveApi([
      ...configuredDrive(),
      otherRoot,
      otherFinal,
      configFile(config(), {
        id: 'other-config',
        parents: [otherRoot.id],
        etag: '"other-config-v1"',
      }),
    ]);

    const snapshot = await makeStore(api).loadByFileId(CONFIG_ID, []);

    expect(snapshot.config.file.id).toBe(CONFIG_ID);
    expect(snapshot.stagedRoot.root.folderId).toBe(ROOT_ID);
    expect(configDiscoveryRequests(api)).toEqual([]);
  });

  it('refreshes the selected file ID after an unrelated configuration appears', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = makeStore(api);
    await store.loadByFileId(CONFIG_ID, []);
    const duplicate = configFile(config(), {
      id: 'other-config',
      etag: '"other-config-v1"',
    });
    api.addFile(duplicate);
    api.replaceFile(configFile(config(23)));

    const refreshed = await store.refresh([]);

    expect(refreshed.config.file.id).toBe(CONFIG_ID);
    expect(refreshed.config.config.invoiceSequenceByYear).toEqual({ '2026': 23 });
    expect(configDiscoveryRequests(api)).toEqual([]);
  });

  it('rescans changed invoice sources without reloading config or root folders', async () => {
    const source = await currentSource();
    const api = new MemoryDriveApi(
      configuredDrive([await managedPdf(source.fingerprint.sourceSha256)])
    );
    const store = makeStore(api);
    await store.loadByFileId(CONFIG_ID, []);
    api.clearListRequests();

    const rescanned = await store.rescanInvoices([source]);

    expect(rescanned.scan.entries).toHaveLength(1);
    expect(rescanned.scan.entries[0].state).toBe('fresh');
    expect(api.listRequests()).toHaveLength(1);
    expect(api.listRequests()[0].query).toContain(`'${FINAL_ID}' in parents`);
  });

  it('follows the pointed file when its parent changes and reflects the live folder name', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = makeStore(api);
    await store.loadByFileId(CONFIG_ID, []);
    const movedRoot = folder('moved-root', 'Renamed Invoices', ['root']);
    const movedFinal = folder('moved-final', 'Final', [movedRoot.id]);
    api.addFile(movedRoot);
    api.addFile(movedFinal);
    api.replaceFile(configFile(config(), { parents: [movedRoot.id] }));

    const refreshed = await store.refresh([]);

    expect(refreshed.config.file.id).toBe(CONFIG_ID);
    expect(refreshed.stagedRoot.root.folderName).toBe('Renamed Invoices');
    expect(configDiscoveryRequests(api)).toEqual([]);
  });

  it('discovers every validated recovery candidate without selecting one', async () => {
    const secondRoot = folder('second-root', 'Alpha Invoices', ['root']);
    const secondFinal = folder('second-final', 'Final', [secondRoot.id]);
    const firstConfig = configFile({ ...config(), calendarName: 'Zulu Calendar' });
    const secondConfig = configFile(
      { ...config(), calendarName: 'Alpha Calendar' },
      { id: 'second-config', parents: [secondRoot.id], etag: '"second-config-v1"' }
    );
    const api = new MemoryDriveApi([
      stagedRoot().rootFile as MemoryDriveFile,
      stagedRoot().finalFolder as MemoryDriveFile,
      firstConfig,
      secondRoot,
      secondFinal,
      secondConfig,
    ]);
    const store = makeStore(api);

    const recovery = await store.discoverRecovery();

    expect(recovery.issues).toEqual([]);
    expect(recovery.candidates).toMatchObject([
      {
        fileId: 'second-config',
        kind: 'configured',
        root: { folderName: 'Alpha Invoices' },
        calendarName: 'Alpha Calendar',
      },
      {
        fileId: CONFIG_ID,
        kind: 'configured',
        root: { folderName: 'Lotus Invoices' },
        calendarName: 'Zulu Calendar',
      },
    ]);
    await expect(store.refresh([])).rejects.toMatchObject({ code: 'invalidState' });
  });

  it('reports invalid recovery candidates and adopts only the explicitly selected ID', async () => {
    const badRoot = folder('bad-root', 'Bad', ['root']);
    const badFinal = folder('bad-final', 'Final', [badRoot.id]);
    const bad = configFile(config(), {
      id: 'bad-config',
      parents: [badRoot.id],
      etag: '"bad-config-v1"',
      bytes: new TextEncoder().encode('not: [valid'),
    });
    const api = new MemoryDriveApi([...configuredDrive(), badRoot, badFinal, bad]);
    const store = makeStore(api);

    const recovery = await store.discoverRecovery();
    const adopted = await store.adoptRecoveryCandidate(CONFIG_ID, []);

    expect(recovery.candidates.map(({ fileId }) => fileId)).toEqual([CONFIG_ID]);
    expect(recovery.issues).toMatchObject([{ fileId: 'bad-config' }]);
    expect(adopted.config.file.id).toBe(CONFIG_ID);
    expect((await store.refresh([])).config.file.id).toBe(CONFIG_ID);
  });

  it('migrates only the explicitly selected legacy recovery candidate', async () => {
    const secondRoot = folder('second-root', 'Second', ['root']);
    const secondFinal = folder('second-final', 'Final', [secondRoot.id]);
    const api = new MemoryDriveApi([
      stagedRoot().rootFile as MemoryDriveFile,
      stagedRoot().finalFolder as MemoryDriveFile,
      configFile(),
      secondRoot,
      secondFinal,
      legacyFile('legacy-config', secondRoot.id),
    ]);
    const store = makeStore(api);

    const adopted = await store.adoptRecoveryCandidate(
      'legacy-config',
      [],
      serializeConfigYaml(config(0))
    );

    expect(adopted.config.file.id).toBe('legacy-config');
    expect(adopted.config.config.invoiceSequenceByYear).toEqual({ '2026': 17 });
    expect(api.file(CONFIG_ID).name).toBe('lotus-invoices-config.yaml');
    expect(configDiscoveryRequests(api)).toEqual([]);
  });

  it('derives the root from the config parent', async () => {
    const store = makeStore(new MemoryDriveApi(configuredDrive()));
    const snapshot = await store.bootstrap([]);

    expect(snapshot?.config.file.id).toBe(CONFIG_ID);
    expect(snapshot?.stagedRoot.root.folderId).toBe(ROOT_ID);
    expect(snapshot?.stagedRoot.finalFolder.id).toBe(FINAL_ID);
  });

  it('creates the unified config inside a newly activated root', async () => {
    const root = stagedRoot();
    const api = new MemoryDriveApi([
      root.rootFile as MemoryDriveFile,
      root.finalFolder as MemoryDriveFile,
    ]);
    const store = makeStore(api);

    const snapshot = await store.activateRoot(root, [], config(0));

    expect(snapshot.config.file.name).toBe('lotus-invoices-config.yaml');
    expect(snapshot.config.file.parents).toEqual([ROOT_ID]);
    expect(snapshot.config.config.invoiceSequenceByYear).toEqual({});
  });

  it('moves the same config file ID without changing its content', async () => {
    const secondRoot = folder('second-root', 'Second Root', ['root']);
    const secondFinal = folder('second-final', 'Final', [secondRoot.id]);
    const api = new MemoryDriveApi([...configuredDrive(), secondRoot, secondFinal]);
    const store = makeStore(api);
    await store.bootstrap([]);
    api.clearListRequests();
    const staged: StagedDriveRoot = {
      root: { folderId: secondRoot.id, driveId: null, folderName: secondRoot.name },
      rootFile: secondRoot,
      finalFolder: secondFinal,
    };

    const moved = await store.activateRoot(staged, []);

    expect(moved.config.file.id).toBe(CONFIG_ID);
    expect(moved.config.file.parents).toEqual([secondRoot.id]);
    expect(moved.config.config).toEqual(config());
    expect(configDiscoveryRequests(api)).toEqual([]);
  });

  it('migrates legacy JSON in place and returns exact local YAML as deletion receipt', async () => {
    const root = stagedRoot();
    const legacyBytes = new TextEncoder().encode(
      JSON.stringify({ sequenceByYear: { '2026': 17 } })
    );
    const legacy: MemoryDriveFile = {
      ...configFile(),
      name: '.lotus-teaching-invoices.json',
      mimeType: 'application/json',
      bytes: legacyBytes,
      size: String(legacyBytes.byteLength),
    };
    const api = new MemoryDriveApi([
      root.rootFile as MemoryDriveFile,
      root.finalFolder as MemoryDriveFile,
      legacy,
    ]);
    const raw = serializeConfigYaml(config(0));

    const snapshot = await makeStore(api).bootstrap([], raw);

    expect(snapshot?.config.file.id).toBe(CONFIG_ID);
    expect(snapshot?.config.file.name).toBe('lotus-invoices-config.yaml');
    expect(snapshot?.config.config.invoiceSequenceByYear).toEqual({ '2026': 17 });
  });
});

describe('DriveInvoiceStore finalization', () => {
  it('reloads after one allocation ETag conflict and consumes the following number', async () => {
    const api = new MemoryDriveApi(configuredDrive(), { generatedIds: ['generated-1'] });
    const originalUpdate = api.updateFile.bind(api);
    vi.spyOn(api, 'updateFile').mockImplementationOnce(async (request) => {
      await originalUpdate(request);
      throw new DriveError('conflict', 'stale ETag', false, 412, request.fileId);
    });
    const store = makeStore(api);
    await store.bootstrap([await currentSource()]);

    const result = await store.finalize(finalizationInput());

    expect(result.entry.invoiceNumber).toBe('10/2026');
    expect(result.snapshot.config.config.invoiceSequenceByYear).toEqual({ '2026': 10 });
  });

  it('increments the config before rendering and uploading', async () => {
    const api = new MemoryDriveApi(configuredDrive(), { generatedIds: ['generated-1'] });
    const render = vi.fn(async () => {
      expect(parseConfigYaml(new TextDecoder().decode(api.file(CONFIG_ID).bytes))).toMatchObject({
        invoiceSequenceByYear: { '2026': 9 },
      });
      return new Uint8Array(PDF_BYTES);
    });
    const store = makeStore(api, render);
    await store.bootstrap([await currentSource()]);

    const result = await store.finalize(finalizationInput());

    expect(result.entry.invoiceNumber).toBe('9/2026');
    expect(result.snapshot.config.config.invoiceSequenceByYear).toEqual({ '2026': 9 });
    expect(api.mutations()).toEqual([
      'config:sequence:if-match',
      'pdf:create:generated-1',
      'pdf:get:generated-1',
    ]);
  });

  it('keeps an allocated gap when rendering fails', async () => {
    const api = new MemoryDriveApi(configuredDrive());
    const store = makeStore(
      api,
      vi.fn(async () => Promise.reject(new Error('render failed')))
    );
    await store.bootstrap([await currentSource()]);

    await expect(store.finalize(finalizationInput())).rejects.toThrow();

    const stored = parseConfigYaml(new TextDecoder().decode(api.file(CONFIG_ID).bytes));
    expect(stored.invoiceSequenceByYear).toEqual({ '2026': 9 });
    expect(api.mutations()).toEqual(['config:sequence:if-match']);
    await expect(makeStore(api).bootstrap([])).resolves.toMatchObject({
      config: { config: { invoiceSequenceByYear: { '2026': 9 } } },
    });
  });

  it('rejects an existing studio/month before consuming another number', async () => {
    const existing = await managedPdf((await currentSource()).fingerprint.sourceSha256);
    const api = new MemoryDriveApi(configuredDrive([existing]));
    const store = makeStore(api);
    await store.bootstrap([await currentSource()]);

    await expect(store.finalize(finalizationInput())).rejects.toMatchObject({ code: 'duplicate' });
    expect(parseConfigYaml(new TextDecoder().decode(api.file(CONFIG_ID).bytes))).toMatchObject({
      invoiceSequenceByYear: { '2026': 8 },
    });
    expect(api.mutations()).toEqual([]);
  });

  it('re-finalizes in place without changing the sequence', async () => {
    const existing = await managedPdf('0'.repeat(64));
    const api = new MemoryDriveApi(configuredDrive([existing]));
    const store = makeStore(
      api,
      vi.fn(async () => new Uint8Array(UPDATED_PDF_BYTES))
    );
    const source = await currentSource();
    const snapshot = await store.bootstrap([source]);
    const stale = snapshot!.scan.entries.find((entry) => entry.file.id === existing.id)!;

    const result = await store.refinalize(finalizationInput(), stale);

    expect(result.entry.file.id).toBe(existing.id);
    expect(result.entry.invoiceNumber).toBe('8/2026');
    expect(result.snapshot.config.config.invoiceSequenceByYear).toEqual({ '2026': 8 });
    expect(api.file(existing.id).bytes).toEqual(UPDATED_PDF_BYTES);
    expect(api.mutations()).toEqual([
      `pdf:get:${existing.id}`,
      `pdf:update:${existing.id}`,
      `pdf:get:${existing.id}`,
    ]);
  });
});
