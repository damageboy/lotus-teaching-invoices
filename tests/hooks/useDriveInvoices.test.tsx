import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/config/defaults.js';
import type {
  CurrentInvoiceSource,
  DriveInvoiceEntry,
} from '../../src/lib/drive/invoiceCatalog.js';
import {
  DriveStoreError,
  type DriveConfigCandidate,
  type DriveStoreSnapshot,
  type FinalizationInput,
} from '../../src/lib/drive/invoiceStore.js';
import type { DriveConfigSnapshot } from '../../src/lib/drive/configFile.js';
import type { DriveConfigPointerRead } from '../../src/lib/drive/configPointer.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, renderHook, waitFor } = await import('@testing-library/react');
const { useDriveInvoices } = await import('../../src/hooks/useDriveInvoices.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(rootId = 'invoice-root'): DriveStoreSnapshot {
  return {
    config: {
      file: {
        id: 'config-file',
        name: 'lotus-invoices-config.yaml',
        mimeType: 'application/yaml',
        parents: [rootId],
        driveId: null,
        ownedByMe: true,
        trashed: false,
        version: '1',
        size: '1',
        md5Checksum: null,
        sha256Checksum: null,
        properties: { lotusConfigSchema: '1' },
        capabilities: {
          canListChildren: false,
          canAddChildren: false,
          canEdit: true,
          canDownload: true,
        },
        etag: '"config-v1"',
      },
      config: DEFAULT_CONFIG,
    },
    stagedRoot: {
      root: { folderId: rootId, driveId: null, folderName: 'Invoices' },
      rootFile: {} as never,
      finalFolder: { id: 'final' } as never,
    },
    scan: { entries: [], warnings: [], blockingConflicts: [], maxSequenceByYear: {} },
  };
}

function entry(id = 'invoice-pdf'): DriveInvoiceEntry {
  return { file: { id } } as DriveInvoiceEntry;
}

function candidate(fileId = 'config-file', folderName = 'Invoices'): DriveConfigCandidate {
  return {
    fileId,
    kind: 'configured',
    root: { folderId: `root-${fileId}`, driveId: null, folderName },
    rootFile: { id: `root-${fileId}` } as never,
    calendarName: 'Teaching',
  };
}

function source(id: string): CurrentInvoiceSource {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    studioName: 'Studio A',
    fingerprint: { sourceSha256: id, calendarSha256: `calendar-${id}` },
  } as CurrentInvoiceSource;
}

function store(initial: DriveStoreSnapshot | null = snapshot()) {
  return {
    bootstrap: vi.fn(async () => initial),
    loadByFileId: vi.fn(async () => initial ?? snapshot()),
    loadConfigByFileId: vi.fn(async () => (initial ?? snapshot()).config),
    loadInvoicesForConfig: vi.fn(async () => initial ?? snapshot()),
    discoverRecovery: vi.fn(async () => ({ candidates: [], issues: [] })),
    inspectRecoveryFolder: vi.fn(async () => ({ candidates: [], issues: [] })),
    adoptRecoveryCandidate: vi.fn(async () => initial ?? snapshot()),
    refresh: vi.fn(async () => initial ?? snapshot()),
    rescanInvoices: vi.fn(async () => initial ?? snapshot()),
    activateRoot: vi.fn(async () => initial ?? snapshot()),
    saveConfig: vi.fn(async (_base, next) => ({
      ...(initial ?? snapshot()),
      config: { ...(initial ?? snapshot()).config, config: next },
    })),
    finalize: vi.fn(async () => ({ entry: entry(), snapshot: initial ?? snapshot() })),
    refinalize: vi.fn(async () => ({ entry: entry(), snapshot: initial ?? snapshot() })),
    downloadVerified: vi.fn(async () => new Uint8Array([1])),
  };
}

function options(currentStore: ReturnType<typeof store>, overrides: Record<string, unknown> = {}) {
  const pointer: DriveConfigPointerRead = {
    kind: 'valid',
    raw: '{"version":1,"configFileId":"config-file"}',
    fileId: 'config-file',
  };
  return {
    store: currentStore,
    sources: [] as CurrentInvoiceSource[],
    sourceContextKey: 'setup-discovery',
    authorizationIncarnation: 1,
    discoveryEnabled: true,
    foregroundRefreshEnabled: false,
    pointer,
    installPointer: vi.fn(async (fileId: string) => ({
      fileId,
      raw: `{"version":1,"configFileId":"${fileId}"}`,
    })),
    ...overrides,
  };
}

describe('useDriveInvoices', () => {
  afterAll(restoreDom);

  it('loads a valid pointer directly and performs no recovery discovery', async () => {
    const currentStore = store();
    const { result } = renderHook(() =>
      useDriveInvoices(options(currentStore, { legacyLocalYaml: 'teacher: {}\n' }))
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(currentStore.loadConfigByFileId).toHaveBeenCalledWith('config-file');
    expect(currentStore.loadInvoicesForConfig).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.objectContaining({ id: 'config-file' }) }),
      []
    );
    expect(currentStore.discoverRecovery).not.toHaveBeenCalled();
    expect(result.current.snapshot?.config.file.id).toBe('config-file');
  });

  it('publishes the pointed config while invoice discovery is still loading', async () => {
    const currentStore = store();
    const configLoad = deferred<DriveConfigSnapshot>();
    const invoiceLoad = deferred<DriveStoreSnapshot>();
    currentStore.loadConfigByFileId.mockImplementationOnce(() => configLoad.promise);
    currentStore.loadInvoicesForConfig.mockImplementationOnce(() => invoiceLoad.promise);
    currentStore.loadByFileId.mockImplementationOnce(() => invoiceLoad.promise);
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));

    await act(async () => configLoad.resolve(snapshot().config));
    await waitFor(() => expect(result.current.configSnapshot?.file.id).toBe('config-file'));

    expect(result.current.status).toBe('loading');
    expect(result.current.snapshot).toBeNull();

    await act(async () => invoiceLoad.resolve(snapshot()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('coalesces source changes into the pointed invoice discovery already in flight', async () => {
    const currentStore = store();
    const invoiceLoad = deferred<DriveStoreSnapshot>();
    currentStore.loadInvoicesForConfig.mockImplementationOnce(() => invoiceLoad.promise);
    const latestSources = [source('latest')];
    const view = renderHook(
      ({ sourceContextKey, sources }) =>
        useDriveInvoices(options(currentStore, { sourceContextKey, sources })),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          sources: [] as CurrentInvoiceSource[],
        },
      }
    );
    await waitFor(() => expect(view.result.current.configSnapshot).not.toBeNull());

    act(() => view.rerender({ sourceContextKey: 'current-invoices', sources: latestSources }));

    expect(currentStore.loadConfigByFileId).toHaveBeenCalledOnce();
    expect(currentStore.loadInvoicesForConfig).toHaveBeenCalledOnce();

    await act(async () => invoiceLoad.resolve(snapshot()));
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(currentStore.rescanInvoices).toHaveBeenCalledWith(latestSources);
  });

  it('publishes unconfigured recovery without a local authority', async () => {
    const currentStore = store(null);
    const pointer: DriveConfigPointerRead = { kind: 'absent', raw: null };
    const { result } = renderHook(() => useDriveInvoices(options(currentStore, { pointer })));

    await waitFor(() => expect(result.current.status).toBe('unconfigured'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.recovery).toEqual({
      candidates: [],
      issues: [],
      previousPointerRaw: null,
    });
    expect(currentStore.discoverRecovery).toHaveBeenCalledOnce();
    expect(currentStore.loadByFileId).not.toHaveBeenCalled();
  });

  it('requires confirmation for one discovered candidate and installs nothing automatically', async () => {
    const currentStore = store();
    currentStore.discoverRecovery.mockResolvedValueOnce({
      candidates: [candidate()],
      issues: [],
    });
    const installPointer = vi.fn();
    const pointer: DriveConfigPointerRead = { kind: 'absent', raw: null };
    const { result } = renderHook(() =>
      useDriveInvoices(options(currentStore, { pointer, installPointer }))
    );

    await waitFor(() => expect(result.current.status).toBe('confirmationRequired'));

    expect(result.current.recovery?.candidates).toHaveLength(1);
    expect(installPointer).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it('confirms one exact candidate before installing its ID and publishing ready', async () => {
    const currentStore = store();
    currentStore.discoverRecovery.mockResolvedValueOnce({
      candidates: [candidate('config-2')],
      issues: [],
    });
    const installPointer = vi.fn(async (fileId: string, expectedRaw: string | null) => ({
      fileId,
      raw: 'installed',
      expectedRaw,
    }));
    const pointer: DriveConfigPointerRead = { kind: 'absent', raw: null };
    const { result } = renderHook(() =>
      useDriveInvoices(options(currentStore, { pointer, installPointer }))
    );
    await waitFor(() => expect(result.current.status).toBe('confirmationRequired'));

    await act(() => result.current.confirmRecoveryCandidate('config-2'));

    expect(currentStore.adoptRecoveryCandidate).toHaveBeenCalledWith('config-2', [], undefined);
    expect(installPointer).toHaveBeenCalledWith('config-2', null);
    expect(currentStore.refresh).not.toHaveBeenCalled();
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.config.file.id).toBe('config-file');
  });

  it('does not publish an adopted candidate when local pointer installation fails', async () => {
    const currentStore = store();
    currentStore.discoverRecovery.mockResolvedValueOnce({
      candidates: [candidate('config-2')],
      issues: [],
    });
    const pointer: DriveConfigPointerRead = { kind: 'absent', raw: null };
    const installPointer = vi.fn(async () => Promise.reject(new Error('local write failed')));
    const { result } = renderHook(() =>
      useDriveInvoices(options(currentStore, { pointer, installPointer }))
    );
    await waitFor(() => expect(result.current.status).toBe('confirmationRequired'));

    await act(async () => {
      await expect(result.current.confirmRecoveryCandidate('config-2')).rejects.toThrow(
        'local write failed'
      );
    });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.status).toBe('blocked');
  });

  it('keeps retryable pointed failures out of recovery', async () => {
    const currentStore = store();
    currentStore.loadConfigByFileId.mockRejectedValueOnce(
      new DriveStoreError('offline', 'temporarily unavailable', true)
    );
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));

    await waitFor(() => expect(result.current.status).toBe('offline'));

    expect(result.current.recovery).toBeNull();
    expect(currentStore.discoverRecovery).not.toHaveBeenCalled();
  });

  it('enters recovery after a definitive pointed-file failure while retaining old raw', async () => {
    const currentStore = store();
    currentStore.loadConfigByFileId.mockRejectedValueOnce(
      new DriveStoreError('corrupt', 'selected file is dead', false)
    );
    currentStore.discoverRecovery.mockResolvedValueOnce({
      candidates: [candidate('config-2')],
      issues: [{ fileId: 'config-file', message: 'Invalid configuration' }],
    });
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));

    await waitFor(() => expect(result.current.status).toBe('confirmationRequired'));

    expect(result.current.recovery?.previousPointerRaw).toBe(
      '{"version":1,"configFileId":"config-file"}'
    );
  });

  it('rejects stale confirmation after an authorization A-B-A transition', async () => {
    const currentStore = store();
    const adoption = deferred<DriveStoreSnapshot>();
    currentStore.discoverRecovery.mockResolvedValue({
      candidates: [candidate('config-2')],
      issues: [],
    });
    currentStore.adoptRecoveryCandidate.mockImplementationOnce(() => adoption.promise);
    const installPointer = vi.fn();
    const pointer: DriveConfigPointerRead = { kind: 'absent', raw: null };
    const view = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveInvoices(
          options(currentStore, { pointer, installPointer, authorizationIncarnation })
        ),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    await waitFor(() => expect(view.result.current.status).toBe('confirmationRequired'));
    let confirmation!: Promise<DriveStoreSnapshot>;
    act(() => {
      confirmation = view.result.current.confirmRecoveryCandidate('config-2');
    });
    act(() => view.rerender({ authorizationIncarnation: 2 }));
    act(() => view.rerender({ authorizationIncarnation: 3 }));

    await act(async () => {
      adoption.resolve(snapshot());
      await expect(confirmation).rejects.toThrow(/authorization changed/);
    });
    expect(installPointer).not.toHaveBeenCalled();
  });

  it('keeps a configured snapshot ready while refreshing changed invoice sources', async () => {
    const currentStore = store();
    const pendingRefresh = deferred<DriveStoreSnapshot>();
    const view = renderHook(
      ({ sourceContextKey }) => useDriveInvoices(options(currentStore, { sourceContextKey })),
      { initialProps: { sourceContextKey: 'setup-discovery' } }
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    currentStore.rescanInvoices.mockImplementationOnce(() => pendingRefresh.promise);

    act(() => view.rerender({ sourceContextKey: 'current-invoices' }));

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.snapshot?.config.file.id).toBe('config-file');

    await act(async () => pendingRefresh.resolve(snapshot()));
    await waitFor(() => expect(currentStore.rescanInvoices).toHaveBeenCalledOnce());
    expect(currentStore.refresh).not.toHaveBeenCalled();
  });

  it('saves configuration through the current snapshot', async () => {
    const currentStore = store();
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const next = { ...DEFAULT_CONFIG, calendarName: 'Teaching' };

    await act(() => result.current.saveConfig(next));

    expect(currentStore.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ file: expect.objectContaining({ id: 'config-file' }) }),
      }),
      next,
      []
    );
  });

  it('returns the exact snapshot committed by root activation', async () => {
    const currentStore = store();
    const activated = snapshot('activated-root');
    currentStore.activateRoot.mockResolvedValueOnce(activated);
    currentStore.refresh.mockResolvedValue(activated);
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const returned = await act(() => result.current.activateRoot(activated.stagedRoot));

    expect(returned).toBe(activated);
  });

  it('keeps a committed activation and reconciles it with the latest sources', async () => {
    const currentStore = store(snapshot('previous-root'));
    const activation = deferred<DriveStoreSnapshot>();
    const activated = snapshot('activated-root');
    const latestSources = [source('latest')];
    currentStore.activateRoot.mockImplementationOnce(() => activation.promise);
    currentStore.refresh.mockResolvedValue(activated);
    const view = renderHook(
      ({ sourceContextKey, sources, discoveryEnabled }) =>
        useDriveInvoices(options(currentStore, { sourceContextKey, sources, discoveryEnabled })),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          sources: [] as CurrentInvoiceSource[],
          discoveryEnabled: true,
        },
      }
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    view.rerender({
      sourceContextKey: 'setup-discovery',
      sources: [],
      discoveryEnabled: false,
    });
    let result!: Promise<DriveStoreSnapshot>;
    act(() => {
      result = view.result.current.activateRoot(activated.stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'empty-calendar',
      sources: [],
      discoveryEnabled: false,
    });
    view.rerender({
      sourceContextKey: 'setup-discovery',
      sources: [],
      discoveryEnabled: false,
    });
    view.rerender({
      sourceContextKey: 'latest-sources',
      sources: latestSources,
      discoveryEnabled: false,
    });
    await act(async () => {
      activation.resolve(activated);
      await expect(result).resolves.toBe(activated);
    });

    expect(currentStore.refresh).toHaveBeenLastCalledWith(latestSources);
    expect(view.result.current.snapshot?.stagedRoot.root.folderId).toBe('activated-root');
  });

  it('returns the invoice entry from a counter-first store result', async () => {
    const currentStore = store();
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const returned = await act(() =>
      result.current.finalize({
        key: { studioSlug: 'studio-a', monthKey: '2026-08' },
      } as FinalizationInput)
    );

    expect(returned.file.id).toBe('invoice-pdf');
    expect(currentStore.finalize).toHaveBeenCalledOnce();
  });

  it('rejects a completion after the source context changes', async () => {
    const pending = deferred<{ entry: DriveInvoiceEntry; snapshot: DriveStoreSnapshot }>();
    const currentStore = store();
    currentStore.finalize.mockImplementationOnce(() => pending.promise);
    const view = renderHook(
      ({ sourceContextKey }) => useDriveInvoices(options(currentStore, { sourceContextKey })),
      { initialProps: { sourceContextKey: 'source-a' } }
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    let action!: Promise<DriveInvoiceEntry>;
    act(() => {
      action = view.result.current.finalize({
        key: { studioSlug: 'studio-a', monthKey: '2026-08' },
      } as FinalizationInput);
    });
    act(() => view.rerender({ sourceContextKey: 'source-b' }));
    await act(async () => {
      await Promise.resolve();
      pending.resolve({ entry: entry(), snapshot: snapshot() });
      await expect(action).rejects.toThrow(/sources changed/);
    });
  });
});
