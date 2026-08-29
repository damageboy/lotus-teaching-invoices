import { useLayoutEffect, useRef } from 'react';
import type { DriveInvoicesStatus } from './useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../lib/drive/invoiceStore.js';

export interface UseDriveSetupSnapshotOptions {
  store: object;
  authorizationIncarnation: number;
  status: DriveInvoicesStatus;
  snapshot: DriveStoreSnapshot | null;
}

interface RemoteEvidence {
  store: object;
  authorizationIncarnation: number;
  snapshot: DriveStoreSnapshot | null;
}

function isTransient(status: DriveInvoicesStatus): boolean {
  return status === 'loading' || status === 'offline' || status === 'blocked';
}

function isConclusiveReset(status: DriveInvoicesStatus): boolean {
  return (
    status === 'unconfigured' ||
    status === 'authorizationRequired' ||
    status === 'confirmationRequired'
  );
}

export function useDriveSetupSnapshot({
  store,
  authorizationIncarnation,
  status,
  snapshot,
}: UseDriveSetupSnapshotOptions): DriveStoreSnapshot | null {
  const evidenceRef = useRef<RemoteEvidence>({
    store,
    authorizationIncarnation,
    snapshot: null,
  });
  const evidence = evidenceRef.current;
  const identityMatches =
    evidence.store === store && evidence.authorizationIncarnation === authorizationIncarnation;
  const visibleSnapshot =
    !identityMatches || isConclusiveReset(status)
      ? null
      : (snapshot ?? (isTransient(status) ? evidence.snapshot : null));

  useLayoutEffect(() => {
    const current = evidenceRef.current;
    if (current.store !== store || current.authorizationIncarnation !== authorizationIncarnation) {
      evidenceRef.current = { store, authorizationIncarnation, snapshot: null };
      return;
    }
    if (isConclusiveReset(status)) {
      evidenceRef.current = { ...current, snapshot: null };
      return;
    }
    if (snapshot !== null) {
      evidenceRef.current = { ...current, snapshot };
    }
  }, [authorizationIncarnation, snapshot, status, store]);

  return visibleSnapshot;
}
