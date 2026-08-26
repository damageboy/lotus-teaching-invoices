import { describe, expect, it, vi } from 'vitest';
import { DriveError, type DriveFileRecord } from '../../src/lib/drive/types.js';
import {
  createTauriDriveApi,
  type CreateDriveFileRequest,
  type ListFilesRequest,
  type UpdateDriveFileRequest,
} from '../../src/lib/drive/transport.js';

const FILE: DriveFileRecord = {
  id: 'file-1',
  name: 'invoice.pdf',
  mimeType: 'application/pdf',
  parents: ['folder-1'],
  driveId: 'drive-1',
  ownedByMe: true,
  trashed: false,
  version: '7',
  size: '3',
  md5Checksum: 'md5',
  sha256Checksum: 'sha256',
  properties: { lotusSchema: '1' },
  capabilities: {
    canListChildren: false,
    canAddChildren: false,
    canEdit: true,
    canDownload: true,
  },
  etag: '"etag-1"',
};

function listRequest(): ListFilesRequest {
  return {
    query: 'trashed = false',
    corpora: 'drive',
    driveId: 'drive-1',
    pageToken: 'page-1',
    pageSize: 50,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  };
}

function createRequest(): CreateDriveFileRequest {
  return {
    fileId: 'file-1',
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    parents: ['folder-1'],
    properties: { lotusSchema: '1' },
    bytes: [0, 127, 255],
    supportsAllDrives: true,
  };
}

function updateRequest(): UpdateDriveFileRequest {
  return { ...createRequest(), ifMatch: '"etag-1"' };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn().mockResolvedValue(FILE),
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    clearEphemeralAccessToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createTauriDriveApi', () => {
  it('invokes list and read commands with the exact Task 3 wire shape', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'drive-1', name: 'Shared' }], nextPageToken: null })
      .mockResolvedValueOnce({ items: [FILE], nextPageToken: 'page-2' })
      .mockResolvedValueOnce(FILE)
      .mockResolvedValueOnce({ file: FILE, bytes: [0, 127, 255] })
      .mockResolvedValueOnce(['generated-1', 'generated-2']);
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(api.listSharedDrives({ pageSize: 25, pageToken: 'shared-page' })).resolves.toEqual(
      {
        items: [{ id: 'drive-1', name: 'Shared' }],
        nextPageToken: null,
      }
    );
    await expect(api.listFiles(listRequest())).resolves.toEqual({
      items: [FILE],
      nextPageToken: 'page-2',
    });
    await expect(api.getFile({ fileId: 'file-1', supportsAllDrives: true })).resolves.toEqual(FILE);
    await expect(api.downloadFile({ fileId: 'file-1', supportsAllDrives: true })).resolves.toEqual({
      file: FILE,
      bytes: new Uint8Array([0, 127, 255]),
    });
    await expect(api.generateFileIds(2)).resolves.toEqual(['generated-1', 'generated-2']);

    expect(invoke.mock.calls).toEqual([
      [
        'list_shared_drives',
        {
          accessToken: 'access-token',
          request: { pageSize: 25, pageToken: 'shared-page' },
        },
      ],
      ['list_files', { accessToken: 'access-token', request: listRequest() }],
      [
        'get_file',
        { accessToken: 'access-token', request: { fileId: 'file-1', supportsAllDrives: true } },
      ],
      [
        'download_file',
        { accessToken: 'access-token', request: { fileId: 'file-1', supportsAllDrives: true } },
      ],
      ['generate_file_ids', { accessToken: 'access-token', request: { count: 2, space: 'drive' } }],
    ]);
  });

  it('invokes create and update commands with caller-provided IDs, parents, bytes, and ETags', async () => {
    const invoke = vi.fn().mockResolvedValue(FILE);
    const api = createTauriDriveApi(dependencies({ invoke }));

    await api.createFolder({ name: 'Invoices', parentId: 'root', supportsAllDrives: true });
    await api.createFile(createRequest());
    await api.updateFile(updateRequest());
    await api.patchMetadata({
      fileId: 'file-1',
      properties: { lotusOperationId: 'operation-1' },
      ifMatch: '"etag-1"',
      supportsAllDrives: true,
    });

    expect(invoke.mock.calls).toEqual([
      [
        'create_folder',
        {
          accessToken: 'access-token',
          request: { name: 'Invoices', parentId: 'root', supportsAllDrives: true },
        },
      ],
      ['create_file', { accessToken: 'access-token', request: createRequest() }],
      ['update_file', { accessToken: 'access-token', request: updateRequest() }],
      [
        'patch_metadata',
        {
          accessToken: 'access-token',
          request: {
            fileId: 'file-1',
            properties: { lotusOperationId: 'operation-1' },
            ifMatch: '"etag-1"',
            supportsAllDrives: true,
          },
        },
      ],
    ]);
  });

  it('refreshes authorization exactly once after a 401 without launching UI', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'authorization',
        status: 401,
        message: 'expired',
        retryable: false,
      })
      .mockResolvedValueOnce({ items: [], nextPageToken: null });
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');
    const clearEphemeralAccessToken = vi.fn().mockResolvedValue(undefined);
    const api = createTauriDriveApi(
      dependencies({ invoke, getAccessToken, clearEphemeralAccessToken })
    );

    await expect(api.listFiles(listRequest())).resolves.toEqual({
      items: [],
      nextPageToken: null,
    });
    expect(getAccessToken.mock.calls).toEqual([
      [{ requireDrive: true, interactive: false }],
      [{ requireDrive: true, forceRefresh: true, interactive: false }],
    ]);
    expect(clearEphemeralAccessToken).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({ accessToken: 'fresh-token' });
  });

  it('does not retry a second authorization failure', async () => {
    const invoke = vi.fn().mockRejectedValue({
      code: 'authorization',
      status: 401,
      message: 'still expired',
      retryable: false,
    });
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');
    const clearEphemeralAccessToken = vi.fn().mockResolvedValue(undefined);
    const api = createTauriDriveApi(
      dependencies({ invoke, getAccessToken, clearEphemeralAccessToken })
    );

    await expect(api.listFiles(listRequest())).rejects.toMatchObject({
      code: 'authorization',
      status: 401,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(clearEphemeralAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not retry a precondition conflict and preserves Rust error fields', async () => {
    const invoke = vi.fn().mockRejectedValue({
      code: 'conflict',
      status: 412,
      message: 'changed remotely',
      retryable: false,
      fileId: 'file-1',
    });
    const getAccessToken = vi.fn().mockResolvedValue('access-token');
    const api = createTauriDriveApi(dependencies({ invoke, getAccessToken }));

    await expect(api.updateFile(updateRequest())).rejects.toEqual(
      new DriveError('conflict', 'changed remotely', false, 412, 'file-1')
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-401 errors', async () => {
    const invoke = vi.fn().mockRejectedValue({
      code: 'server',
      status: 503,
      message: 'unavailable',
      retryable: true,
    });
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(api.getFile({ fileId: 'file-1', supportsAllDrives: true })).rejects.toMatchObject({
      code: 'server',
      status: 503,
      retryable: true,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('accepts the null optional fields serialized by a typed Rust command error', async () => {
    const invoke = vi.fn().mockRejectedValue({
      code: 'permission',
      status: null,
      message: 'forbidden',
      retryable: false,
      fileId: null,
    });
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(api.listFiles(listRequest())).rejects.toEqual(
      new DriveError('permission', 'forbidden', false)
    );
  });

  it.each([
    ['a malformed thrown value', 'not a command error'],
    ['a malformed resolved value', { items: 'not-an-array', nextPageToken: null }],
  ])('normalizes %s to invalidResponse', async (_label, value) => {
    const invoke =
      typeof value === 'string'
        ? vi.fn().mockRejectedValue(value)
        : vi.fn().mockResolvedValue(value);
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(api.listFiles(listRequest())).rejects.toMatchObject({
      name: 'DriveError',
      code: 'invalidResponse',
      retryable: false,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed download bytes instead of silently coercing them', async () => {
    const invoke = vi.fn().mockResolvedValue({ file: FILE, bytes: [0, -1, 256, 1.5] });
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(
      api.downloadFile({ fileId: 'file-1', supportsAllDrives: true })
    ).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('rejects a non-boolean trashed field instead of silently accepting it', async () => {
    const invoke = vi.fn().mockResolvedValue({ ...FILE, trashed: 'false' });
    const api = createTauriDriveApi(dependencies({ invoke }));

    await expect(api.getFile({ fileId: 'file-1', supportsAllDrives: true })).rejects.toMatchObject({
      code: 'invalidResponse',
    });
  });
});
