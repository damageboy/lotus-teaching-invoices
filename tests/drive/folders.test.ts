import { describe, expect, it, vi } from 'vitest';
import type { DriveApi } from '../../src/lib/drive/api.js';
import { DriveFolderService, type DriveLocation } from '../../src/lib/drive/folders.js';
import type { DriveFileRecord } from '../../src/lib/drive/types.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function folder(
  id: string,
  name: string,
  overrides: Partial<DriveFileRecord> = {}
): DriveFileRecord {
  return {
    id,
    name,
    mimeType: FOLDER_MIME_TYPE,
    parents: ['root'],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: null,
    md5Checksum: null,
    sha256Checksum: null,
    properties: {},
    capabilities: {
      canListChildren: true,
      canAddChildren: true,
      canEdit: true,
      canDownload: false,
    },
    etag: '"folder-etag"',
    ...overrides,
  };
}

function driveApi(overrides: Partial<DriveApi> = {}): DriveApi {
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected Drive API call');
  };
  return {
    listSharedDrives: unsupported,
    listFiles: unsupported,
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

function myDrive(): DriveLocation {
  return { kind: 'myDrive', id: 'root', name: 'My Drive', driveId: null };
}

function sharedDrive(id = 'drive-1', name = 'Team Drive'): DriveLocation {
  return { kind: 'sharedDrive', id, name, driveId: id };
}

describe('DriveFolderService.listLocations', () => {
  it('returns My Drive plus every paged Shared Drive and deduplicates IDs', async () => {
    const listSharedDrives = vi
      .fn<DriveApi['listSharedDrives']>()
      .mockResolvedValueOnce({
        items: [
          { id: 'drive-2', name: 'Second' },
          { id: 'drive-1', name: 'First' },
        ],
        nextPageToken: 'next-1',
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'drive-1', name: 'Duplicate label is ignored' },
          { id: 'drive-3', name: 'Third' },
        ],
        nextPageToken: null,
      });

    await expect(
      new DriveFolderService(driveApi({ listSharedDrives })).listLocations()
    ).resolves.toEqual([
      myDrive(),
      sharedDrive('drive-2', 'Second'),
      sharedDrive('drive-1', 'First'),
      sharedDrive('drive-3', 'Third'),
    ]);
    expect(listSharedDrives.mock.calls).toEqual([
      [{ pageSize: 100 }],
      [{ pageSize: 100, pageToken: 'next-1' }],
    ]);
  });

  it.each([
    ['blank', '   ', 1],
    ['repeated', 'next-1', 2],
  ])('rejects a %s Shared Drive page token', async (_label, finalToken, expectedCalls) => {
    const listSharedDrives = vi
      .fn<DriveApi['listSharedDrives']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: finalToken })
      .mockResolvedValueOnce({ items: [], nextPageToken: finalToken });

    await expect(
      new DriveFolderService(driveApi({ listSharedDrives })).listLocations()
    ).rejects.toMatchObject({ code: 'invalidResponse' });
    expect(listSharedDrives).toHaveBeenCalledTimes(expectedCalls);
  });

  it.each([[{ id: '', name: 'No ID' }], [{ id: 'drive-1', name: '' }]])(
    'rejects an invalid Shared Drive record: %j',
    async (record) => {
      const listSharedDrives = vi
        .fn<DriveApi['listSharedDrives']>()
        .mockResolvedValue({ items: [record], nextPageToken: null });

      await expect(
        new DriveFolderService(driveApi({ listSharedDrives })).listLocations()
      ).rejects.toMatchObject({ code: 'invalidResponse' });
    }
  );
});

describe('DriveFolderService.listChildren', () => {
  it('uses Shared Drive corpora and flags and safely escapes the parent ID', async () => {
    const listed = folder('child-1', 'Child', {
      parents: ["folder-'\\one"],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [listed], nextPageToken: 'next-1' });
    const service = new DriveFolderService(driveApi({ listFiles }));

    await expect(service.listChildren(sharedDrive(), "folder-'\\one")).resolves.toEqual({
      folders: [listed],
      nextPageToken: 'next-1',
    });
    expect(listFiles).toHaveBeenCalledWith({
      corpora: 'drive',
      driveId: 'drive-1',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      query:
        "'folder-\\'\\\\one' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 100,
    });
  });

  it('uses My Drive corpora and flags and forwards a valid page token', async () => {
    const listed = folder('child-1', 'Child', { parents: ['folder-1'] });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [listed], nextPageToken: null });

    await expect(
      new DriveFolderService(driveApi({ listFiles })).listChildren(myDrive(), 'folder-1', 'page-2')
    ).resolves.toEqual({ folders: [listed], nextPageToken: null });
    expect(listFiles).toHaveBeenCalledWith({
      corpora: 'user',
      includeItemsFromAllDrives: false,
      supportsAllDrives: true,
      query:
        "'folder-1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 100,
      pageToken: 'page-2',
    });
  });

  it('resolves the My Drive root alias and uses its canonical ID as parent authority', async () => {
    const canonicalRoot = folder('canonical-root-1', 'My Drive label', { parents: [] });
    const listed = folder('child-1', 'Child', { parents: ['canonical-root-1'] });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(canonicalRoot);
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [listed], nextPageToken: null });

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles })).listChildren(myDrive(), 'root')
    ).resolves.toEqual({ folders: [listed], nextPageToken: null });
    expect(getFile).toHaveBeenCalledWith({ fileId: 'root', supportsAllDrives: true });
    expect(listFiles).toHaveBeenCalledWith({
      corpora: 'user',
      includeItemsFromAllDrives: false,
      supportsAllDrives: true,
      query:
        "'canonical-root-1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 100,
    });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['malformed', { id: '' }],
    ['still identified by the root alias', { id: 'root' }],
    ['from a Shared Drive', { driveId: 'drive-1' }],
    ['not owned by the user', { ownedByMe: false }],
    ['not a folder', { mimeType: 'application/pdf' }],
    ['trashed', { trashed: true }],
    ['not the actual root', { parents: ['another-parent'] }],
  ])('rejects a %s My Drive root resolution', async (_label, overrides) => {
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(
      folder('canonical-root-1', 'My Drive label', {
        parents: [],
        ...overrides,
      })
    );
    const listFiles = vi.fn<DriveApi['listFiles']>();

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles })).listChildren(myDrive(), 'root')
    ).rejects.toMatchObject({ code: 'invalidResponse' });
    expect(getFile).toHaveBeenCalledWith({ fileId: 'root', supportsAllDrives: true });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('deduplicates folder IDs within a page', async () => {
    const first = folder('child-1', 'First label', { parents: ['folder-1'] });
    const listFiles = vi.fn<DriveApi['listFiles']>().mockResolvedValue({
      items: [first, folder('child-1', 'Second label', { parents: ['folder-1'] })],
      nextPageToken: null,
    });

    await expect(
      new DriveFolderService(driveApi({ listFiles })).listChildren(myDrive(), 'folder-1')
    ).resolves.toEqual({ folders: [first], nextPageToken: null });
  });

  it.each([
    ['blank input token', '   ', null],
    ['blank response token', undefined, '   '],
    ['repeated response token', 'page-2', 'page-2'],
  ])('rejects a %s', async (_label, pageToken, nextPageToken) => {
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [], nextPageToken });
    const service = new DriveFolderService(driveApi({ listFiles }));

    await expect(service.listChildren(myDrive(), 'folder-1', pageToken)).rejects.toMatchObject({
      code: 'invalidResponse',
    });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['a non-folder MIME type', { mimeType: 'application/pdf' }],
    ['a trashed folder', { trashed: true }],
    ['a folder outside the requested parent', { parents: ['other-parent'] }],
    ['a Shared Drive folder from another drive', { driveId: 'drive-2' }],
  ])('rejects %s returned by a Shared Drive child query', async (_label, overrides) => {
    const listFiles = vi.fn<DriveApi['listFiles']>().mockResolvedValue({
      items: [
        folder('child-1', 'Child', {
          parents: ['parent-1'],
          driveId: 'drive-1',
          ownedByMe: false,
          ...overrides,
        }),
      ],
      nextPageToken: null,
    });

    await expect(
      new DriveFolderService(driveApi({ listFiles })).listChildren(sharedDrive(), 'parent-1')
    ).rejects.toMatchObject({ code: 'invalidResponse', fileId: 'child-1' });
  });

  it('rejects a My Drive child that claims a Shared Drive identity', async () => {
    const listFiles = vi.fn<DriveApi['listFiles']>().mockResolvedValue({
      items: [folder('child-1', 'Child', { parents: ['folder-1'], driveId: 'drive-1' })],
      nextPageToken: null,
    });

    await expect(
      new DriveFolderService(driveApi({ listFiles })).listChildren(myDrive(), 'folder-1')
    ).rejects.toMatchObject({ code: 'invalidResponse', fileId: 'child-1' });
  });
});

describe('DriveFolderService.createChild', () => {
  it('creates and validates a Shared Drive child with Shared Drive support', async () => {
    const created = folder('created-1', 'Final', {
      parents: ['parent-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

    await expect(
      new DriveFolderService(driveApi({ createFolder })).createChild(
        sharedDrive(),
        'parent-1',
        'Final'
      )
    ).resolves.toEqual(created);
    expect(createFolder).toHaveBeenCalledWith({
      name: 'Final',
      parentId: 'parent-1',
      supportsAllDrives: true,
    });
  });

  it('resolves the My Drive root alias and creates against its canonical ID', async () => {
    const canonicalRoot = folder('canonical-root-1', 'My Drive label', { parents: [] });
    const created = folder('created-1', 'Invoices', { parents: ['canonical-root-1'] });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(canonicalRoot);
    const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

    await new DriveFolderService(driveApi({ getFile, createFolder })).createChild(
      myDrive(),
      'root',
      'Invoices'
    );

    expect(getFile).toHaveBeenCalledWith({ fileId: 'root', supportsAllDrives: true });
    expect(createFolder).toHaveBeenCalledWith({
      name: 'Invoices',
      parentId: 'canonical-root-1',
      supportsAllDrives: true,
    });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['wrong name', { name: 'Not Final' }],
    ['wrong parent', { parents: ['other-parent'] }],
    ['wrong MIME type', { mimeType: 'application/pdf' }],
    ['trashed result', { trashed: true }],
  ])('rejects a created child with the %s', async (_label, overrides) => {
    const createFolder = vi
      .fn<DriveApi['createFolder']>()
      .mockResolvedValue(folder('created-1', 'Final', { parents: ['folder-1'], ...overrides }));

    await expect(
      new DriveFolderService(driveApi({ createFolder })).createChild(myDrive(), 'folder-1', 'Final')
    ).rejects.toMatchObject({ code: 'invalidResponse', fileId: 'created-1' });
  });
});

describe('DriveFolderService.stageRoot', () => {
  it('fresh-GETs the root, enumerates all pages, and stages one existing Final folder', async () => {
    const freshRoot = folder('root-1', 'Fresh Invoice Label', { parents: ['parent-1'] });
    const final = folder('final-1', 'Final', { parents: ['root-1'] });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({
        items: [folder('drafts-1', 'Drafts', { parents: ['root-1'] })],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({ items: [final], nextPageToken: null });
    const getFile = vi.fn<DriveApi['getFile']>(async ({ fileId }) => {
      if (fileId === 'root-1') return freshRoot;
      if (fileId === 'final-1') return final;
      throw new Error(`unexpected file ID: ${fileId}`);
    });
    const createFolder = vi.fn<DriveApi['createFolder']>();

    await expect(
      new DriveFolderService(driveApi({ listFiles, getFile, createFolder })).stageRoot(
        folder('root-1', 'Stale Invoice Label', { parents: ['parent-1'] })
      )
    ).resolves.toEqual({
      root: {
        folderId: 'root-1',
        driveId: null,
        folderName: 'Fresh Invoice Label',
      },
      rootFile: freshRoot,
      finalFolder: final,
    });
    expect(getFile.mock.calls).toEqual([
      [{ fileId: 'root-1', supportsAllDrives: true }],
      [{ fileId: 'final-1', supportsAllDrives: true }],
    ]);
    expect(listFiles.mock.calls.map(([request]) => request.pageToken)).toEqual([
      undefined,
      'page-2',
    ]);
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('creates Final only when none exists and exact-GETs the created folder', async () => {
    const freshRoot = folder('root-1', 'Invoices', {
      parents: ['drive-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const created = folder('final-created', 'Final', {
      parents: ['root-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const exactFinal = folder('final-created', 'Final', {
      parents: ['root-1'],
      driveId: 'drive-1',
      ownedByMe: false,
      version: '2',
    });
    const getFile = vi
      .fn<DriveApi['getFile']>()
      .mockResolvedValueOnce(freshRoot)
      .mockResolvedValueOnce(exactFinal);
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: null })
      .mockResolvedValueOnce({ items: [created], nextPageToken: null });
    const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles, createFolder })).stageRoot(
        folder('root-1', 'Invoices', {
          parents: ['drive-1'],
          driveId: 'drive-1',
          ownedByMe: false,
        })
      )
    ).resolves.toEqual({
      root: { folderId: 'root-1', driveId: 'drive-1', folderName: 'Invoices' },
      rootFile: freshRoot,
      finalFolder: exactFinal,
    });
    expect(createFolder).toHaveBeenCalledWith({
      name: 'Final',
      parentId: 'root-1',
      supportsAllDrives: true,
    });
    expect(getFile.mock.calls).toEqual([
      [{ fileId: 'root-1', supportsAllDrives: true }],
      [{ fileId: 'final-created', supportsAllDrives: true }],
    ]);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it('blocks a concurrent distinct Final folder discovered after creation', async () => {
    const root = folder('root-1', 'Invoices');
    const created = folder('final-created', 'Final', { parents: ['root-1'] });
    const racer = folder('final-racer', 'Final', { parents: ['root-1'] });
    const getFile = vi.fn<DriveApi['getFile']>(async ({ fileId }) =>
      fileId === 'root-1' ? root : created
    );
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: null })
      .mockResolvedValueOnce({ items: [created], nextPageToken: 'post-page-2' })
      .mockResolvedValueOnce({ items: [racer], nextPageToken: null });
    const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles, createFolder })).stageRoot(root)
    ).rejects.toMatchObject({
      code: 'duplicateFinalFolder',
      fileIds: ['final-created', 'final-racer'],
    });
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it('rejects creation when the created Final is not visible after full re-enumeration', async () => {
    const root = folder('root-1', 'Invoices');
    const created = folder('final-created', 'Final', { parents: ['root-1'] });
    const getFile = vi.fn<DriveApi['getFile']>(async ({ fileId }) =>
      fileId === 'root-1' ? root : created
    );
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: null })
      .mockResolvedValueOnce({
        items: [folder('drafts-1', 'Drafts', { parents: ['root-1'] })],
        nextPageToken: 'post-page-2',
      })
      .mockResolvedValueOnce({ items: [], nextPageToken: null });
    const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles, createFolder })).stageRoot(root)
    ).rejects.toMatchObject({
      code: 'conflict',
      fileId: 'final-created',
    });
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it('blocks two distinct direct Final folders across pages', async () => {
    const root = folder('root-1', 'Invoices');
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({
        items: [folder('f1', 'Final', { parents: ['root-1'] })],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [folder('f2', 'Final', { parents: ['root-1'] })],
        nextPageToken: null,
      });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(root);
    const createFolder = vi.fn<DriveApi['createFolder']>();

    await expect(
      new DriveFolderService(driveApi({ listFiles, getFile, createFolder })).stageRoot(root)
    ).rejects.toMatchObject({
      code: 'duplicateFinalFolder',
      fileIds: ['f1', 'f2'],
    });
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('deduplicates the same Final ID repeated across pages', async () => {
    const root = folder('root-1', 'Invoices');
    const final = folder('final-1', 'Final', { parents: ['root-1'] });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [final], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ items: [final], nextPageToken: null });
    const getFile = vi.fn<DriveApi['getFile']>(async ({ fileId }) =>
      fileId === 'root-1' ? root : final
    );

    await expect(
      new DriveFolderService(driveApi({ listFiles, getFile })).stageRoot(root)
    ).resolves.toMatchObject({ finalFolder: { id: 'final-1' } });
  });

  it.each([
    ['canListChildren', { canListChildren: false }, 'root'],
    ['canAddChildren', { canAddChildren: false }, 'root'],
  ] as const)('rejects a selected root without %s', async (_label, missing, _target) => {
    const root = folder('root-1', 'Invoices', {
      capabilities: { ...folder('unused', 'Unused').capabilities, ...missing },
    });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(root);

    await expect(
      new DriveFolderService(driveApi({ getFile })).stageRoot(root)
    ).rejects.toMatchObject({ code: 'permission', fileId: 'root-1' });
  });

  it.each([
    ['canListChildren', { canListChildren: false }],
    ['canAddChildren', { canAddChildren: false }],
    ['canEdit', { canEdit: false }],
  ] as const)('rejects an exact Final folder without %s', async (_label, missing) => {
    const root = folder('root-1', 'Invoices');
    const listedFinal = folder('final-1', 'Final', { parents: ['root-1'] });
    const exactFinal = folder('final-1', 'Final', {
      parents: ['root-1'],
      capabilities: { ...listedFinal.capabilities, ...missing },
    });
    const getFile = vi
      .fn<DriveApi['getFile']>()
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(exactFinal);
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [listedFinal], nextPageToken: null });

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles })).stageRoot(root)
    ).rejects.toMatchObject({ code: 'permission', fileId: 'final-1' });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['changed ID', { id: 'different-root' }],
    ['changed drive identity', { driveId: 'drive-2' }],
    ['non-folder MIME type', { mimeType: 'application/pdf' }],
    ['trashed state', { trashed: true }],
  ])('rejects a fresh root with a %s', async (_label, overrides) => {
    const selected = folder('root-1', 'Invoices', {
      parents: ['drive-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue({ ...selected, ...overrides });

    await expect(
      new DriveFolderService(driveApi({ getFile })).stageRoot(selected)
    ).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it.each<[string, Partial<DriveFileRecord>]>([
    ['renamed', { name: 'Moved Final' }],
    ['moved', { parents: ['other-root'] }],
    ['changed drive identity', { driveId: 'drive-2' }],
    ['trashed', { trashed: true }],
  ])('rejects an exact Final folder that was %s', async (_label, overrides) => {
    const root = folder('root-1', 'Invoices', {
      parents: ['drive-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const listedFinal = folder('final-1', 'Final', {
      parents: ['root-1'],
      driveId: 'drive-1',
      ownedByMe: false,
    });
    const getFile = vi
      .fn<DriveApi['getFile']>()
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce({ ...listedFinal, ...overrides });
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValue({ items: [listedFinal], nextPageToken: null });

    await expect(
      new DriveFolderService(driveApi({ getFile, listFiles })).stageRoot(root)
    ).rejects.toMatchObject({ code: 'invalidResponse', fileId: 'final-1' });
  });

  it('rejects a repeated child page token while enumerating Final folders', async () => {
    const root = folder('root-1', 'Invoices');
    const listFiles = vi
      .fn<DriveApi['listFiles']>()
      .mockResolvedValueOnce({ items: [], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ items: [], nextPageToken: 'page-2' });
    const getFile = vi.fn<DriveApi['getFile']>().mockResolvedValue(root);

    await expect(
      new DriveFolderService(driveApi({ listFiles, getFile })).stageRoot(root)
    ).rejects.toMatchObject({ code: 'invalidResponse' });
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['blank', '   ', 2],
    ['repeated', 'post-page-2', 3],
  ])(
    'rejects a %s page token while re-enumerating Final after creation',
    async (_label, nextPageToken, expectedCalls) => {
      const root = folder('root-1', 'Invoices');
      const created = folder('final-created', 'Final', { parents: ['root-1'] });
      const getFile = vi.fn<DriveApi['getFile']>(async ({ fileId }) =>
        fileId === 'root-1' ? root : created
      );
      const listFiles = vi
        .fn<DriveApi['listFiles']>()
        .mockResolvedValueOnce({ items: [], nextPageToken: null })
        .mockResolvedValueOnce({ items: [], nextPageToken })
        .mockResolvedValueOnce({ items: [], nextPageToken });
      const createFolder = vi.fn<DriveApi['createFolder']>().mockResolvedValue(created);

      await expect(
        new DriveFolderService(driveApi({ getFile, listFiles, createFolder })).stageRoot(root)
      ).rejects.toMatchObject({ code: 'invalidResponse' });
      expect(listFiles).toHaveBeenCalledTimes(expectedCalls);
      expect(getFile).toHaveBeenCalledTimes(1);
    }
  );
});
