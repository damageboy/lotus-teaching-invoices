import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/config/defaults.js';
import type { StagedDriveRoot } from '../../src/lib/drive/folders.js';
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

function drive(
  status: DriveInvoicesState['status'] = 'unconfigured',
  activateRoot = vi.fn(async () => undefined)
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

  it('passes the in-memory config only for initial setup', async () => {
    const activateRoot = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useDriveFolderController(options({ drive: drive('unconfigured', activateRoot) }))
    );

    await act(() => result.current.confirmRoot(stagedRoot));

    expect(activateRoot).toHaveBeenCalledWith(stagedRoot, DEFAULT_CONFIG);
    expect(result.current.cleanupPending).toBe(false);
  });

  it('moves an existing config without rewriting configuration', async () => {
    const activateRoot = vi.fn(async () => undefined);
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
