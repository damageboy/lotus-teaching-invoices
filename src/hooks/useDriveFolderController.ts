import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StagedDriveRoot } from '../lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceScan } from '../lib/drive/invoiceCatalog.js';
import type { DriveStoreSnapshot } from '../lib/drive/invoiceStore.js';
import type { AppConfig } from '../lib/types.js';
import type { DriveInvoicesState } from './useDriveInvoices.js';

export interface DriveFolderController {
  dialogOpen: boolean;
  opening: boolean;
  cleanupPending: boolean;
  error: string | null;
  openDialog(): Promise<void>;
  closeDialog(): void;
  scanCandidate(stagedRoot: StagedDriveRoot): Promise<DriveInvoiceScan>;
  confirmRoot(stagedRoot: StagedDriveRoot): Promise<void>;
  retry(): Promise<void>;
}

export interface UseDriveFolderControllerOptions {
  hasDriveAuthorization: boolean;
  authorizationIncarnation: number;
  authorizeDrive(): Promise<void>;
  drive: Pick<
    DriveInvoicesState,
    'status' | 'snapshot' | 'error' | 'operationKey' | 'refresh' | 'activateRoot'
  >;
  config: AppConfig;
  saveConfig(update: (current: AppConfig) => AppConfig | null): Promise<void>;
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  scanCandidate(
    stagedRoot: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveInvoiceScan>;
}

interface PendingConfigCleanup {
  rootKey: string;
  stagedRoot: StagedDriveRoot;
}

interface CommittedOptions extends UseDriveFolderControllerOptions {
  sourceSignature: string;
}

interface OperationContext {
  semanticIncarnation: number;
  sourceIncarnation: number;
  sourceContextOrigin: string;
  activationSourceAdoptionAvailable: boolean;
  authorizationIncarnation: number;
  session: number;
}

interface ActivationSnapshotEvidence {
  authorizationIncarnation: number;
  activateRoot: UseDriveFolderControllerOptions['drive']['activateRoot'];
  snapshot: DriveStoreSnapshot | null;
}

type OperationName = 'opening' | 'scan' | 'confirmation' | 'retry';

const SETUP_DISCOVERY_SOURCE_CONTEXT = 'setup-discovery';

function sourceSignature(
  sourceContextKey: string,
  sources: readonly CurrentInvoiceSource[]
): string {
  return JSON.stringify([
    sourceContextKey,
    sources
      .map((source) => ({
        studioSlug: source.key.studioSlug,
        monthKey: source.key.monthKey,
        studioName: source.studioName,
        sourceSha256: source.fingerprint.sourceSha256,
        calendarSha256: source.fingerprint.calendarSha256,
      }))
      .sort((left, right) =>
        `${left.studioSlug}\u0000${left.monthKey}`.localeCompare(
          `${right.studioSlug}\u0000${right.monthKey}`
        )
      ),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationLabel(operation: OperationName): string {
  switch (operation) {
    case 'opening':
      return 'opening completed';
    case 'scan':
      return 'scan completed';
    case 'confirmation':
      return 'confirmation completed';
    case 'retry':
      return 'retry completed';
  }
}

export function useDriveFolderController(
  options: UseDriveFolderControllerOptions
): DriveFolderController {
  const signature = sourceSignature(options.sourceContextKey, options.sources);
  const mountedRef = useRef(true);
  const committedOptionsRef = useRef<CommittedOptions>({
    ...options,
    sourceSignature: signature,
  });
  const committedIdentityRef = useRef({
    authorizationIncarnation: options.authorizationIncarnation,
    sourceSignature: signature,
  });
  const activationSnapshotRef = useRef<ActivationSnapshotEvidence>({
    authorizationIncarnation: options.authorizationIncarnation,
    activateRoot: options.drive.activateRoot,
    snapshot: options.drive.status === 'ready' ? options.drive.snapshot : null,
  });
  const semanticIncarnationRef = useRef(0);
  const sourceIncarnationRef = useRef(0);
  const sessionRef = useRef(0);
  const retryGenerationRef = useRef(0);
  const pendingCleanupRef = useRef<PendingConfigCleanup | null>(null);
  const pendingCleanupIncarnationRef = useRef(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const previous = committedIdentityRef.current;
    const authorizationChanged =
      previous.authorizationIncarnation !== options.authorizationIncarnation;
    const sourcesChanged = previous.sourceSignature !== signature;
    if (authorizationChanged || sourcesChanged) {
      semanticIncarnationRef.current += 1;
      if (sourcesChanged) sourceIncarnationRef.current += 1;
      setOpening(false);
      if (pendingCleanupRef.current === null) setError(null);
    }
    committedIdentityRef.current = {
      authorizationIncarnation: options.authorizationIncarnation,
      sourceSignature: signature,
    };
    const evidence = activationSnapshotRef.current;
    if (
      evidence.authorizationIncarnation !== options.authorizationIncarnation ||
      evidence.activateRoot !== options.drive.activateRoot ||
      options.drive.status === 'unconfigured' ||
      options.drive.status === 'authorizationRequired'
    ) {
      activationSnapshotRef.current = {
        authorizationIncarnation: options.authorizationIncarnation,
        activateRoot: options.drive.activateRoot,
        snapshot: null,
      };
    } else if (options.drive.status === 'ready' && options.drive.snapshot !== null) {
      activationSnapshotRef.current = { ...evidence, snapshot: options.drive.snapshot };
    }
    committedOptionsRef.current = { ...options, sourceSignature: signature };
  }, [options, signature]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
    };
  }, []);

  const captureContext = useCallback((): OperationContext => {
    const current = committedOptionsRef.current;
    return {
      semanticIncarnation: semanticIncarnationRef.current,
      sourceIncarnation: sourceIncarnationRef.current,
      sourceContextOrigin: current.sourceContextKey,
      activationSourceAdoptionAvailable: false,
      authorizationIncarnation: current.authorizationIncarnation,
      session: sessionRef.current,
    };
  }, []);

  const contextIsCurrent = useCallback((context: OperationContext): boolean => {
    const current = committedOptionsRef.current;
    return (
      mountedRef.current &&
      context.semanticIncarnation === semanticIncarnationRef.current &&
      context.sourceIncarnation === sourceIncarnationRef.current &&
      context.authorizationIncarnation === current.authorizationIncarnation &&
      context.session === sessionRef.current
    );
  }, []);

  const obsoleteError = useCallback(
    (context: OperationContext, operation: OperationName): Error => {
      const current = committedOptionsRef.current;
      if (context.sourceIncarnation !== sourceIncarnationRef.current) {
        return new Error(
          `Current invoice sources changed before the Drive folder ${operationLabel(operation)}`
        );
      }
      if (context.authorizationIncarnation !== current.authorizationIncarnation) {
        return new Error(
          `Drive authorization changed before the Drive folder ${operationLabel(operation)}`
        );
      }
      if (context.session !== sessionRef.current) {
        return new Error(
          `Drive folder dialog session changed before the Drive folder ${operationLabel(operation)}`
        );
      }
      return new Error(
        `Drive folder setup changed before the Drive folder ${operationLabel(operation)}`
      );
    },
    []
  );

  const requireCurrent = useCallback(
    (context: OperationContext, operation: OperationName): void => {
      if (!contextIsCurrent(context)) throw obsoleteError(context, operation);
    },
    [contextIsCurrent, obsoleteError]
  );

  const adoptSuccessfulAuthorization = useCallback((context: OperationContext): boolean => {
    const current = committedOptionsRef.current;
    if (
      !mountedRef.current ||
      !current.hasDriveAuthorization ||
      current.authorizationIncarnation !== context.authorizationIncarnation + 1 ||
      context.sourceIncarnation !== sourceIncarnationRef.current ||
      context.session !== sessionRef.current
    ) {
      return false;
    }
    context.authorizationIncarnation = current.authorizationIncarnation;
    context.semanticIncarnation = semanticIncarnationRef.current;
    return true;
  }, []);

  const adoptSuccessfulActivation = useCallback(
    (
      context: OperationContext,
      stagedRoot: StagedDriveRoot,
      pendingCleanupIncarnation: number
    ): boolean => {
      const current = committedOptionsRef.current;
      const evidence = activationSnapshotRef.current;
      const snapshot =
        current.drive.snapshot ??
        (current.drive.status === 'loading' &&
        evidence.authorizationIncarnation === current.authorizationIncarnation &&
        evidence.activateRoot === current.drive.activateRoot
          ? evidence.snapshot
          : null);
      if (
        !mountedRef.current ||
        context.session !== sessionRef.current ||
        context.authorizationIncarnation !== current.authorizationIncarnation ||
        !context.activationSourceAdoptionAvailable ||
        context.sourceContextOrigin !== SETUP_DISCOVERY_SOURCE_CONTEXT ||
        current.sourceContextKey === SETUP_DISCOVERY_SOURCE_CONTEXT ||
        context.sourceIncarnation + 1 !== sourceIncarnationRef.current ||
        context.semanticIncarnation + 1 !== semanticIncarnationRef.current ||
        pendingCleanupIncarnation !== pendingCleanupIncarnationRef.current ||
        (current.drive.status !== 'ready' && current.drive.status !== 'loading') ||
        snapshot === null ||
        snapshot.stagedRoot.root.folderId !== stagedRoot.root.folderId ||
        snapshot.stagedRoot.root.driveId !== stagedRoot.root.driveId ||
        snapshot.stagedRoot.finalFolder.id !== stagedRoot.finalFolder.id ||
        snapshot.control.control.root.folderId !== stagedRoot.root.folderId ||
        snapshot.control.control.root.driveId !== stagedRoot.root.driveId ||
        snapshot.control.control.finalFolderId !== stagedRoot.finalFolder.id
      ) {
        return false;
      }
      context.activationSourceAdoptionAvailable = false;
      context.sourceIncarnation = sourceIncarnationRef.current;
      context.semanticIncarnation = semanticIncarnationRef.current;
      return true;
    },
    []
  );

  const openDialog = useCallback(async (): Promise<void> => {
    const session = ++sessionRef.current;
    const context = { ...captureContext(), session };
    const current = committedOptionsRef.current;
    setDialogOpen(false);
    setOpening(true);
    setError(null);
    try {
      if (!current.hasDriveAuthorization || current.drive.status === 'authorizationRequired') {
        await current.authorizeDrive();
        if (!contextIsCurrent(context)) adoptSuccessfulAuthorization(context);
        requireCurrent(context, 'opening');
      }
      requireCurrent(context, 'opening');
      setDialogOpen(true);
    } catch (cause) {
      if (contextIsCurrent(context)) setError(errorMessage(cause));
    } finally {
      if (contextIsCurrent(context)) setOpening(false);
    }
  }, [adoptSuccessfulAuthorization, captureContext, contextIsCurrent, requireCurrent]);

  const closeDialog = useCallback((): void => {
    sessionRef.current += 1;
    setDialogOpen(false);
    setOpening(false);
    if (pendingCleanupRef.current === null) setError(null);
  }, []);

  const scanCandidate = useCallback(
    async (stagedRoot: StagedDriveRoot): Promise<DriveInvoiceScan> => {
      const context = captureContext();
      const current = committedOptionsRef.current;
      const sources = [...current.sources];
      setError(null);
      try {
        const scan = await current.scanCandidate(stagedRoot, sources);
        requireCurrent(context, 'scan');
        return scan;
      } catch (cause) {
        if (!contextIsCurrent(context)) throw obsoleteError(context, 'scan');
        setError(errorMessage(cause));
        throw cause;
      }
    },
    [captureContext, contextIsCurrent, obsoleteError, requireCurrent]
  );

  const savePendingCleanup = useCallback(
    async (
      pending: PendingConfigCleanup,
      context: OperationContext,
      operation: 'confirmation' | 'retry'
    ): Promise<void> => {
      const current = committedOptionsRef.current;
      const pendingCleanupIncarnation = pendingCleanupIncarnationRef.current;
      const cleanupIsCurrent = (): boolean =>
        pendingCleanupRef.current === pending &&
        (contextIsCurrent(context) ||
          adoptSuccessfulActivation(context, pending.stagedRoot, pendingCleanupIncarnation));
      await current.saveConfig((latest) => (cleanupIsCurrent() ? latest : null));
      if (!cleanupIsCurrent()) throw obsoleteError(context, operation);
      requireCurrent(context, operation);
      if (pendingCleanupRef.current === pending) {
        pendingCleanupRef.current = null;
        pendingCleanupIncarnationRef.current += 1;
        setCleanupPending(false);
      }
    },
    [adoptSuccessfulActivation, contextIsCurrent, obsoleteError, requireCurrent]
  );

  const confirmRoot = useCallback(
    async (stagedRoot: StagedDriveRoot): Promise<void> => {
      const context = captureContext();
      const current = committedOptionsRef.current;
      const rootKey = `${stagedRoot.root.driveId ?? 'my-drive'}:${stagedRoot.root.folderId}`;
      setError(null);
      try {
        let pending = pendingCleanupRef.current;
        if (pending?.rootKey !== rootKey) {
          if (pending !== null) await savePendingCleanup(pending, context, 'confirmation');
          const pendingCleanupIncarnation = pendingCleanupIncarnationRef.current;
          await current.drive.activateRoot(stagedRoot);
          context.activationSourceAdoptionAvailable =
            context.sourceContextOrigin === SETUP_DISCOVERY_SOURCE_CONTEXT;
          const activationIsCurrent =
            contextIsCurrent(context) ||
            adoptSuccessfulActivation(context, stagedRoot, pendingCleanupIncarnation);
          if (pendingCleanupIncarnation !== pendingCleanupIncarnationRef.current) {
            throw obsoleteError(context, 'confirmation');
          }
          pending = { rootKey, stagedRoot };
          pendingCleanupRef.current = pending;
          pendingCleanupIncarnationRef.current += 1;
          setCleanupPending(true);
          if (!activationIsCurrent) throw obsoleteError(context, 'confirmation');
          requireCurrent(context, 'confirmation');
        }
        await savePendingCleanup(pending, context, 'confirmation');
      } catch (cause) {
        if (!contextIsCurrent(context)) throw obsoleteError(context, 'confirmation');
        setError(errorMessage(cause));
        throw cause;
      }
    },
    [
      adoptSuccessfulActivation,
      captureContext,
      contextIsCurrent,
      obsoleteError,
      requireCurrent,
      savePendingCleanup,
    ]
  );

  const retry = useCallback(async (): Promise<void> => {
    const generation = ++retryGenerationRef.current;
    const context = captureContext();
    setError(null);
    try {
      const pending = pendingCleanupRef.current;
      if (pending !== null) {
        await savePendingCleanup(pending, context, 'retry');
      } else {
        await committedOptionsRef.current.drive.refresh();
        requireCurrent(context, 'retry');
      }
      if (generation === retryGenerationRef.current) setError(null);
    } catch (cause) {
      if (!contextIsCurrent(context)) throw obsoleteError(context, 'retry');
      if (generation === retryGenerationRef.current) setError(errorMessage(cause));
      throw cause;
    }
  }, [captureContext, contextIsCurrent, obsoleteError, requireCurrent, savePendingCleanup]);

  return {
    dialogOpen,
    opening,
    cleanupPending,
    error,
    openDialog,
    closeDialog,
    scanCandidate,
    confirmRoot,
    retry,
  };
}
