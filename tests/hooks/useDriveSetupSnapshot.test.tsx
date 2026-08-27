import { afterAll, describe, expect, it } from 'vitest';
import type { DriveInvoicesStatus } from '../../src/hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreEnvironment = installReactTestEnvironment();
afterAll(() => restoreEnvironment());

const { renderHook } = await import('@testing-library/react');
const { useDriveSetupSnapshot } = await import('../../src/hooks/useDriveSetupSnapshot.js');

interface Fixture {
  store: object;
  authorizationIncarnation: number;
  status: DriveInvoicesStatus;
  snapshot: DriveStoreSnapshot | null;
}

function snapshot(folderId: string): DriveStoreSnapshot {
  return {
    stagedRoot: { root: { folderId } },
  } as DriveStoreSnapshot;
}

describe('useDriveSetupSnapshot', () => {
  it('retains a remote-confirmed snapshot through transient same-identity states', () => {
    const store = {};
    const confirmed = snapshot('root-a');
    const view = renderHook(({ fixture }: { fixture: Fixture }) => useDriveSetupSnapshot(fixture), {
      initialProps: {
        fixture: { store, authorizationIncarnation: 4, status: 'ready', snapshot: confirmed },
      },
    });

    for (const status of ['loading', 'offline', 'blocked'] as const) {
      view.rerender({
        fixture: { store, authorizationIncarnation: 4, status, snapshot: null },
      });
      expect(view.result.current).toBe(confirmed);
    }
  });

  it('clears retained evidence on conclusive unconfigured and authorization states', () => {
    const store = {};
    const confirmed = snapshot('root-a');
    const view = renderHook(({ fixture }: { fixture: Fixture }) => useDriveSetupSnapshot(fixture), {
      initialProps: {
        fixture: { store, authorizationIncarnation: 4, status: 'ready', snapshot: confirmed },
      },
    });

    for (const status of ['unconfigured', 'authorizationRequired'] as const) {
      view.rerender({
        fixture: { store, authorizationIncarnation: 4, status, snapshot: null },
      });
      expect(view.result.current).toBeNull();
      view.rerender({
        fixture: { store, authorizationIncarnation: 4, status: 'loading', snapshot: null },
      });
      expect(view.result.current).toBeNull();
      view.rerender({
        fixture: { store, authorizationIncarnation: 4, status: 'ready', snapshot: confirmed },
      });
    }
  });

  it('rejects retained evidence immediately when store or authorization identity changes', () => {
    const storeA = {};
    const storeB = {};
    const confirmedA = snapshot('root-a');
    const confirmedB = snapshot('root-b');
    const view = renderHook(({ fixture }: { fixture: Fixture }) => useDriveSetupSnapshot(fixture), {
      initialProps: {
        fixture: {
          store: storeA,
          authorizationIncarnation: 4,
          status: 'ready',
          snapshot: confirmedA,
        },
      },
    });

    view.rerender({
      fixture: {
        store: storeB,
        authorizationIncarnation: 4,
        status: 'loading',
        snapshot: null,
      },
    });
    expect(view.result.current).toBeNull();

    view.rerender({
      fixture: {
        store: storeB,
        authorizationIncarnation: 4,
        status: 'ready',
        snapshot: confirmedB,
      },
    });
    expect(view.result.current).toBe(confirmedB);

    view.rerender({
      fixture: {
        store: storeB,
        authorizationIncarnation: 5,
        status: 'loading',
        snapshot: null,
      },
    });
    expect(view.result.current).toBeNull();
  });
});
