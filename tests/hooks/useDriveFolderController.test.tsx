import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceScan } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import type { DriveFileRecord } from '../../src/lib/drive/types.js';
import type { AppConfig, Invoice } from '../../src/lib/types.js';
import type { UseDriveFolderControllerOptions } from '../../src/hooks/useDriveFolderController.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useDriveFolderController } = await import('../../src/hooks/useDriveFolderController.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function driveFile(id: string, name: string, parents: string[]): DriveFileRecord {
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
    capabilities: {
      canListChildren: true,
      canAddChildren: true,
      canEdit: true,
      canDownload: false,
    },
    etag: `"${id}-v1"`,
  };
}

function stagedRootFor(
  folderId: string,
  folderName: string,
  finalFolderId: string
): StagedDriveRoot {
  return {
    root: { folderId, driveId: null, folderName },
    rootFile: driveFile(folderId, folderName, []),
    finalFolder: driveFile(finalFolderId, 'Final', [folderId]),
  };
}

const stagedRoot = stagedRootFor('root-a', 'Lotus invoices', 'final-a');

function configuredSnapshot(root: StagedDriveRoot = stagedRoot): DriveStoreSnapshot {
  return {
    control: {
      file: {
        ...driveFile('control-a', '.lotus-teaching-invoices.json', []),
        mimeType: 'application/json',
        capabilities: {
          canListChildren: false,
          canAddChildren: false,
          canEdit: true,
          canDownload: true,
        },
      },
      control: {
        schemaVersion: 1,
        generation: 1,
        root: { ...root.root },
        finalFolderId: root.finalFolder.id,
        sequenceByYear: {},
        reservation: null,
      },
    },
    stagedRoot: root,
    scan: emptyScan(),
  };
}

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

  it('does not adopt multiple authorization incarnations as its own transition', async () => {
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
    view.rerender({ hasDriveAuthorization: true, authorizationIncarnation: 3 });
    await act(async () => {
      pending.resolve();
      await opening;
    });

    expect(view.result.current.dialogOpen).toBe(false);
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
    expect(view.result.current.cleanupPending).toBe(false);
  });

  it('adopts its own activated root when setup completion builds the first source context', async () => {
    const activation = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      const next = update(config);
      expect(next).not.toBeNull();
      expect(next).not.toHaveProperty('lastInvoice');
    });
    const base = options({ saveConfig });
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'setup-discovery',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    view.rerender({
      sourceContextKey: 'built-sources',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await expect(confirmation).resolves.toBeUndefined();
    });

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(view.result.current.cleanupPending).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it('adopts its own source transition while activated-root config cleanup begins', async () => {
    const activation = deferred<void>();
    const cleanupStarted = deferred<void>();
    const continueCleanup = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      cleanupStarted.resolve();
      await continueCleanup.promise;
      const next = update(config);
      expect(next).not.toBeNull();
      expect(next).not.toHaveProperty('lastInvoice');
    });
    const base = options({ saveConfig });
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'setup-discovery',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await cleanupStarted.promise;
    });
    view.rerender({
      sourceContextKey: 'built-sources',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    await act(async () => {
      continueCleanup.resolve();
      await expect(confirmation).resolves.toBeUndefined();
    });

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(view.result.current.cleanupPending).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it('does not adopt a single built source transition after activation', async () => {
    const activation = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>();
    const base = options({ saveConfig });
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'built-a',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'built-b',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await expect(confirmation).rejects.toThrow(
        'Current invoice sources changed before the Drive folder confirmation completed'
      );
    });

    expect(saveConfig).not.toHaveBeenCalled();
    expect(view.result.current.cleanupPending).toBe(true);
  });

  it('does not adopt a second source transition during activated-root cleanup', async () => {
    const activation = deferred<void>();
    const cleanupStarted = deferred<void>();
    const continueCleanup = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      cleanupStarted.resolve();
      await continueCleanup.promise;
      update(config);
    });
    const base = options({ saveConfig });
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'built-a',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await cleanupStarted.promise;
    });
    view.rerender({
      sourceContextKey: 'built-b',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    await act(async () => {
      continueCleanup.resolve();
      await expect(confirmation).rejects.toThrow(
        'Current invoice sources changed before the Drive folder confirmation completed'
      );
    });

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(view.result.current.cleanupPending).toBe(true);
  });

  it('rejects A to B to A source changes even when the activated root matches', async () => {
    const activation = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>();
    const base = options({ saveConfig });
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'source-a',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'source-a',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    view.rerender({
      sourceContextKey: 'source-b',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    view.rerender({
      sourceContextKey: 'source-a',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await expect(confirmation).rejects.toThrow(
        'Current invoice sources changed before the Drive folder confirmation completed'
      );
    });

    expect(saveConfig).not.toHaveBeenCalled();
    expect(view.result.current.cleanupPending).toBe(true);
  });

  it('does not adopt an unrelated authoritative root after a source change', async () => {
    const activation = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>();
    const base = options({ saveConfig });
    const otherRoot = stagedRootFor('root-b', 'Other invoices', 'final-b');
    const view = renderHook(
      ({ sourceContextKey, drive }) =>
        useDriveFolderController({ ...base, sourceContextKey, drive }),
      {
        initialProps: {
          sourceContextKey: 'setup-discovery',
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      sourceContextKey: 'setup-discovery',
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(otherRoot), activateRoot }),
    });
    view.rerender({
      sourceContextKey: 'built-sources',
      drive: driveState({ status: 'loading', snapshot: null, activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await expect(confirmation).rejects.toThrow(
        'Current invoice sources changed before the Drive folder confirmation completed'
      );
    });

    expect(saveConfig).not.toHaveBeenCalled();
    expect(view.result.current.cleanupPending).toBe(true);
  });

  it('does not adopt an activated root after Drive authorization changes', async () => {
    const activation = deferred<void>();
    const activateRoot = vi.fn(() => activation.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>();
    const base = options({ saveConfig });
    const view = renderHook(
      ({ authorizationIncarnation, drive }) =>
        useDriveFolderController({ ...base, authorizationIncarnation, drive }),
      {
        initialProps: {
          authorizationIncarnation: 1,
          drive: driveState({ activateRoot }),
        },
      }
    );
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = view.result.current.confirmRoot(stagedRoot);
    });

    view.rerender({
      authorizationIncarnation: 2,
      drive: driveState({ status: 'ready', snapshot: configuredSnapshot(), activateRoot }),
    });
    await act(async () => {
      activation.resolve();
      await expect(confirmation).rejects.toThrow(
        'Drive authorization changed before the Drive folder confirmation completed'
      );
    });

    expect(saveConfig).not.toHaveBeenCalled();
    expect(view.result.current.cleanupPending).toBe(true);
  });

  it('does not let an overlapping confirmation replace newer cleanup state', async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const activateRoot = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      update(config);
    });
    const view = renderHook(() =>
      useDriveFolderController({ ...options(), drive: driveState({ activateRoot }), saveConfig })
    );
    let olderConfirmation!: Promise<void>;
    let newerConfirmation!: Promise<void>;
    act(() => {
      olderConfirmation = view.result.current.confirmRoot(stagedRoot);
      newerConfirmation = view.result.current.confirmRoot(stagedRoot);
    });

    await act(async () => {
      newer.resolve();
      await expect(newerConfirmation).resolves.toBeUndefined();
    });
    await act(async () => {
      older.resolve();
      await expect(olderConfirmation).rejects.toThrow(
        'Drive folder setup changed before the Drive folder confirmation completed'
      );
    });

    expect(activateRoot).toHaveBeenCalledTimes(2);
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(view.result.current.cleanupPending).toBe(false);
  });

  it('rejects an older cleanup after an overlapping confirmation clears it', async () => {
    const firstCleanupStarted = deferred<void>();
    const continueFirstCleanup = deferred<void>();
    const activateRoot = vi.fn(async () => undefined);
    let saveCall = 0;
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async (update) => {
      expect(update(config)).not.toBeNull();
      saveCall += 1;
      if (saveCall === 1) {
        firstCleanupStarted.resolve();
        await continueFirstCleanup.promise;
      }
    });
    const view = renderHook(() =>
      useDriveFolderController({ ...options(), drive: driveState({ activateRoot }), saveConfig })
    );
    let olderConfirmation!: Promise<void>;
    act(() => {
      olderConfirmation = view.result.current.confirmRoot(stagedRoot);
    });
    await act(() => firstCleanupStarted.promise);

    let newerConfirmation!: Promise<void>;
    act(() => {
      newerConfirmation = view.result.current.confirmRoot(stagedRoot);
    });
    await act(async () => {
      await expect(newerConfirmation).resolves.toBeUndefined();
    });
    await act(async () => {
      continueFirstCleanup.resolve();
      await expect(olderConfirmation).rejects.toThrow(
        'Drive folder setup changed before the Drive folder confirmation completed'
      );
    });

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(view.result.current.cleanupPending).toBe(false);
  });

  it('keeps cleanup debt visible across close and semantic changes', async () => {
    const activateRoot = vi.fn(async () => undefined);
    const saveConfig = vi.fn<UseDriveFolderControllerOptions['saveConfig']>(async () => {
      throw new Error('disk full');
    });
    const base = options({ drive: driveState({ activateRoot }), saveConfig });
    const view = renderHook(
      ({ sourceContextKey, authorizationIncarnation }) =>
        useDriveFolderController({ ...base, sourceContextKey, authorizationIncarnation }),
      { initialProps: { sourceContextKey: 'source-a', authorizationIncarnation: 1 } }
    );

    await act(async () => {
      await expect(view.result.current.confirmRoot(stagedRoot)).rejects.toThrow('disk full');
    });
    expect(view.result.current.cleanupPending).toBe(true);
    expect(view.result.current.error).toBe('disk full');

    act(() => view.result.current.closeDialog());
    view.rerender({ sourceContextKey: 'source-b', authorizationIncarnation: 2 });

    expect(activateRoot).toHaveBeenCalledOnce();
    expect(view.result.current.cleanupPending).toBe(true);
    expect(view.result.current.error).toBe('disk full');
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

  it('does not let an older retry failure replace a newer retry result', async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const view = renderHook(() =>
      useDriveFolderController({ ...options(), drive: driveState({ refresh }) })
    );
    let olderRetry!: Promise<void>;
    let newerRetry!: Promise<void>;
    act(() => {
      olderRetry = view.result.current.retry();
      newerRetry = view.result.current.retry();
    });

    await act(async () => {
      older.reject(new Error('older retry failed'));
      await expect(olderRetry).rejects.toThrow('older retry failed');
    });
    await act(async () => {
      newer.resolve();
      await newerRetry;
    });

    expect(view.result.current.error).toBeNull();
  });
});
