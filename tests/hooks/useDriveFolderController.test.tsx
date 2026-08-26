import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceScan } from '../../src/lib/drive/invoiceCatalog.js';
import type { AppConfig, Invoice } from '../../src/lib/types.js';
import type { UseDriveFolderControllerOptions } from '../../src/hooks/useDriveFolderController.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useDriveFolderController } = await import('../../src/hooks/useDriveFolderController.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: 'calendar-a',
  lastInvoice: '8/2026',
  studios: {},
};

const stagedRoot = {
  root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' },
  rootFile: { id: 'root-a', name: 'Lotus invoices' },
  finalFolder: { id: 'final-a', name: 'Final' },
} as StagedDriveRoot;

function emptyScan(): DriveInvoiceScan {
  return { entries: [], warnings: [], blockingConflicts: [], maxSequenceByYear: {} };
}

function driveState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'unconfigured' as const,
    snapshot: null,
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => undefined),
    activateRoot: vi.fn(async () => undefined),
    ...overrides,
  };
}

function options(
  overrides: Partial<UseDriveFolderControllerOptions> = {}
): UseDriveFolderControllerOptions {
  return {
    hasDriveAuthorization: true,
    authorizationIncarnation: 1,
    authorizeDrive: vi.fn(async () => undefined),
    drive: driveState(),
    config,
    saveConfig: vi.fn(async () => undefined),
    sources: [],
    sourceContextKey: 'setup-discovery',
    scanCandidate: vi.fn(async () => emptyScan()),
    ...overrides,
  };
}

function invoice(): Invoice {
  return {
    studioName: 'Studio A',
    invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    generatedAt: '2026-08-27T00:00:00.000Z',
    issueDate: '2026-08-27',
    classes: [],
    totalClasses: 0,
    totalAmount: 0,
  };
}

function source(sourceSha256: string): CurrentInvoiceSource {
  return {
    key: { studioSlug: 'studio-a', monthKey: '2026-08' },
    studioName: 'Studio A',
    invoice: invoice(),
    classes: [],
    config,
    fingerprint: { sourceSha256, calendarSha256: 'calendar-a' },
  };
}

afterEach(() => cleanup());
afterAll(() => restoreDom());

describe('useDriveFolderController', () => {
  it('authorizes before opening and ignores completion after close/reopen', async () => {
    const first = deferred<void>();
    const authorizeDrive = vi.fn(() => first.promise);
    const view = renderHook(() =>
      useDriveFolderController({
        ...options(),
        hasDriveAuthorization: false,
        authorizeDrive,
      })
    );
    let staleOpen!: Promise<void>;
    act(() => {
      staleOpen = view.result.current.openDialog();
    });
    act(() => view.result.current.closeDialog());
    await act(async () => {
      first.resolve();
      await staleOpen;
    });
    expect(view.result.current.dialogOpen).toBe(false);
  });

  it('ignores authorization completion after the authorization incarnation changes', async () => {
    const pending = deferred<void>();
    const authorizeDrive = vi.fn(() => pending.promise);
    const view = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveFolderController({
          ...options(),
          hasDriveAuthorization: false,
          authorizationIncarnation,
          authorizeDrive,
        }),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    let opening!: Promise<void>;
    act(() => {
      opening = view.result.current.openDialog();
    });
    view.rerender({ authorizationIncarnation: 2 });
    await act(async () => {
      pending.resolve();
      await opening;
    });

    expect(view.result.current.dialogOpen).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it('opens after its own Drive authorization commits a new incarnation', async () => {
    const pending = deferred<void>();
    const authorizeDrive = vi.fn(() => pending.promise);
    const base = options({ authorizeDrive });
    const view = renderHook(
      ({ hasDriveAuthorization, authorizationIncarnation }) =>
        useDriveFolderController({
          ...base,
          hasDriveAuthorization,
          authorizationIncarnation,
        }),
      { initialProps: { hasDriveAuthorization: false, authorizationIncarnation: 1 } }
    );
    let opening!: Promise<void>;
    act(() => {
      opening = view.result.current.openDialog();
    });
    view.rerender({ hasDriveAuthorization: true, authorizationIncarnation: 2 });
    await act(async () => {
      pending.resolve();
      await opening;
    });

    expect(view.result.current.dialogOpen).toBe(true);
    expect(view.result.current.error).toBeNull();
  });

  it('activates remotely once when legacy-config cleanup needs a retry', async () => {
    const activateRoot = vi.fn(async () => undefined);
    const latestConfig: AppConfig = {
      ...config,
      outputDir: '/latest-output',
      teacher: { ...config.teacher, name: 'Latest Teacher' },
    };
    const attemptedConfigs: AppConfig[] = [];
    let saveAttempt = 0;
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      const next = update(latestConfig);
      if (next !== null) attemptedConfigs.push(next);
      saveAttempt += 1;
      if (saveAttempt === 1) throw new Error('disk full');
    });
    const view = renderHook(() =>
      useDriveFolderController({ ...options(), drive: driveState({ activateRoot }), saveConfig })
    );

    await act(async () => {
      await expect(view.result.current.confirmRoot(stagedRoot)).rejects.toThrow('disk full');
    });
    await act(() => view.result.current.confirmRoot(stagedRoot));

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(attemptedConfigs.at(-1)).toEqual(
      expect.objectContaining({ teacher: expect.objectContaining({ name: 'Latest Teacher' }) })
    );
    expect(attemptedConfigs.at(-1)).not.toHaveProperty('outputDir');
    expect(attemptedConfigs.at(-1)).not.toHaveProperty('lastInvoice');
  });

  it('retains durable cleanup debt when invoice sources change before retry', async () => {
    const activateRoot = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const drive = driveState({ activateRoot, refresh });
    let saveAttempt = 0;
    let durableConfig: AppConfig | null = null;
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      durableConfig = update(config);
      saveAttempt += 1;
      if (saveAttempt === 1) throw new Error('disk full');
    });
    const base = options({ drive, saveConfig });
    const view = renderHook(
      ({ sourceContextKey }) => useDriveFolderController({ ...base, sourceContextKey }),
      { initialProps: { sourceContextKey: 'source-a' } }
    );

    await act(async () => {
      await expect(view.result.current.confirmRoot(stagedRoot)).rejects.toThrow('disk full');
    });
    view.rerender({ sourceContextKey: 'source-b' });
    await act(() => view.result.current.retry());

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(durableConfig).not.toHaveProperty('lastInvoice');
  });

  it('scans with an empty source list when invoice sources are unavailable', async () => {
    const scanCandidate = vi.fn(async () => emptyScan());
    const view = renderHook(() =>
      useDriveFolderController({
        ...options(),
        sources: [],
        sourceContextKey: 'setup-discovery',
        scanCandidate,
      })
    );
    await view.result.current.scanCandidate(stagedRoot);
    expect(scanCandidate).toHaveBeenCalledWith(stagedRoot, []);
  });

  it('rejects the first A scan after a source A to B to A transition', async () => {
    const firstA = deferred<DriveInvoiceScan>();
    const scanCandidate = vi
      .fn<UseDriveFolderControllerOptions['scanCandidate']>()
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(emptyScan());
    const view = renderHook(
      ({ sourceContextKey, sources }) =>
        useDriveFolderController({
          ...options(),
          sourceContextKey,
          sources,
          scanCandidate,
        }),
      { initialProps: { sourceContextKey: 'source-a', sources: [source('source-a')] } }
    );
    let staleScan!: Promise<DriveInvoiceScan>;
    act(() => {
      staleScan = view.result.current.scanCandidate(stagedRoot);
    });
    view.rerender({ sourceContextKey: 'source-b', sources: [source('source-b')] });
    view.rerender({ sourceContextKey: 'source-a', sources: [source('source-a')] });

    await expect(view.result.current.scanCandidate(stagedRoot)).resolves.toEqual(emptyScan());
    firstA.resolve(emptyScan());
    await expect(staleScan).rejects.toThrow(
      'Current invoice sources changed before the Drive folder scan completed'
    );
    expect(view.result.current.error).toBeNull();
  });

  it('rejects a scan completion after Drive authorization changes', async () => {
    const pending = deferred<DriveInvoiceScan>();
    const scanCandidate = vi.fn(() => pending.promise);
    const view = renderHook(
      ({ authorizationIncarnation }) =>
        useDriveFolderController({
          ...options(),
          authorizationIncarnation,
          scanCandidate,
        }),
      { initialProps: { authorizationIncarnation: 1 } }
    );
    const scan = view.result.current.scanCandidate(stagedRoot);
    view.rerender({ authorizationIncarnation: 2 });
    pending.resolve(emptyScan());

    await expect(scan).rejects.toThrow(
      'Drive authorization changed before the Drive folder scan completed'
    );
    expect(view.result.current.error).toBeNull();
  });

  it('does not clean config from an obsolete confirm after close/reopen', async () => {
    const pending = deferred<void>();
    const activateRoot = vi.fn(() => pending.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>();
    const view = renderHook(() =>
      useDriveFolderController({ ...options(), drive: driveState({ activateRoot }), saveConfig })
    );
    await act(() => view.result.current.openDialog());
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });
    act(() => view.result.current.closeDialog());
    await act(() => view.result.current.openDialog());
    await act(async () => {
      pending.resolve();
      await expect(confirmation).rejects.toThrow(
        'Drive folder dialog session changed before the Drive folder confirmation completed'
      );
    });
    expect(saveConfig).not.toHaveBeenCalled();
    expect(view.result.current.dialogOpen).toBe(true);
    expect(view.result.current.error).toBeNull();
  });
});
