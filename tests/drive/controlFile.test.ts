import { describe, expect, it, vi } from 'vitest';
import type { DriveApi, DriveDownload, DriveListPage } from '../../src/lib/drive/api.js';
import {
  commitReservation,
  type ControlSnapshot,
  type DriveControl,
  DriveControlRepository,
  reserveExistingInvoice,
  reserveNextInvoice,
} from '../../src/lib/drive/controlFile.js';
import { DriveError, type DriveFileRecord } from '../../src/lib/drive/types.js';

const CONTROL_NAME = '.lotus-teaching-invoices.json';
const CONTROL_MARKER = { lotusConfigSchema: '1' };

function file(id: string, overrides: Partial<DriveFileRecord> = {}): DriveFileRecord {
  return {
    id,
    name: CONTROL_NAME,
    mimeType: 'application/json',
    parents: ['root'],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '4',
    size: '200',
    md5Checksum: null,
    sha256Checksum: 'control-sha256',
    properties: CONTROL_MARKER,
    capabilities: {
      canListChildren: false,
      canAddChildren: false,
      canEdit: true,
      canDownload: true,
    },
    etag: '"list-etag"',
    ...overrides,
  };
}

function control(overrides: Partial<DriveControl> = {}): DriveControl {
  return {
    schemaVersion: 1,
    generation: 4,
    root: {
      folderId: 'invoice-root',
      driveId: null,
      folderName: 'Lotus Invoices',
    },
    finalFolderId: 'final-folder',
    sequenceByYear: { '2025': 17, '2026': 8 },
    reservation: null,
    ...overrides,
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function snapshot(overrides: Partial<DriveControl> = {}): ControlSnapshot {
  return {
    file: file('control-1', { etag: '"download-etag"' }),
    control: control(overrides),
  };
}

function api(overrides: Partial<DriveApi> = {}): DriveApi {
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected Drive API call');
  };
  return {
    listSharedDrives: unsupported,
    listFiles: async () => ({ items: [], nextPageToken: null }),
    getFile: unsupported,
    downloadFile: unsupported,
    generateFileIds: unsupported,
    createFolder: unsupported,
    createFile: unsupported,
    updateFile: unsupported,
    patchMetadata: unsupported,
    ...overrides,
  };
}

function download(record: DriveFileRecord, value: unknown = control()): DriveDownload {
  return { file: record, bytes: bytes(value) };
}

function configuredApi(
  pages: DriveFileRecord[][],
  exactFile = file('control-1', { etag: '"exact-etag"' }),
  exactDownload = download(file('control-1', { etag: '"exact-etag"' }))
): DriveApi {
  const listFiles = vi.fn(async ({ pageToken }) => {
    const index = pageToken == null ? 0 : Number(pageToken.replace('page-', ''));
    return {
      items: pages[index] ?? [],
      nextPageToken: index + 1 < pages.length ? `page-${index + 1}` : null,
    };
  });
  return api({
    listFiles,
    getFile: vi.fn().mockResolvedValue(exactFile),
    downloadFile: vi.fn().mockResolvedValue(exactDownload),
  });
}

describe('DriveControlRepository discovery', () => {
  it('discovers one owned normal-Drive control file across all pages', async () => {
    const unreadableShared = file('shared', {
      driveId: 'shared-drive',
      ownedByMe: false,
      capabilities: { ...file('shared').capabilities, canDownload: false },
    });
    const owned = file('control-1');
    const driveApi = configuredApi([[unreadableShared], [owned]]);
    const listFiles = driveApi.listFiles as ReturnType<typeof vi.fn>;

    const result = await new DriveControlRepository(driveApi).discover();

    expect(result).toMatchObject({
      kind: 'configured',
      snapshot: { control: { generation: 4 }, file: { etag: '"exact-etag"' } },
    });
    expect(listFiles.mock.calls).toEqual([
      [
        {
          query:
            "name = '.lotus-teaching-invoices.json' and trashed = false and properties has { key='lotusConfigSchema' and value='1' }",
          corpora: 'user',
          pageSize: 100,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        },
      ],
      [
        {
          query:
            "name = '.lotus-teaching-invoices.json' and trashed = false and properties has { key='lotusConfigSchema' and value='1' }",
          corpora: 'user',
          pageToken: 'page-1',
          pageSize: 100,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        },
      ],
    ]);
  });

  it('returns unconfigured when no control file exists', async () => {
    await expect(new DriveControlRepository(configuredApi([[]])).discover()).resolves.toEqual({
      kind: 'unconfigured',
    });
  });

  it('discovers an editable marked control inside a Shared Drive folder', async () => {
    const sharedControl = file('control-1', {
      parents: ['shared-invoice-root'],
      driveId: 'shared-drive',
      ownedByMe: false,
    });
    const exact = file('control-1', {
      parents: ['shared-invoice-root'],
      driveId: 'shared-drive',
      ownedByMe: false,
      etag: '"exact-etag"',
    });
    const driveApi = configuredApi([[sharedControl]], exact, download(exact));

    await expect(new DriveControlRepository(driveApi).discover()).resolves.toMatchObject({
      kind: 'configured',
      snapshot: { file: { parents: ['shared-invoice-root'], driveId: 'shared-drive' } },
    });
  });

  it('filters wrong-name, wrong-MIME, unmarked, trashed, and unusable results', async () => {
    const driveApi = configuredApi([
      [
        file('wrong-name', { name: 'lotus.json' }),
        file('wrong-mime', { mimeType: 'text/plain' }),
        file('unmarked', { properties: {} }),
        file('trashed', { trashed: true }),
        file('not-editable', {
          capabilities: { ...file('not-editable').capabilities, canEdit: false },
        }),
        file('not-downloadable', {
          capabilities: { ...file('not-downloadable').capabilities, canDownload: false },
        }),
      ],
    ]);

    await expect(new DriveControlRepository(driveApi).discover()).resolves.toEqual({
      kind: 'unconfigured',
    });
    expect(driveApi.getFile).not.toHaveBeenCalled();
    expect(driveApi.downloadFile).not.toHaveBeenCalled();
  });

  it('blocks duplicate owned control files without loading or repairing them', async () => {
    const driveApi = configuredApi([[file('b')], [file('a')]]);

    await expect(new DriveControlRepository(driveApi).discover()).resolves.toEqual({
      kind: 'conflict',
      fileIds: ['a', 'b'],
    });
    expect(driveApi.getFile).not.toHaveBeenCalled();
    expect(driveApi.downloadFile).not.toHaveBeenCalled();
  });

  it('deduplicates the same control file ID repeated across pages', async () => {
    const driveApi = configuredApi([[file('control-1')], [file('control-1')]]);

    await expect(new DriveControlRepository(driveApi).discover()).resolves.toMatchObject({
      kind: 'configured',
      snapshot: { file: { id: 'control-1' } },
    });
    expect(driveApi.getFile).toHaveBeenCalledTimes(1);
    expect(driveApi.downloadFile).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   '])('rejects a blank next-page token %j immediately', async (nextPageToken) => {
    const listFiles = vi.fn().mockResolvedValue({ items: [], nextPageToken });

    await expect(new DriveControlRepository(api({ listFiles })).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'invalidResponse',
    });
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated nonblank next-page token', async () => {
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: 'same-page' })
      .mockResolvedValueOnce({ items: [], nextPageToken: 'same-page' });

    await expect(new DriveControlRepository(api({ listFiles })).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'invalidResponse',
    });
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it('accepts coherent exact metadata and media while ignoring the list ETag', async () => {
    const listRecord = file('control-1', { etag: '"stale-list"' });
    const getRecord = file('control-1', { etag: '"exact"', version: '6' });
    const downloadRecord = file('control-1', { etag: '"exact"', version: '6' });
    const driveApi = configuredApi(
      [[listRecord]],
      getRecord,
      download(downloadRecord, control({ generation: 6 }))
    );

    const result = await new DriveControlRepository(driveApi).discover();

    expect(result).toMatchObject({
      kind: 'configured',
      snapshot: { file: { etag: '"exact"', version: '6' }, control: { generation: 6 } },
    });
    expect(driveApi.getFile).toHaveBeenCalledWith({
      fileId: 'control-1',
      supportsAllDrives: true,
    });
    expect(driveApi.downloadFile).toHaveBeenCalledWith({
      fileId: 'control-1',
      supportsAllDrives: true,
    });
  });

  it('rejects mismatched exact metadata and media ETags', async () => {
    const metadata = file('control-1', { etag: '"metadata"' });
    const media = file('control-1', { etag: '"media"' });

    await expect(
      new DriveControlRepository(
        configuredApi([[file('control-1')]], metadata, download(media))
      ).discover()
    ).rejects.toMatchObject({ name: 'DriveError', code: 'invalidResponse', fileId: 'control-1' });
  });

  it.each([
    ['metadata', file('control-1', { etag: '   ' }), file('control-1', { etag: '"exact"' })],
    ['media', file('control-1', { etag: '"exact"' }), file('control-1', { etag: '' })],
  ])('rejects a blank %s ETag', async (_label, metadata, media) => {
    await expect(
      new DriveControlRepository(
        configuredApi([[file('control-1')]], metadata, download(media))
      ).discover()
    ).rejects.toMatchObject({ name: 'DriveError', code: 'invalidResponse', fileId: 'control-1' });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['ID', { id: 'different-id' }],
    ['name', { name: 'different.json' }],
    ['MIME', { mimeType: 'text/plain' }],
    ['parents', { parents: ['different-parent'] }],
    ['Drive authority', { driveId: 'shared-drive' }],
    ['ownership', { ownedByMe: false }],
    ['trashed state', { trashed: true }],
    ['properties', { properties: { ...CONTROL_MARKER, extra: 'value' } }],
    [
      'capabilities',
      {
        capabilities: {
          canListChildren: false,
          canAddChildren: false,
          canEdit: false,
          canDownload: true,
        },
      },
    ],
  ])('rejects incoherent exact metadata/media %s', async (_label, mediaOverride) => {
    const metadata = file('control-1', { etag: '"exact"' });
    const media = file('control-1', { etag: '"exact"', ...mediaOverride });

    await expect(
      new DriveControlRepository(
        configuredApi([[file('control-1')]], metadata, download(media))
      ).discover()
    ).rejects.toMatchObject({ name: 'DriveError', code: 'invalidResponse', fileId: 'control-1' });
  });

  it('rejects malformed JSON as a typed corrupt error', async () => {
    const exact = file('control-1', { etag: '"exact"' });
    const driveApi = configuredApi([[file('control-1')]], exact, {
      file: exact,
      bytes: new TextEncoder().encode('{not-json'),
    });

    await expect(new DriveControlRepository(driveApi).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'corrupt',
      fileId: 'control-1',
    });
  });

  it('rejects an unknown control schema as a typed corrupt error', async () => {
    const exact = file('control-1', { etag: '"exact"' });
    const driveApi = configuredApi(
      [[file('control-1')]],
      exact,
      download(exact, { ...control(), schemaVersion: 2 })
    );

    await expect(new DriveControlRepository(driveApi).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'corrupt',
      fileId: 'control-1',
    });
  });

  it.each([
    ['control', { ...control(), unexpected: true }],
    ['root', { ...control(), root: { ...control().root, unexpected: true } }],
    [
      'reservation',
      {
        ...control(),
        reservation: {
          operationId: 'op-1',
          year: 2026,
          invoiceNumber: '9/2026',
          studioSlug: 'studio-a',
          month: '2026-08',
          fileId: 'pdf-1',
          sourceSha256: 'source-1',
          startedAt: '2026-08-24T12:00:00Z',
          unexpected: true,
        },
      },
    ],
  ])('rejects unknown fields in the %s object', async (_label, invalidControl) => {
    const exact = file('control-1', { etag: '"exact"' });
    const driveApi = configuredApi([[file('control-1')]], exact, download(exact, invalidControl));

    await expect(new DriveControlRepository(driveApi).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'corrupt',
      fileId: 'control-1',
    });
  });

  it.each([
    ['negative generation', { ...control(), generation: -1 }],
    ['empty root ID', { ...control(), root: { ...control().root, folderId: '' } }],
    ['invalid root drive ID', { ...control(), root: { ...control().root, driveId: 4 } }],
    ['empty final folder ID', { ...control(), finalFolderId: '' }],
    ['invalid sequence year', { ...control(), sequenceByYear: { current: 8 } }],
    ['negative sequence', { ...control(), sequenceByYear: { '2026': -1 } }],
    ['unsafe sequence', { ...control(), sequenceByYear: { '2026': Number.MAX_SAFE_INTEGER + 1 } }],
    [
      'inconsistent reservation number',
      {
        ...control(),
        reservation: {
          operationId: 'op-1',
          year: 2026,
          invoiceNumber: '10/2026',
          studioSlug: 'studio-a',
          month: '2026-08',
          fileId: 'pdf-1',
          sourceSha256: 'source-1',
          startedAt: '2026-08-24T12:00:00Z',
        },
      },
    ],
  ])('rejects invalid control fields: %s', async (_label, invalidControl) => {
    const exact = file('control-1', { etag: '"exact"' });
    const driveApi = configuredApi([[file('control-1')]], exact, download(exact, invalidControl));

    await expect(new DriveControlRepository(driveApi).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'corrupt',
      fileId: 'control-1',
    });
  });

  it('rejects a missing exact download ETag as a typed invalid response', async () => {
    const exact = file('control-1', { etag: null });
    const driveApi = configuredApi(
      [[file('control-1', { etag: '"list-only"' })]],
      file('control-1', { etag: '"get-only"' }),
      download(exact)
    );

    await expect(new DriveControlRepository(driveApi).discover()).rejects.toMatchObject({
      name: 'DriveError',
      code: 'invalidResponse',
      fileId: 'control-1',
    });
  });
});

describe('DriveControlRepository create', () => {
  it('pre-generates an ID, re-lists before and after, and creates the marked file inside the selected root', async () => {
    const events: string[] = [];
    const created = file('generated-1', { etag: '"create-response"' });
    const downloaded = file('generated-1', { etag: '"exact-created"' });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockImplementationOnce(async () => {
        events.push('list:before');
        return { items: [], nextPageToken: null };
      })
      .mockImplementationOnce(async () => {
        events.push('list:after');
        return { items: [file('generated-1')], nextPageToken: null };
      });
    const generateFileIds = vi.fn(async () => {
      events.push('generate');
      return ['generated-1'];
    });
    const createFile = vi.fn(async () => {
      events.push('create');
      return created;
    });
    const driveApi = api({
      listFiles,
      generateFileIds,
      createFile,
      getFile: vi.fn().mockResolvedValue(downloaded),
      downloadFile: vi.fn().mockResolvedValue(download(downloaded)),
    });

    const result = await new DriveControlRepository(driveApi).create(control());

    expect(events).toEqual(['generate', 'list:before', 'create', 'list:after']);
    expect(generateFileIds).toHaveBeenCalledWith(1);
    expect(createFile).toHaveBeenCalledTimes(1);
    const request = createFile.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      fileId: 'generated-1',
      name: CONTROL_NAME,
      mimeType: 'application/json',
      parents: ['invoice-root'],
      properties: CONTROL_MARKER,
      supportsAllDrives: true,
    });
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(request?.bytes ?? [])))).toEqual(
      control()
    );
    expect(result.file.etag).toBe('"exact-created"');
  });

  it('blocks a race found by the pre-create re-list without creating a file', async () => {
    const createFile = vi.fn();
    const driveApi = api({
      generateFileIds: vi.fn().mockResolvedValue(['generated-1']),
      listFiles: vi.fn().mockResolvedValue({ items: [file('racer')], nextPageToken: null }),
      createFile,
    });

    await expect(new DriveControlRepository(driveApi).create(control())).rejects.toMatchObject({
      name: 'DriveError',
      code: 'conflict',
    });
    expect(createFile).not.toHaveBeenCalled();
  });

  it('blocks duplicates found by the post-create re-list without auto-repair', async () => {
    const getFile = vi.fn();
    const downloadFile = vi.fn();
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: null })
      .mockResolvedValueOnce({
        items: [file('generated-1'), file('racer')],
        nextPageToken: null,
      });
    const driveApi = api({
      generateFileIds: vi.fn().mockResolvedValue(['generated-1']),
      listFiles,
      createFile: vi.fn().mockResolvedValue(file('generated-1')),
      getFile,
      downloadFile,
    });

    await expect(new DriveControlRepository(driveApi).create(control())).rejects.toMatchObject({
      name: 'DriveError',
      code: 'conflict',
      fileId: 'generated-1',
    });
    expect(getFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('blocks a missing generated file found by the post-create re-list', async () => {
    const driveApi = api({
      generateFileIds: vi.fn().mockResolvedValue(['generated-1']),
      listFiles: vi.fn().mockResolvedValue({ items: [], nextPageToken: null }),
      createFile: vi.fn().mockResolvedValue(file('generated-1')),
    });

    await expect(new DriveControlRepository(driveApi).create(control())).rejects.toMatchObject({
      name: 'DriveError',
      code: 'conflict',
      fileId: 'generated-1',
    });
  });

  it('rejects malformed generated-ID responses as typed invalid responses', async () => {
    const driveApi = api({ generateFileIds: vi.fn().mockResolvedValue([]) });

    await expect(new DriveControlRepository(driveApi).create(control())).rejects.toMatchObject({
      name: 'DriveError',
      code: 'invalidResponse',
    });
  });
});

describe('DriveControlRepository replace', () => {
  it('uses the exact snapshot If-Match and increments generation exactly once', async () => {
    const updateFile = vi
      .fn<DriveApi['updateFile']>()
      .mockResolvedValue(file('control-1', { etag: '"updated-etag"', version: '5' }));
    const driveApi = api({ updateFile });
    const current = snapshot();
    const proposed = control({
      generation: 99,
      root: { folderId: 'new-root', driveId: 'shared-1', folderName: 'New Root' },
      finalFolderId: 'new-final',
    });

    const result = await new DriveControlRepository(driveApi).replace(current, proposed);

    const request = updateFile.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      fileId: 'control-1',
      ifMatch: '"download-etag"',
      name: CONTROL_NAME,
      mimeType: 'application/json',
      parents: ['new-root'],
      properties: CONTROL_MARKER,
      supportsAllDrives: true,
    });
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(request?.bytes ?? [])))).toEqual({
      ...proposed,
      generation: 5,
    });
    expect(result.control.generation).toBe(5);
    expect(result.file.etag).toBe('"updated-etag"');
    expect(proposed.generation).toBe(99);
    expect(current.control.generation).toBe(4);
  });

  it('rejects a missing snapshot ETag instead of issuing an unguarded update', async () => {
    const updateFile = vi.fn();
    const current = snapshot();
    current.file = file('control-1', { etag: null });

    await expect(
      new DriveControlRepository(api({ updateFile })).replace(current, control())
    ).rejects.toMatchObject({ name: 'DriveError', code: 'invalidResponse', fileId: 'control-1' });
    expect(updateFile).not.toHaveBeenCalled();
  });

  it('rejects a missing mutation-response ETag as a typed invalid response', async () => {
    const driveApi = api({
      updateFile: vi.fn().mockResolvedValue(file('control-1', { etag: null })),
    });

    await expect(
      new DriveControlRepository(driveApi).replace(snapshot(), control())
    ).rejects.toMatchObject({ name: 'DriveError', code: 'invalidResponse', fileId: 'control-1' });
  });

  it('preserves a typed 412 cross-device conflict', async () => {
    const conflict = new DriveError('conflict', 'changed remotely', false, 412, 'control-1');
    const driveApi = api({ updateFile: vi.fn().mockRejectedValue(conflict) });

    await expect(new DriveControlRepository(driveApi).replace(snapshot(), control())).rejects.toBe(
      conflict
    );
  });
});

describe('control reservation helpers', () => {
  const request = {
    operationId: 'op-1',
    year: 2026,
    studioSlug: 'studio-a',
    month: '2026-08',
    fileId: 'generated-id',
    sourceSha256: 'source-hash',
    startedAt: '2026-08-24T12:00:00Z',
  };

  it('reserves the next yearly number without committing the sequence or mutating input', () => {
    const current = snapshot({ sequenceByYear: { '2025': 17, '2026': 8 } });
    const original = structuredClone(current);

    const next = reserveNextInvoice(current, request);

    expect(next.control.reservation).toEqual({ ...request, invoiceNumber: '9/2026' });
    expect(next.control.sequenceByYear).toEqual({ '2025': 17, '2026': 8 });
    expect(next.control.generation).toBe(4);
    expect(current).toEqual(original);
    expect(next).not.toBe(current);
    expect(next.control).not.toBe(current.control);
    expect(next.control.sequenceByYear).not.toBe(current.control.sequenceByYear);
  });

  it('starts an unseen year at one without changing another year', () => {
    const next = reserveNextInvoice(snapshot({ sequenceByYear: { '2025': 17 } }), request);

    expect(next.control.reservation?.invoiceNumber).toBe('1/2026');
    expect(next.control.sequenceByYear).toEqual({ '2025': 17 });
  });

  it('treats an exact same-operation reservation retry as an immutable no-op', () => {
    const reserved = reserveNextInvoice(snapshot(), request);
    const original = structuredClone(reserved);

    const retried = reserveNextInvoice(reserved, request);

    expect(retried).toEqual(reserved);
    expect(reserved).toEqual(original);
    expect(retried).not.toBe(reserved);
    expect(retried.control).not.toBe(reserved.control);
    expect(retried.control.reservation).not.toBe(reserved.control.reservation);
  });

  it('rejects an existing different-operation reservation as a typed conflict', () => {
    const reserved = reserveNextInvoice(snapshot(), request);

    expect(() => reserveNextInvoice(reserved, { ...request, operationId: 'op-2' })).toThrowError(
      DriveError
    );
    expect(() => reserveNextInvoice(reserved, { ...request, operationId: 'op-2' })).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
  });

  it.each([
    ['year', { year: 2025, month: '2025-08' }],
    ['studio identity', { studioSlug: 'studio-b' }],
    ['month', { month: '2026-09' }],
    ['file identity', { fileId: 'different-file' }],
    ['source identity', { sourceSha256: 'different-source' }],
    ['start time', { startedAt: '2026-08-24T12:00:01Z' }],
  ])('rejects a same-operation retry with different %s', (_label, mismatch) => {
    const reserved = reserveNextInvoice(snapshot(), request);

    expect(() => reserveNextInvoice(reserved, { ...request, ...mismatch })).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'conflict' })
    );
  });

  it.each([
    ['operation ID', { operationId: '' }],
    ['year', { year: 0 }],
    ['studio identity', { studioSlug: '' }],
    ['month', { month: '2025-08' }],
    ['file identity', { fileId: '' }],
    ['source identity', { sourceSha256: '' }],
    ['start time', { startedAt: 'not-a-date' }],
  ])('validates reservation request %s', (_label, invalid) => {
    expect(() => reserveNextInvoice(snapshot(), { ...request, ...invalid })).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'corrupt' })
    );
  });

  it('commits only the matching reservation year and number without mutating input', () => {
    const reserved = reserveNextInvoice(snapshot(), request);
    const original = structuredClone(reserved);

    const committed = commitReservation(reserved, 'op-1');

    expect(committed.control.sequenceByYear).toEqual({ '2025': 17, '2026': 9 });
    expect(committed.control.reservation).toBeNull();
    expect(committed.control.generation).toBe(4);
    expect(reserved).toEqual(original);
    expect(committed.control.sequenceByYear).not.toBe(reserved.control.sequenceByYear);
  });

  it('leases an existing invoice number and clears it without advancing the sequence', () => {
    const current = snapshot({ sequenceByYear: { '2025': 17, '2026': 8 } });
    const original = structuredClone(current);

    const leased = reserveExistingInvoice(current, {
      ...request,
      fileId: 'existing-pdf-8',
      invoiceNumber: '8/2026',
    });

    expect(leased.control.reservation).toEqual({
      ...request,
      fileId: 'existing-pdf-8',
      invoiceNumber: '8/2026',
    });
    expect(leased.control.sequenceByYear).toEqual({ '2025': 17, '2026': 8 });
    expect(commitReservation(leased, 'op-1').control).toMatchObject({
      sequenceByYear: { '2025': 17, '2026': 8 },
      reservation: null,
    });
    expect(current).toEqual(original);
  });

  it('rejects an existing-number lease above the stored sequence', () => {
    expect(() =>
      reserveExistingInvoice(snapshot({ sequenceByYear: { '2026': 8 } }), {
        ...request,
        invoiceNumber: '9/2026',
      })
    ).toThrow(expect.objectContaining({ name: 'DriveError', code: 'corrupt' }));
  });

  it('serializes next-number and existing-number leases through the same reservation', () => {
    const leased = reserveExistingInvoice(snapshot(), {
      ...request,
      fileId: 'existing-pdf-8',
      invoiceNumber: '8/2026',
    });

    expect(() => reserveNextInvoice(leased, { ...request, operationId: 'new-op' })).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'conflict' })
    );
    expect(() =>
      reserveExistingInvoice(reserveNextInvoice(snapshot(), request), {
        ...request,
        operationId: 'refinalize-op',
        invoiceNumber: '8/2026',
      })
    ).toThrow(expect.objectContaining({ name: 'DriveError', code: 'conflict' }));
  });

  it('commits the largest safe invoice number, then rejects another reservation', () => {
    const atBoundary = snapshot({
      sequenceByYear: { '2026': Number.MAX_SAFE_INTEGER - 1 },
    });
    const reserved = reserveNextInvoice(atBoundary, request);

    const committed = commitReservation(reserved, 'op-1');

    expect(committed.control.sequenceByYear['2026']).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => reserveNextInvoice(committed, { ...request, operationId: 'op-2' })).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'corrupt' })
    );
  });

  it('rejects an unsafe parsed reservation number during commit', () => {
    const malformed = snapshot({
      sequenceByYear: { '2026': Number.MAX_SAFE_INTEGER },
      reservation: {
        ...request,
        invoiceNumber: `${Number.MAX_SAFE_INTEGER + 1}/2026`,
      },
    });

    expect(() => commitReservation(malformed, 'op-1')).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'corrupt' })
    );
  });

  it('does not commit a missing or different operation', () => {
    expect(() => commitReservation(snapshot(), 'op-1')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
    const reserved = reserveNextInvoice(snapshot(), request);
    expect(() => commitReservation(reserved, 'op-2')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
  });

  it.each([
    ['wrong year', { year: 2025 }],
    ['wrong number', { invoiceNumber: '10/2026' }],
    ['wrong number year', { invoiceNumber: '9/2025' }],
    ['empty studio', { studioSlug: '' }],
    ['month-year mismatch', { month: '2025-08' }],
    ['empty file ID', { fileId: '' }],
    ['empty source hash', { sourceSha256: '' }],
  ])('rejects corrupt stored reservation identity: %s', (_label, reservationOverride) => {
    const reserved = reserveNextInvoice(snapshot(), request);
    const malformed = {
      ...reserved,
      control: {
        ...reserved.control,
        reservation: { ...reserved.control.reservation!, ...reservationOverride },
      },
    };

    expect(() => commitReservation(malformed, 'op-1')).toThrow(
      expect.objectContaining({ name: 'DriveError', code: 'corrupt' })
    );
  });
});
