import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/config/defaults.js';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type { CurrentInvoiceSource } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import type { DriveInvoicesState } from '../../src/hooks/useDriveInvoices.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, renderHook } = await import('@testing-library/react');
const { useDriveFolderController } = await import('../../src/hooks/useDriveFolderController.js');

const folder = {
  id: 'invoice-root',
  name: 'Invoices',
  mimeType: 'application/vnd.google-apps.folder',
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
  etag: '"root-v1"',
};

const stagedRoot: StagedDriveRoot = {
  root: { folderId: folder.id, driveId: null, folderName: folder.name },
  rootFile: folder,
  finalFolder: { ...folder, id: 'final', name: 'Final', parents: [folder.id] },
};

function configuredSnapshot(root: StagedDriveRoot = stagedRoot): DriveStoreSnapshot {
  return {
    config: {
      file: {
        ...folder,
        id: 'config-file',
        name: 'lotus-invoices-config.yaml',
        mimeType: 'application/yaml',
        parents: [root.root.folderId],
        properties: { lotusConfigSchema: '1' },
        capabilities: { ...folder.capabilities, canDownload: true },
      },
      config: DEFAULT_CONFIG,
    },
    stagedRoot: root,
    scan: { entries: [], warnings: [], blockingConflicts: [], maxSequenceByYear: {} },
  };
}

function source(id: string): CurrentInvoiceSource {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    studioName: 'Studio A',
    fingerprint: { sourceSha256: id, calendarSha256: `calendar-${id}` },
  } as CurrentInvoiceSource;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function drive(
  status: DriveInvoicesState['status'] = 'unconfigured',
  activateRoot = vi.fn(async () => configuredSnapshot())
) {
  return {
    status,
    snapshot: null,
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => undefined),
    activateRoot,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    hasDriveAuthorization: true,
    authorizationIncarnation: 1,
    authorizeDrive: vi.fn(async () => undefined),
    drive: drive(),
    config: DEFAULT_CONFIG,
    sources: [],
    sourceContextKey: 'setup-discovery',
    scanCandidate: vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    })),
    ...overrides,
  };
}

describe('useDriveFolderController', () => {
  afterAll(restoreDom);

  it('waits for Drive discovery after authorization before opening the folder dialog', async () => {
    const authorization = deferred<void>();
    const discovery = deferred<void>();
    const authorizeDrive = vi.fn(() => authorization.promise);
    const refresh = vi.fn(() => discovery.promise);
    const loadingDrive = {
      ...drive('loading'),
      refresh,
    };
    const view = renderHook(
      ({
        hasDriveAuthorization,
        authorizationIncarnation,
        driveState,
        sourceContextKey,
        sources,
      }) =>
        useDriveFolderController(
          options({
            hasDriveAuthorization,
            authorizationIncarnation,
            authorizeDrive,
            drive: driveState,
            sourceContextKey,
            sources,
          })
        ),
      {
        initialProps: {
          hasDriveAuthorization: false,
          authorizationIncarnation: 1,
          driveState: drive('authorizationRequired'),
          sourceContextKey: 'setup-discovery',
          sources: [] as CurrentInvoiceSource[],
        },
      }
    );
    let opening!: Promise<void>;
    act(() => {
      opening = view.result.current.openDialog();
    });

    view.rerender({
      hasDriveAuthorization: true,
      authorizationIncarnation: 2,
      driveState: loadingDrive,
      sourceContextKey: 'setup-discovery',
      sources: [],
    });
    await act(async () => {
      authorization.resolve();
      await authorization.promise;
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(view.result.current.dialogOpen).toBe(false);

    view.rerender({
      hasDriveAuthorization: true,
      authorizationIncarnation: 2,
      driveState: loadingDrive,
      sourceContextKey: 'discovered-drive-config',
      sources: [source('discovered')],
    });
    await act(async () => {
      discovery.resolve();
      await opening;
    });
    expect(view.result.current.dialogOpen).toBe(true);
  });

  it('passes the in-memory config only for initial setup', async () => {
    const activateRoot = vi.fn(async () => configuredSnapshot());
    const { result } = renderHook(() =>
      useDriveFolderController(options({ drive: drive('unconfigured', activateRoot) }))
    );

    await act(() => result.current.confirmRoot(stagedRoot));

    expect(activateRoot).toHaveBeenCalledWith(stagedRoot, DEFAULT_CONFIG);
    expect(result.current.cleanupPending).toBe(false);
  });

  it('accepts an exact committed root after multiple invoice-source transitions', async () => {
    const activation = deferred<DriveStoreSnapshot>();
    const activateRoot = vi.fn(() => activation.promise);
    const view = renderHook(
      ({ sourceContextKey, sources, driveState }) =>
        useDriveFolderController(options({ sourceContextKey, sources, drive: driveState })),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          sources: [] as CurrentInvoiceSource[],
          driveState: drive('unconfigured', activateRoot),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'empty-calendar',
      sources: [],
      driveState: {
        ...drive('ready', activateRoot),
        snapshot: configuredSnapshot(),
      },
    });
    view.rerender({
      sourceContextKey: 'setup-discovery',
      sources: [],
      driveState: {
        ...drive('loading', activateRoot),
        snapshot: configuredSnapshot(),
      },
    });
    view.rerender({
      sourceContextKey: 'synced-calendar',
      sources: [source('synced')],
      driveState: {
        ...drive('ready', activateRoot),
        snapshot: configuredSnapshot(),
      },
    });

    await act(async () => {
      activation.resolve(configuredSnapshot());
      await expect(confirmation).resolves.toBeUndefined();
    });
    expect(view.result.current.error).toBeNull();
  });

  it('rejects an activation receipt for a different root', async () => {
    const otherRoot: StagedDriveRoot = {
      ...stagedRoot,
      root: { ...stagedRoot.root, folderId: 'other-root', folderName: 'Other' },
      rootFile: { ...stagedRoot.rootFile, id: 'other-root', name: 'Other' },
      finalFolder: {
        ...stagedRoot.finalFolder,
        id: 'other-final',
        parents: ['other-root'],
      },
    };
    const activateRoot = vi.fn(async () => configuredSnapshot(otherRoot));
    const { result } = renderHook(() =>
      useDriveFolderController(options({ drive: drive('unconfigured', activateRoot) }))
    );

    await act(async () => {
      await expect(result.current.confirmRoot(stagedRoot)).rejects.toThrow(
        'Drive activated a different invoice folder than the selected folder'
      );
    });
  });

  it('rejects a committed activation after authorization changes', async () => {
    const activation = deferred<DriveStoreSnapshot>();
    const activateRoot = vi.fn(() => activation.promise);
    const view = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveFolderController(
          options({
            authorizationIncarnation,
            drive: drive('unconfigured', activateRoot),
          })
        ),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    const confirmation = view.result.current.confirmRoot(stagedRoot);

    act(() => {
      view.rerender({ authorizationIncarnation: 2 });
    });
    await act(async () => {
      activation.resolve(configuredSnapshot());
      await expect(confirmation).rejects.toThrow(
        'Drive authorization changed before the Drive folder confirmation completed'
      );
    });
  });

  it('rejects a committed activation after the dialog session changes', async () => {
    const activation = deferred<DriveStoreSnapshot>();
    const activateRoot = vi.fn(() => activation.promise);
    const { result } = renderHook(() =>
      useDriveFolderController(options({ drive: drive('unconfigured', activateRoot) }))
    );
    const confirmation = result.current.confirmRoot(stagedRoot);

    await act(async () => {
      result.current.closeDialog();
      activation.resolve(configuredSnapshot());
      await expect(confirmation).rejects.toThrow(
        'Drive folder dialog session changed before the Drive folder confirmation completed'
      );
    });
  });

  it('moves an existing config without rewriting configuration', async () => {
    const activateRoot = vi.fn(async () => configuredSnapshot());
    const { result } = renderHook(() =>
      useDriveFolderController(options({ drive: drive('ready', activateRoot) }))
    );

    await act(() => result.current.confirmRoot(stagedRoot));

    expect(activateRoot).toHaveBeenCalledWith(stagedRoot, undefined);
  });

  it('scans with the current source snapshot', async () => {
    const scanCandidate = vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    }));
    const sources = [
      {
        key: { studioSlug: 'studio-a', monthKey: '2026-08' },
        studioName: 'Studio A',
        fingerprint: { sourceSha256: 'source', calendarSha256: 'calendar' },
      },
    ] as never;
    const { result } = renderHook(() =>
      useDriveFolderController(options({ sources, scanCandidate }))
    );

    await result.current.scanCandidate(stagedRoot);

    expect(scanCandidate).toHaveBeenCalledWith(stagedRoot, sources);
  });
});
