import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type {
  CurrentInvoiceSource,
  DriveInvoiceEntry,
} from '../../src/lib/drive/invoiceCatalog.js';
import {
  DriveStoreError,
  type DriveStoreSnapshot,
  type FinalizationInput,
} from '../../src/lib/drive/invoiceStore.js';
import type { DriveFileRecord } from '../../src/lib/drive/types.js';
import type { AppConfig, Invoice } from '../../src/lib/types.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, cleanup, render, renderHook, waitFor } = await import('@testing-library/react');
const { useDriveInvoices } = await import('../../src/hooks/useDriveInvoices.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function file(id: string, name = `${id}.pdf`): DriveFileRecord {
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: ['final-folder'],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: '3',
    md5Checksum: null,
    sha256Checksum: 'pdf-sha',
    properties: {},
    capabilities: {
      canListChildren: false,
      canAddChildren: false,
      canEdit: true,
      canDownload: true,
    },
    etag: `"${id}-v1"`,
  };
}

function entryFor(id: string, state: DriveInvoiceEntry['state'] = 'fresh'): DriveInvoiceEntry {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    file: file(id),
    filename: `${id}.pdf`,
    invoiceNumber: '9/2026',
    state,
    sourceSha256: 'source-sha',
    pdfSha256: 'pdf-sha',
    message: null,
  };
}

function snapshotFor(account: string, entries: DriveInvoiceEntry[] = []): DriveStoreSnapshot {
  const rootFile = {
    ...file(`${account}-root`, 'Lotus Invoices'),
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    size: null,
    sha256Checksum: null,
    capabilities: {
      canListChildren: true,
      canAddChildren: true,
      canEdit: true,
      canDownload: false,
    },
  };
  const finalFolder = {
    ...rootFile,
    id: `${account}-final`,
    name: 'Final',
    parents: [rootFile.id],
  };
  return {
    control: {
      file: { ...file(`${account}-control`, '.lotus-teaching-invoices.json') },
      control: {
        schemaVersion: 1,
        generation: 1,
        root: { folderId: rootFile.id, driveId: null, folderName: rootFile.name },
        finalFolderId: finalFolder.id,
        sequenceByYear: { '2026': 9 },
        reservation: null,
      },
    },
    stagedRoot: {
      root: { folderId: rootFile.id, driveId: null, folderName: rootFile.name },
      rootFile,
      finalFolder,
    },
    scan: {
      entries,
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: { '2026': 9 },
    },
  };
}

function reservedSnapshotFor(account: string): DriveStoreSnapshot {
  const snapshot = snapshotFor(account);
  snapshot.control.control.reservation = {
    operationId: 'operation-reserved',
    year: 2026,
    invoiceNumber: '10/2026',
    studioSlug: 'studio-a',
    month: '2026-08',
    fileId: 'reserved-file',
    sourceSha256: 'source-a',
    startedAt: '2026-08-24T12:00:00.000Z',
  };
  return snapshot;
}

function config(rate = 50): AppConfig {
  return {
    teacher: {
      name: 'Teacher',
      address: 'Street',
      taxNumber: 'Tax',
      bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
    },
    calendarId: 'calendar-id',
    outputDir: '/unused',
    lastInvoice: '8/2026',
    studios: {
      'Studio A': {
        fullName: 'Studio A',
        address: 'Studio Street',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate }],
      },
    },
  };
}

function invoice(): Invoice {
  return {
    studioName: 'Studio A',
    invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    generatedAt: '2026-08-24T12:00:00.000Z',
    issueDate: '2026-08-24',
    classes: [],
    totalClasses: 0,
    totalAmount: 0,
  };
}

function source(sourceSha256 = 'source-a'): CurrentInvoiceSource {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    studioName: 'Studio A',
    invoice: invoice(),
    classes: [],
    config: config(),
    fingerprint: { sourceSha256, calendarSha256: 'calendar-a' },
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

function stagedRoot(): StagedDriveRoot {
  return snapshotFor('staged').stagedRoot;
}

function storeDouble() {
  return {
    bootstrap: vi.fn<
      (sources: readonly CurrentInvoiceSource[]) => Promise<DriveStoreSnapshot | null>
    >(async () => snapshotFor('account-a')),
    refresh: vi.fn<(sources: readonly CurrentInvoiceSource[]) => Promise<DriveStoreSnapshot>>(
      async () => snapshotFor('account-a')
    ),
    activateRoot: vi.fn<
      (
        staged: StagedDriveRoot,
        sources: readonly CurrentInvoiceSource[],
        legacyLastInvoice: string | undefined
      ) => Promise<DriveStoreSnapshot>
    >(async () => snapshotFor('activated')),
    finalize: vi.fn<(input: FinalizationInput) => Promise<DriveInvoiceEntry>>(async () =>
      entryFor('finalized')
    ),
    refinalize: vi.fn<
      (input: FinalizationInput, entry: DriveInvoiceEntry) => Promise<DriveInvoiceEntry>
    >(async () => entryFor('refinalized')),
    recoverReservation: vi.fn<
      (sources: readonly CurrentInvoiceSource[]) => Promise<DriveStoreSnapshot>
    >(async () => snapshotFor('recovered')),
    downloadVerified: vi.fn<(entry: DriveInvoiceEntry) => Promise<Uint8Array>>(async () =>
      Uint8Array.from([1, 2, 3])
    ),
  };
}

type StoreDouble = ReturnType<typeof storeDouble>;

function options(
  overrides: Partial<{
    store: StoreDouble;
    sources: readonly CurrentInvoiceSource[];
    sourceContextKey: string;
    authorizationIncarnation: number;
    discoveryEnabled: boolean;
    foregroundRefreshEnabled: boolean;
  }> = {}
) {
  return {
    store: overrides.store ?? storeDouble(),
    sources: overrides.sources ?? [source()],
    sourceContextKey: overrides.sourceContextKey ?? 'calendar-input-a',
    authorizationIncarnation: overrides.authorizationIncarnation ?? 1,
    discoveryEnabled: overrides.discoveryEnabled ?? true,
    foregroundRefreshEnabled: overrides.foregroundRefreshEnabled ?? true,
  };
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

describe('useDriveInvoices', () => {
  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    restoreDom();
  });

  it('reports loading until the initial bootstrap publishes a ready snapshot', async () => {
    const pending = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useDriveInvoices(options({ store })));

    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot).toBeNull();
    await act(async () => {
      pending.resolve(snapshotFor('account-a'));
      await pending.promise;
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');
    expect(result.current.error).toBeNull();
    expect(store.bootstrap).toHaveBeenCalledWith([]);
  });

  it('publishes bootstrap completion after React Strict Mode replays its effects', async () => {
    const pending = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap.mockReturnValue(pending.promise);
    store.refresh.mockResolvedValue(snapshotFor('strict'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })), {
      reactStrictMode: true,
    });

    await act(async () => {
      pending.resolve(snapshotFor('strict'));
      await pending.promise;
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('strict-root');
  });

  it('maps an empty bootstrap to unconfigured without manufacturing an error', async () => {
    const store = storeDouble();
    store.bootstrap.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));

    await waitFor(() => expect(result.current.status).toBe('unconfigured'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('publishes a durable reservation as recovery-required immediately after cold bootstrap', async () => {
    const store = storeDouble();
    store.bootstrap.mockResolvedValueOnce(reservedSnapshotFor('cold-start'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));

    await waitFor(() => expect(result.current.status).toBe('blocked'));

    expect(result.current.error).toMatchObject({
      code: 'recoveryRequired',
      retryable: false,
    });
    expect(result.current.snapshot?.control.control.reservation).toMatchObject({
      operationId: 'operation-reserved',
      fileId: 'reserved-file',
    });
  });

  it('publishes a reservation discovered by refresh while retaining the snapshot', async () => {
    const store = storeDouble();
    store.refresh.mockResolvedValueOnce(reservedSnapshotFor('refreshed'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => result.current.refresh());

    expect(result.current.status).toBe('blocked');
    expect(result.current.error?.code).toBe('recoveryRequired');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('refreshed-root');
    expect(result.current.snapshot?.control.control.reservation?.fileId).toBe('reserved-file');
  });

  it('publishes the same durable reservation for a second independent controller', async () => {
    const firstStore = storeDouble();
    const secondStore = storeDouble();
    firstStore.bootstrap.mockResolvedValueOnce(reservedSnapshotFor('first-controller'));
    secondStore.bootstrap.mockResolvedValueOnce(reservedSnapshotFor('second-controller'));

    const first = renderHook(() => useDriveInvoices(options({ store: firstStore, sources: [] })));
    const second = renderHook(() => useDriveInvoices(options({ store: secondStore, sources: [] })));

    await waitFor(() => expect(first.result.current.error?.code).toBe('recoveryRequired'));
    await waitFor(() => expect(second.result.current.error?.code).toBe('recoveryRequired'));
    expect(first.result.current.snapshot?.control.control.reservation?.operationId).toBe(
      'operation-reserved'
    );
    expect(second.result.current.snapshot?.control.control.reservation?.operationId).toBe(
      'operation-reserved'
    );
    expect(firstStore.bootstrap).toHaveBeenCalledOnce();
    expect(secondStore.bootstrap).toHaveBeenCalledOnce();
  });

  it.each([
    ['authorizationRequired', 'authorizationRequired'],
    ['unconfigured', 'unconfigured'],
    ['offline', 'offline'],
    ['permission', 'blocked'],
    ['conflict', 'blocked'],
    ['corrupt', 'blocked'],
    ['duplicate', 'blocked'],
    ['recoveryRequired', 'blocked'],
    ['invalidState', 'blocked'],
  ] as const)('maps %s store errors to %s and preserves their details', async (code, status) => {
    const store = storeDouble();
    const error = new DriveStoreError(code, `${code} detail`, code === 'offline');
    store.bootstrap.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));

    await waitFor(() => expect(result.current.status).toBe(status));
    expect(result.current.error).toBe(error);
    expect(result.current.error?.retryable).toBe(code === 'offline');
  });

  it('keeps a retryable refresh error and clears it after a successful retry', async () => {
    const store = storeDouble();
    const offline = new DriveStoreError('offline', 'Try again', true);
    store.bootstrap.mockRejectedValueOnce(offline).mockResolvedValueOnce(snapshotFor('recovered'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));
    await waitFor(() => expect(result.current.status).toBe('offline'));

    await act(async () => result.current.refresh());

    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('recovered-root');
  });

  it('retains the current snapshot across a failed refresh and replaces it on success', async () => {
    const store = storeDouble();
    const offline = new DriveStoreError('offline', 'Temporarily unavailable', true);
    store.refresh.mockRejectedValueOnce(offline).mockResolvedValueOnce(snapshotFor('newer'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await expect(result.current.refresh()).rejects.toBe(offline);
    });
    expect(result.current.status).toBe('offline');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');

    await act(async () => result.current.refresh());
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('newer-root');
  });

  it('reports loading while retrying with an existing snapshot', async () => {
    const retry = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.refresh.mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [] })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let retryPromise!: Promise<void>;
    act(() => {
      retryPromise = result.current.refresh();
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');
    await act(async () => {
      retry.resolve(snapshotFor('retried'));
      await retryPromise;
    });
    expect(result.current.status).toBe('ready');
  });

  it('discards a stale bootstrap synchronously after the Google account incarnation changes', async () => {
    const first = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(snapshotFor('account-b'));
    store.refresh.mockResolvedValue(snapshotFor('account-b'));
    const { result, rerender } = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(options({ authorizationIncarnation, store, sources: [] })),
      { initialProps: { authorizationIncarnation: 1 } }
    );

    rerender({ authorizationIncarnation: 2 });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();
    first.resolve(snapshotFor('account-a'));
    await act(async () => first.promise);

    await waitFor(() =>
      expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-b-root')
    );
  });

  it('does not let an older source request overwrite a newer request generation', async () => {
    const older = deferred<DriveStoreSnapshot>();
    const newer = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    store.refresh.mockResolvedValue(snapshotFor('newer'));
    const { result, rerender } = renderHook(
      ({ sources }) => useDriveInvoices(options({ sources, store })),
      { initialProps: { sources: [source('older')] } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));

    rerender({ sources: [source('newer')] });
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(2));
    await act(async () => {
      newer.resolve(snapshotFor('newer'));
      await newer.promise;
    });
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('newer-root');

    await act(async () => {
      older.resolve(snapshotFor('older'));
      await older.promise;
    });
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('newer-root');
  });

  it('synchronously hides the old snapshot until the changed source refresh publishes', async () => {
    const changedRefresh = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.refresh
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockReturnValueOnce(changedRefresh.promise);
    const { result, rerender } = renderHook(
      ({ sources }) => useDriveInvoices(options({ sources, store })),
      { initialProps: { sources: [source('original')] } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');

    rerender({ sources: [source('changed')] });

    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));

    await act(async () => {
      changedRefresh.resolve(snapshotFor('changed-source'));
      await changedRefresh.promise;
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('changed-source-root');
  });

  it('masks an empty-source snapshot as soon as a new source build context is pending', async () => {
    const matchingRefresh = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.refresh.mockReturnValueOnce(matchingRefresh.promise);
    const { result, rerender } = renderHook(
      ({ sourceContextKey, sources, discoveryEnabled, foregroundRefreshEnabled }) =>
        useDriveInvoices(
          options({
            sourceContextKey,
            sources,
            discoveryEnabled,
            foregroundRefreshEnabled,
            store,
          })
        ),
      {
        initialProps: {
          sourceContextKey: 'empty-calendar-input',
          sources: [] as CurrentInvoiceSource[],
          discoveryEnabled: true,
          foregroundRefreshEnabled: true,
        },
      }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');

    rerender({
      sourceContextKey: 'calendar-input-with-new-class',
      sources: [],
      discoveryEnabled: false,
      foregroundRefreshEnabled: false,
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot).toBeNull();

    rerender({
      sourceContextKey: 'calendar-input-with-new-class',
      sources: [source('new-class')],
      discoveryEnabled: true,
      foregroundRefreshEnabled: true,
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());

    await act(async () => {
      matchingRefresh.resolve(snapshotFor('matching-new-class'));
      await matchingRefresh.promise;
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('matching-new-class-root');
  });

  it('deduplicates simultaneous explicit, foreground, and focus refresh triggers', async () => {
    const pending = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.refresh();
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(store.bootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(snapshotFor('account-a'));
      await pending.promise;
    });
  });

  it('bootstraps an authorized root while Invoices is inactive', async () => {
    const store = storeDouble();
    store.bootstrap.mockResolvedValueOnce(snapshotFor('background'));
    const { result } = renderHook(() =>
      useDriveInvoices({
        store,
        sources: [],
        sourceContextKey: 'setup-discovery',
        authorizationIncarnation: 4,
        discoveryEnabled: true,
        foregroundRefreshEnabled: false,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(store.bootstrap).toHaveBeenCalledOnce();
    expect(store.bootstrap).toHaveBeenCalledWith([]);
  });

  it('reconciles ready sources after discovery becomes enabled', async () => {
    const store = storeDouble();
    store.bootstrap.mockResolvedValueOnce(snapshotFor('discovered'));
    store.refresh.mockResolvedValueOnce(snapshotFor('reconciled'));
    const view = renderHook(
      ({ discoveryEnabled }) =>
        useDriveInvoices(
          options({
            store,
            sources: [source('ready-source')],
            discoveryEnabled,
            foregroundRefreshEnabled: false,
          })
        ),
      { initialProps: { discoveryEnabled: false } }
    );
    expect(store.bootstrap).not.toHaveBeenCalled();

    view.rerender({ discoveryEnabled: true });

    await waitFor(() =>
      expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe('reconciled-root')
    );
    expect(store.bootstrap).toHaveBeenCalledWith([]);
    expect(store.refresh).toHaveBeenCalledOnce();
    expect(store.refresh.mock.calls[0][0][0].fingerprint.sourceSha256).toBe('ready-source');
  });

  it('repairs current store sources after a stale bootstrap completes last', async () => {
    const olderBootstrap = deferred<DriveStoreSnapshot>();
    const newerBootstrap = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    let storedSourceHash = 'unset';
    store.bootstrap
      .mockReturnValueOnce(
        olderBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      )
      .mockReturnValueOnce(
        newerBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      );
    store.refresh.mockImplementation(async (sources) => {
      storedSourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
      return snapshotFor(`reconciled-${storedSourceHash}`);
    });
    const view = renderHook(
      ({ sources }) =>
        useDriveInvoices(
          options({ store, sources, discoveryEnabled: true, foregroundRefreshEnabled: false })
        ),
      { initialProps: { sources: [source('older-source')] } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledOnce());

    view.rerender({ sources: [source('newer-source')] });
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(2));
    await act(async () => {
      newerBootstrap.resolve(snapshotFor('discovered-newer'));
      await newerBootstrap.promise;
    });

    await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());
    expect(store.refresh.mock.calls[0][0][0].fingerprint.sourceSha256).toBe('newer-source');
    expect(storedSourceHash).toBe('newer-source');
    expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe(
      'reconciled-newer-source-root'
    );

    await act(async () => {
      olderBootstrap.resolve(snapshotFor('discovered-older'));
      await olderBootstrap.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));
    expect(store.refresh.mock.calls[1][0][0].fingerprint.sourceSha256).toBe('newer-source');
    expect(storedSourceHash).toBe('newer-source');
    expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe(
      'reconciled-newer-source-root'
    );
  });

  it('repairs current store sources after a stale null bootstrap completes last', async () => {
    const olderBootstrap = deferred<DriveStoreSnapshot | null>();
    const newerBootstrap = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    let storedSourceHash = 'unset';
    store.bootstrap
      .mockReturnValueOnce(
        olderBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      )
      .mockReturnValueOnce(
        newerBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      );
    store.refresh.mockImplementation(async (sources) => {
      storedSourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
      return snapshotFor(`reconciled-${storedSourceHash}`);
    });
    const view = renderHook(
      ({ sources }) =>
        useDriveInvoices(
          options({ store, sources, discoveryEnabled: true, foregroundRefreshEnabled: false })
        ),
      { initialProps: { sources: [source('older-source')] } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledOnce());

    view.rerender({ sources: [source('newer-source')] });
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(2));
    await act(async () => {
      newerBootstrap.resolve(snapshotFor('discovered-newer'));
      await newerBootstrap.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());
    expect(storedSourceHash).toBe('newer-source');

    await act(async () => {
      olderBootstrap.resolve(null);
      await olderBootstrap.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));
    expect(store.refresh.mock.calls[1][0][0].fingerprint.sourceSha256).toBe('newer-source');
    expect(storedSourceHash).toBe('newer-source');
    expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe(
      'reconciled-newer-source-root'
    );
  });

  it('repairs again when a store repair completes with stale sources', async () => {
    const olderBootstrap = deferred<DriveStoreSnapshot>();
    const newerBootstrap = deferred<DriveStoreSnapshot>();
    const obsoleteRepair = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    let storedSourceHash = 'unset';
    store.bootstrap
      .mockReturnValueOnce(
        olderBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      )
      .mockReturnValueOnce(
        newerBootstrap.promise.then((snapshot) => {
          storedSourceHash = 'empty';
          return snapshot;
        })
      );
    store.refresh
      .mockImplementationOnce(async (sources) => {
        storedSourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
        return snapshotFor('reconciled-newer');
      })
      .mockImplementationOnce((sources) => {
        const sourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
        return obsoleteRepair.promise.then((snapshot) => {
          storedSourceHash = sourceHash;
          return snapshot;
        });
      })
      .mockImplementationOnce(async (sources) => {
        storedSourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
        return snapshotFor('current-newest');
      })
      .mockImplementationOnce(async (sources) => {
        storedSourceHash = sources[0]?.fingerprint.sourceSha256 ?? 'empty';
        return snapshotFor('repaired-newest');
      });
    const view = renderHook(
      ({ sources }) =>
        useDriveInvoices(
          options({ store, sources, discoveryEnabled: true, foregroundRefreshEnabled: false })
        ),
      { initialProps: { sources: [source('older-source')] } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledOnce());

    view.rerender({ sources: [source('newer-source')] });
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(2));
    await act(async () => {
      newerBootstrap.resolve(snapshotFor('discovered-newer'));
      await newerBootstrap.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());

    await act(async () => {
      olderBootstrap.resolve(snapshotFor('discovered-older'));
      await olderBootstrap.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));

    view.rerender({ sources: [source('newest-source')] });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe('current-newest-root')
    );
    expect(storedSourceHash).toBe('newest-source');

    await act(async () => {
      obsoleteRepair.resolve(snapshotFor('obsolete-repair'));
      await obsoleteRepair.promise;
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(4));
    expect(store.refresh.mock.calls[3][0][0].fingerprint.sourceSha256).toBe('newest-source');
    expect(storedSourceHash).toBe('newest-source');
    expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe('repaired-newest-root');
  });

  it('refreshes on focus only while foreground refresh is enabled', async () => {
    const store = storeDouble();
    store.bootstrap.mockResolvedValueOnce(snapshotFor('background'));
    store.refresh.mockResolvedValue(snapshotFor('focused'));
    const view = renderHook(
      ({ foregroundRefreshEnabled }) =>
        useDriveInvoices({
          store,
          sources: [],
          sourceContextKey: 'setup-discovery',
          authorizationIncarnation: 4,
          discoveryEnabled: true,
          foregroundRefreshEnabled,
        }),
      { initialProps: { foregroundRefreshEnabled: false } }
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    act(() => window.dispatchEvent(new Event('focus')));
    expect(store.refresh).not.toHaveBeenCalled();
    view.rerender({ foregroundRefreshEnabled: true });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());
  });

  it('starts discovery when enabled and refreshes on visible foreground resume and focus', async () => {
    const store = storeDouble();
    const { rerender } = renderHook(
      ({ discoveryEnabled, foregroundRefreshEnabled }) =>
        useDriveInvoices(
          options({ discoveryEnabled, foregroundRefreshEnabled, store, sources: [] })
        ),
      { initialProps: { discoveryEnabled: false, foregroundRefreshEnabled: false } }
    );
    expect(store.bootstrap).not.toHaveBeenCalled();

    rerender({ discoveryEnabled: true, foregroundRefreshEnabled: true });
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));
  });

  it('starts discovery while reload visibility is transiently hidden', async () => {
    setVisibility('hidden');
    const store = storeDouble();
    const { rerender } = renderHook(
      ({ discoveryEnabled }) =>
        useDriveInvoices(
          options({ discoveryEnabled, foregroundRefreshEnabled: false, store, sources: [] })
        ),
      { initialProps: { discoveryEnabled: false } }
    );

    rerender({ discoveryEnabled: true });

    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));
  });

  it('does not refresh for hidden or disabled foreground lifecycle events', async () => {
    const store = storeDouble();
    const { rerender } = renderHook(
      ({ foregroundRefreshEnabled }) =>
        useDriveInvoices(options({ foregroundRefreshEnabled, store, sources: [] })),
      { initialProps: { foregroundRefreshEnabled: true } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    rerender({ foregroundRefreshEnabled: false });
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it('ignores recreated equivalent sources but refreshes when their semantic fingerprint changes', async () => {
    const store = storeDouble();
    const { rerender } = renderHook(
      ({ sources }) => useDriveInvoices(options({ sources, store })),
      { initialProps: { sources: [source('same')] } }
    );
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));

    rerender({ sources: [source('same')] });
    await act(async () => Promise.resolve());
    expect(store.refresh).toHaveBeenCalledOnce();

    rerender({ sources: [source('changed')] });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));
    expect(store.refresh.mock.calls[1][0][0].fingerprint.sourceSha256).toBe('changed');
  });

  it('refreshes before and after each successful mutation and publishes the post-success snapshot', async () => {
    const store = storeDouble();
    const callOrder: string[] = [];
    store.refresh.mockImplementation(async () => {
      callOrder.push('refresh');
      return snapshotFor(callOrder.length === 4 ? 'post-finalize' : 'refreshed');
    });
    store.finalize.mockImplementation(async () => {
      callOrder.push('finalize');
      return entryFor('finalized');
    });
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let returned!: DriveInvoiceEntry;
    await act(async () => {
      returned = await result.current.finalize(finalizationInput());
    });

    expect(returned.file.id).toBe('finalized');
    expect(callOrder).toEqual(['refresh', 'refresh', 'finalize', 'refresh']);
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('post-finalize-root');
    expect(result.current.operationKey).toBeNull();
  });

  it('uses deterministic operation keys for activation, finalization, and re-finalization rows', async () => {
    const store = storeDouble();
    const activation = deferred<DriveStoreSnapshot>();
    const finalization = deferred<DriveInvoiceEntry>();
    const replacement = deferred<DriveInvoiceEntry>();
    store.activateRoot.mockReturnValueOnce(activation.promise);
    store.finalize.mockReturnValueOnce(finalization.promise);
    store.refinalize.mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let activatePromise!: Promise<void>;
    act(() => {
      activatePromise = result.current.activateRoot(stagedRoot(), '8/2026');
    });
    await waitFor(() =>
      expect(result.current.operationKey).toBe('activateRoot:my-drive:staged-root')
    );
    await act(async () => {
      activation.resolve(snapshotFor('activated'));
      await activatePromise;
    });

    let finalizePromise!: Promise<DriveInvoiceEntry>;
    act(() => {
      finalizePromise = result.current.finalize(finalizationInput());
    });
    await waitFor(() => expect(result.current.operationKey).toBe('finalize:studio-a:2026-08'));
    await act(async () => {
      finalization.resolve(entryFor('new'));
      await finalizePromise;
    });

    let refinalizePromise!: Promise<DriveInvoiceEntry>;
    act(() => {
      refinalizePromise = result.current.refinalize(
        finalizationInput(),
        entryFor('existing', 'stale')
      );
    });
    await waitFor(() => expect(result.current.operationKey).toBe('refinalize:existing'));
    await act(async () => {
      replacement.resolve(entryFor('existing'));
      await refinalizePromise;
    });
    expect(result.current.operationKey).toBeNull();
  });

  it('serializes mutations and recovers the queue after a rejection', async () => {
    const first = deferred<DriveInvoiceEntry>();
    const store = storeDouble();
    store.finalize.mockReturnValueOnce(first.promise).mockResolvedValueOnce(entryFor('second'));
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let firstPromise!: Promise<DriveInvoiceEntry>;
    let secondPromise!: Promise<DriveInvoiceEntry>;
    act(() => {
      firstPromise = result.current.finalize(finalizationInput());
      secondPromise = result.current.finalize(finalizationInput());
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.reject(new DriveStoreError('conflict', 'Concurrent write', true));
      await expect(firstPromise).rejects.toMatchObject({ code: 'conflict', retryable: true });
    });
    await act(async () => {
      await expect(secondPromise).resolves.toMatchObject({ file: { id: 'second' } });
    });
    expect(store.finalize).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
  });

  it('recovers a durable reservation through the serialized mutation lifecycle', async () => {
    const store = storeDouble();
    const recoveryError = new DriveStoreError(
      'recoveryRequired',
      'Recover the durable reservation',
      false
    );
    store.finalize.mockRejectedValueOnce(recoveryError);
    store.refresh
      .mockResolvedValueOnce(snapshotFor('initial-reconciliation'))
      .mockResolvedValueOnce(snapshotFor('before-failed-finalize'))
      .mockResolvedValueOnce(snapshotFor('before-recovery'))
      .mockResolvedValueOnce(snapshotFor('after-recovery'));
    const { result } = renderHook(() => useDriveInvoices(options({ store, sources: [source()] })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await expect(result.current.finalize(finalizationInput())).rejects.toBe(recoveryError);
    });
    expect(result.current.error).toBe(recoveryError);

    await act(async () => result.current.recoverReservation());

    expect(store.recoverReservation).toHaveBeenCalledOnce();
    expect(store.recoverReservation.mock.calls[0][0][0].fingerprint.sourceSha256).toBe('source-a');
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('after-recovery-root');
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.operationKey).toBeNull();
  });

  it('does not start queued reservation recovery after its source context becomes stale', async () => {
    const pending = deferred<DriveInvoiceEntry>();
    const store = storeDouble();
    store.finalize.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ sources }) => useDriveInvoices(options({ sources, store })),
      { initialProps: { sources: [source('original')] } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let running!: Promise<DriveInvoiceEntry>;
    let queuedRecovery!: Promise<void>;
    act(() => {
      running = result.current.finalize(finalizationInput());
      queuedRecovery = result.current.recoverReservation();
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledOnce());
    rerender({ sources: [source('changed')] });

    await act(async () => {
      pending.resolve(entryFor('old-source'));
      await expect(running).rejects.toMatchObject({ code: 'invalidState' });
      await expect(queuedRecovery).rejects.toMatchObject({ code: 'invalidState' });
    });
    expect(store.recoverReservation).not.toHaveBeenCalled();
  });

  it('keeps a mutation error visible when a concurrent focus refresh finishes later', async () => {
    const action = deferred<DriveInvoiceEntry>();
    const foregroundRefresh = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.finalize.mockReturnValueOnce(action.promise);
    store.refresh
      .mockResolvedValueOnce(snapshotFor('initial-reconciliation'))
      .mockResolvedValueOnce(snapshotFor('before-action'))
      .mockReturnValueOnce(foregroundRefresh.promise);
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let actionPromise!: Promise<DriveInvoiceEntry>;
    act(() => {
      actionPromise = result.current.finalize(finalizationInput());
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(3));

    const conflict = new DriveStoreError('conflict', 'Mutation lost a race', true);
    await act(async () => {
      action.reject(conflict);
      await expect(actionPromise).rejects.toBe(conflict);
    });
    expect(result.current.status).toBe('blocked');
    expect(result.current.error).toBe(conflict);

    await act(async () => {
      foregroundRefresh.resolve(snapshotFor('foreground'));
      await foregroundRefresh.promise;
    });
    expect(result.current.status).toBe('blocked');
    expect(result.current.error).toBe(conflict);
  });

  it('publishes a successful post-mutation snapshot while preserving a later download error', async () => {
    const postMutationRefresh = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.refresh
      .mockResolvedValueOnce(snapshotFor('initial-reconciliation'))
      .mockResolvedValueOnce(snapshotFor('before-finalize'))
      .mockReturnValueOnce(postMutationRefresh.promise);
    const downloadError = new DriveStoreError('permission', 'Download was denied', false);
    store.downloadVerified.mockRejectedValueOnce(downloadError);
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let finalizePromise!: Promise<DriveInvoiceEntry>;
    act(() => {
      finalizePromise = result.current.finalize(finalizationInput());
    });
    await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(3));

    await act(async () => {
      await expect(result.current.downloadVerified(entryFor('download'))).rejects.toBe(
        downloadError
      );
    });
    expect(result.current.status).toBe('blocked');
    expect(result.current.error).toBe(downloadError);

    await act(async () => {
      postMutationRefresh.resolve(snapshotFor('after-finalize'));
      await postMutationRefresh.promise;
      await finalizePromise;
    });
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('after-finalize-root');
    expect(result.current.status).toBe('blocked');
    expect(result.current.error).toBe(downloadError);
  });

  it('does not start a queued mutation from an obsolete account incarnation', async () => {
    const first = deferred<DriveInvoiceEntry>();
    const store = storeDouble();
    store.finalize.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(options({ authorizationIncarnation, store })),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let running!: Promise<DriveInvoiceEntry>;
    let queued!: Promise<DriveInvoiceEntry>;
    act(() => {
      running = result.current.finalize(finalizationInput());
      queued = result.current.refinalize(finalizationInput(), entryFor('old', 'stale'));
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledTimes(1));
    rerender({ authorizationIncarnation: 2 });
    await act(async () => {
      first.resolve(entryFor('old-account'));
      await expect(running).rejects.toMatchObject({ code: 'authorizationRequired' });
      await expect(queued).rejects.toMatchObject({ code: 'authorizationRequired' });
    });
    expect(store.refinalize).not.toHaveBeenCalled();
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root');
  });

  it('does not start a queued mutation after its source context changes and changes back', async () => {
    const first = deferred<DriveInvoiceEntry>();
    const store = storeDouble();
    store.finalize.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(
      ({ sources }) => useDriveInvoices(options({ sources, store })),
      { initialProps: { sources: [source('original')] } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let running!: Promise<DriveInvoiceEntry>;
    let queued!: Promise<DriveInvoiceEntry>;
    act(() => {
      running = result.current.finalize(finalizationInput());
      queued = result.current.refinalize(finalizationInput(), entryFor('queued', 'stale'));
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledTimes(1));
    rerender({ sources: [source('changed')] });
    rerender({ sources: [source('original')] });

    await act(async () => {
      first.resolve(entryFor('old-source'));
      await expect(running).rejects.toMatchObject({ code: 'invalidState' });
      await expect(queued).rejects.toMatchObject({ code: 'invalidState' });
    });
    expect(store.refinalize).not.toHaveBeenCalled();
  });

  it('keeps operations on committed options when a source-changing render suspends', async () => {
    const store = storeDouble();
    const never = new Promise<never>(() => undefined);
    let committedState: ReturnType<typeof useDriveInvoices> | null = null;

    function Harness({ sourceHash, suspend }: { sourceHash: string; suspend: boolean }) {
      const state = useDriveInvoices(options({ store, sources: [source(sourceHash)] }));
      if (suspend) throw never;
      committedState = state;
      return null;
    }

    const view = render(
      <React.Suspense fallback={<div>Suspended</div>}>
        <Harness sourceHash="committed" suspend={false} />
      </React.Suspense>
    );
    await waitFor(() => expect(committedState?.status).toBe('ready'));

    view.rerender(
      <React.Suspense fallback={<div>Suspended</div>}>
        <Harness sourceHash="speculative" suspend />
      </React.Suspense>
    );

    await act(async () => {
      await committedState!.finalize(finalizationInput());
    });
    expect(
      store.refresh.mock.calls.map(([sources]) => sources[0].fingerprint.sourceSha256)
    ).toEqual(['committed', 'committed', 'committed']);
  });

  it('does not let a running old-account action overwrite the new-account refresh', async () => {
    const oldAction = deferred<DriveInvoiceEntry>();
    const store = storeDouble();
    store.bootstrap
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockResolvedValueOnce(snapshotFor('account-b'));
    store.refresh
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockResolvedValueOnce(snapshotFor('account-b'));
    store.finalize.mockReturnValueOnce(oldAction.promise);
    const { result, rerender } = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(options({ authorizationIncarnation, store })),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    await waitFor(() =>
      expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root')
    );

    let action!: Promise<DriveInvoiceEntry>;
    act(() => {
      action = result.current.finalize(finalizationInput());
    });
    await waitFor(() => expect(store.finalize).toHaveBeenCalledTimes(1));
    rerender({ authorizationIncarnation: 2 });
    await waitFor(() =>
      expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-b-root')
    );
    await act(async () => {
      oldAction.resolve(entryFor('account-a-result'));
      await expect(action).rejects.toMatchObject({ code: 'authorizationRequired' });
    });

    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-b-root');
    expect(result.current.error).toBeNull();
  });

  it('does not publish an old-account activation snapshot while the new account loads', async () => {
    const oldActivation = deferred<DriveStoreSnapshot>();
    const newBootstrap = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockReturnValueOnce(newBootstrap.promise);
    store.refresh
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockResolvedValueOnce(snapshotFor('account-a'))
      .mockResolvedValueOnce(snapshotFor('account-b'));
    store.activateRoot.mockReturnValueOnce(oldActivation.promise);
    const { result, rerender } = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(options({ authorizationIncarnation, store })),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    await waitFor(() =>
      expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-a-root')
    );

    let action!: Promise<void>;
    act(() => {
      action = result.current.activateRoot(stagedRoot());
    });
    await waitFor(() => expect(store.activateRoot).toHaveBeenCalledTimes(1));
    rerender({ authorizationIncarnation: 2 });
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      oldActivation.resolve(snapshotFor('account-a-activated'));
      await expect(action).rejects.toMatchObject({ code: 'authorizationRequired' });
    });
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      newBootstrap.resolve(snapshotFor('account-b'));
      await newBootstrap.promise;
    });
    expect(result.current.snapshot?.stagedRoot.root.folderId).toBe('account-b-root');
  });

  it('does not return verified PDF bytes after the account incarnation changes', async () => {
    const oldDownload = deferred<Uint8Array>();
    const store = storeDouble();
    store.downloadVerified.mockReturnValueOnce(oldDownload.promise);
    const { result, rerender } = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(options({ authorizationIncarnation, store })),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let download!: Promise<Uint8Array>;
    act(() => {
      download = result.current.downloadVerified(entryFor('account-a'));
    });
    rerender({ authorizationIncarnation: 2 });
    await act(async () => {
      oldDownload.resolve(Uint8Array.from([1, 2, 3]));
      await expect(download).rejects.toMatchObject({ code: 'authorizationRequired' });
    });
  });

  it('clears an operation key only when the matching concurrent download completes', async () => {
    const first = deferred<Uint8Array>();
    const second = deferred<Uint8Array>();
    const store = storeDouble();
    store.downloadVerified.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let firstPromise!: Promise<Uint8Array>;
    let secondPromise!: Promise<Uint8Array>;
    act(() => {
      firstPromise = result.current.downloadVerified(entryFor('first'));
      secondPromise = result.current.downloadVerified(entryFor('second'));
    });
    expect(result.current.operationKey).toBe('download:second');

    await act(async () => {
      first.resolve(Uint8Array.from([1]));
      await firstPromise;
    });
    expect(result.current.operationKey).toBe('download:second');
    await act(async () => {
      second.resolve(Uint8Array.from([2]));
      await secondPromise;
    });
    expect(result.current.operationKey).toBeNull();
  });

  it('removes lifecycle listeners and ignores async completion after unmount', async () => {
    const pending = deferred<DriveStoreSnapshot>();
    const store = storeDouble();
    store.bootstrap.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useDriveInvoices(options({ store })));
    await waitFor(() => expect(store.bootstrap).toHaveBeenCalledTimes(1));

    unmount();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    pending.resolve(snapshotFor('late'));
    await pending.promise;

    expect(store.bootstrap).toHaveBeenCalledTimes(1);
    expect(store.refresh).not.toHaveBeenCalled();
  });
});
