import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StagedDriveRoot } from '../lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceScan } from '../lib/drive/invoiceCatalog.js';
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
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  scanCandidate(
    stagedRoot: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveInvoiceScan>;
}

interface CommittedOptions extends UseDriveFolderControllerOptions {
  sourceSignature: string;
}

interface OperationContext {
  semanticIncarnation: number;
  sourceIncarnation: number;
  authorizationIncarnation: number;
  session: number;
}

type OperationName = 'opening' | 'scan' | 'confirmation' | 'retry';

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
  const semanticIncarnationRef = useRef(0);
  const sourceIncarnationRef = useRef(0);
  const sessionRef = useRef(0);
  const retryGenerationRef = useRef(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [opening, setOpening] = useState(false);
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
      setError(null);
    }
    committedIdentityRef.current = {
      authorizationIncarnation: options.authorizationIncarnation,
      sourceSignature: signature,
    };
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

  const operationIdentityIsCurrent = useCallback((context: OperationContext): boolean => {
    const current = committedOptionsRef.current;
    return (
      mountedRef.current &&
      context.session === sessionRef.current &&
      context.authorizationIncarnation === current.authorizationIncarnation
    );
  }, []);

  const identityObsoleteError = useCallback(
    (context: OperationContext, operation: OperationName): Error => {
      const current = committedOptionsRef.current;
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

  const openDialog = useCallback(async (): Promise<void> => {
    const session = ++sessionRef.current;
    const context = { ...captureContext(), session };
    const current = committedOptionsRef.current;
    setDialogOpen(false);
    setOpening(true);
    setError(null);
    let discoveryMayChangeSources = false;
    try {
      if (!current.hasDriveAuthorization || current.drive.status === 'authorizationRequired') {
        await current.authorizeDrive();
        if (!contextIsCurrent(context)) adoptSuccessfulAuthorization(context);
        requireCurrent(context, 'opening');
        discoveryMayChangeSources = true;
        await committedOptionsRef.current.drive.refresh();
        if (!operationIdentityIsCurrent(context)) {
          throw identityObsoleteError(context, 'opening');
        }
      }
      if (discoveryMayChangeSources) {
        if (!operationIdentityIsCurrent(context)) {
          throw identityObsoleteError(context, 'opening');
        }
      } else {
        requireCurrent(context, 'opening');
      }
      setDialogOpen(true);
    } catch (cause) {
      if (
        discoveryMayChangeSources ? operationIdentityIsCurrent(context) : contextIsCurrent(context)
      ) {
        setError(errorMessage(cause));
      }
    } finally {
      if (
        discoveryMayChangeSources ? operationIdentityIsCurrent(context) : contextIsCurrent(context)
      ) {
        setOpening(false);
      }
    }
  }, [
    adoptSuccessfulAuthorization,
    captureContext,
    contextIsCurrent,
    identityObsoleteError,
    operationIdentityIsCurrent,
    requireCurrent,
  ]);

  const closeDialog = useCallback((): void => {
    sessionRef.current += 1;
    setDialogOpen(false);
    setOpening(false);
    setError(null);
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

  const confirmRoot = useCallback(
    async (stagedRoot: StagedDriveRoot): Promise<void> => {
      const context = captureContext();
      const current = committedOptionsRef.current;
      setError(null);
      try {
        const activated = await current.drive.activateRoot(
          stagedRoot,
          current.drive.status === 'unconfigured' ? current.config : undefined
        );
        if (!operationIdentityIsCurrent(context)) {
          throw identityObsoleteError(context, 'confirmation');
        }
        if (
          activated.stagedRoot.root.folderId !== stagedRoot.root.folderId ||
          activated.stagedRoot.root.driveId !== stagedRoot.root.driveId ||
          activated.stagedRoot.finalFolder.id !== stagedRoot.finalFolder.id ||
          activated.config.file.parents.length !== 1 ||
          activated.config.file.parents[0] !== stagedRoot.root.folderId
        ) {
          throw new Error('Drive activated a different invoice folder than the selected folder');
        }
      } catch (cause) {
        if (!operationIdentityIsCurrent(context)) {
          throw identityObsoleteError(context, 'confirmation');
        }
        setError(errorMessage(cause));
        throw cause;
      }
    },
    [captureContext, identityObsoleteError, operationIdentityIsCurrent]
  );

  const retry = useCallback(async (): Promise<void> => {
    const generation = ++retryGenerationRef.current;
    const context = captureContext();
    setError(null);
    try {
      await committedOptionsRef.current.drive.refresh();
      requireCurrent(context, 'retry');
      if (generation === retryGenerationRef.current) setError(null);
    } catch (cause) {
      if (!contextIsCurrent(context)) throw obsoleteError(context, 'retry');
      if (generation === retryGenerationRef.current) setError(errorMessage(cause));
      throw cause;
    }
  }, [captureContext, contextIsCurrent, obsoleteError, requireCurrent]);

  return {
    dialogOpen,
    opening,
    cleanupPending: false,
    error,
    openDialog,
    closeDialog,
    scanCandidate,
    confirmRoot,
    retry,
  };
}
