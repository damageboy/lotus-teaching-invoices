import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/config/defaults.js';
import type {
  CurrentInvoiceSource,
  DriveInvoiceEntry,
} from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveStoreSnapshot, FinalizationInput } from '../../src/lib/drive/invoiceStore.js';
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

function store(initial: DriveStoreSnapshot | null = snapshot()) {
  return {
    bootstrap: vi.fn(async () => initial),
    refresh: vi.fn(async () => initial ?? snapshot()),
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
  return {
    store: currentStore,
    sources: [] as CurrentInvoiceSource[],
    sourceContextKey: 'setup-discovery',
    authorizationIncarnation: 1,
    discoveryEnabled: true,
    foregroundRefreshEnabled: false,
    ...overrides,
  };
}

describe('useDriveInvoices', () => {
  afterAll(restoreDom);

  it('publishes the cloud snapshot and passes legacy YAML only to bootstrap', async () => {
    const currentStore = store();
    const { result } = renderHook(() =>
      useDriveInvoices(options(currentStore, { legacyLocalYaml: 'teacher: {}\n' }))
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(currentStore.bootstrap).toHaveBeenCalledWith([], 'teacher: {}\n');
    expect(result.current.snapshot?.config.file.id).toBe('config-file');
  });

  it('publishes unconfigured discovery without a local authority', async () => {
    const currentStore = store(null);
    const { result } = renderHook(() => useDriveInvoices(options(currentStore)));

    await waitFor(() => expect(result.current.status).toBe('unconfigured'));
    expect(result.current.snapshot).toBeNull();
  });

  it('keeps a configured snapshot ready while refreshing changed invoice sources', async () => {
    const currentStore = store();
    const pendingRefresh = deferred<DriveStoreSnapshot>();
    const view = renderHook(
      ({ sourceContextKey }) => useDriveInvoices(options(currentStore, { sourceContextKey })),
      { initialProps: { sourceContextKey: 'setup-discovery' } }
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    currentStore.refresh.mockImplementationOnce(() => pendingRefresh.promise);

    act(() => view.rerender({ sourceContextKey: 'current-invoices' }));

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.snapshot?.config.file.id).toBe('config-file');

    await act(async () => pendingRefresh.resolve(snapshot()));
    await waitFor(() => expect(currentStore.refresh).toHaveBeenCalledOnce());
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
