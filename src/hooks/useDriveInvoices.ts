import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StagedDriveRoot } from '../lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceEntry } from '../lib/drive/invoiceCatalog.js';
import {
  DriveInvoiceStore,
  DriveStoreError,
  type DriveStoreSnapshot,
  type FinalizationInput,
} from '../lib/drive/invoiceStore.js';

export type DriveInvoicesStatus =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'loading'
  | 'ready'
  | 'offline'
  | 'blocked';

export interface DriveInvoicesState {
  status: DriveInvoicesStatus;
  snapshot: DriveStoreSnapshot | null;
  error: DriveStoreError | null;
  operationKey: string | null;
  refresh(): Promise<void>;
  activateRoot(staged: StagedDriveRoot, legacyLastInvoice?: string): Promise<void>;
  finalize(input: FinalizationInput): Promise<DriveInvoiceEntry>;
  refinalize(input: FinalizationInput, entry: DriveInvoiceEntry): Promise<DriveInvoiceEntry>;
  recoverReservation(): Promise<void>;
  downloadVerified(entry: DriveInvoiceEntry): Promise<Uint8Array>;
}

type DriveInvoiceStoreController = Pick<
  DriveInvoiceStore,
  | 'bootstrap'
  | 'refresh'
  | 'activateRoot'
  | 'finalize'
  | 'refinalize'
  | 'recoverReservation'
  | 'downloadVerified'
>;

export interface UseDriveInvoicesOptions {
  store: DriveInvoiceStoreController;
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  authorizationIncarnation: number;
  discoveryEnabled: boolean;
  foregroundRefreshEnabled: boolean;
}

interface MachineState {
  store: DriveInvoiceStoreController;
  authorizationIncarnation: number;
  sourceSignature: string;
  status: DriveInvoicesStatus;
  snapshot: DriveStoreSnapshot | null;
  error: DriveStoreError | null;
  operationKey: string | null;
}

interface SemanticContext {
  incarnation: number;
  authorizationIncarnation: number;
  sourceSignature: string;
  store: DriveInvoiceStoreController;
}

interface RefreshInFlight {
  semanticIncarnation: number;
  authorizationIncarnation: number;
  sourceSignature: string;
  store: DriveInvoiceStoreController;
  promise: Promise<void>;
}

interface OperationToken {
  id: number;
  key: string;
  context: SemanticContext;
}

function initialState(
  store: DriveInvoiceStoreController,
  authorizationIncarnation: number,
  signature: string
): MachineState {
  return {
    store,
    authorizationIncarnation,
    sourceSignature: signature,
    status: 'loading',
    snapshot: null,
    error: null,
    operationKey: null,
  };
}

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

function normalizeError(error: unknown): DriveStoreError {
  if (error instanceof DriveStoreError) return error;
  return new DriveStoreError(
    'invalidState',
    error instanceof Error ? error.message : String(error),
    false
  );
}

function statusForError(error: DriveStoreError): DriveInvoicesStatus {
  switch (error.code) {
    case 'authorizationRequired':
      return 'authorizationRequired';
    case 'unconfigured':
      return 'unconfigured';
    case 'offline':
      return 'offline';
    default:
      return 'blocked';
  }
}

function recoveryErrorForSnapshot(snapshot: DriveStoreSnapshot | null): DriveStoreError | null {
  const reservation = snapshot?.control.control.reservation;
  if (reservation == null) return null;
  return new DriveStoreError(
    'recoveryRequired',
    `Recover the active ${reservation.invoiceNumber} reservation for ${reservation.studioSlug}/${reservation.month}`,
    false
  );
}

function obsoleteContextError(context: SemanticContext, current: SemanticContext): DriveStoreError {
  if (
    context.authorizationIncarnation !== current.authorizationIncarnation ||
    context.store !== current.store
  ) {
    return new DriveStoreError(
      'authorizationRequired',
      'Google authorization changed before the Drive operation completed',
      true
    );
  }
  return new DriveStoreError(
    'invalidState',
    'Current invoice sources changed before the Drive operation completed',
    true
  );
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function useDriveInvoices(options: UseDriveInvoicesOptions): DriveInvoicesState {
  const signature = sourceSignature(options.sourceContextKey, options.sources);
  const mountedRef = useRef(true);
  const committedOptionsRef = useRef({ ...options, sourceSignature: signature });

  const semanticIncarnationRef = useRef(0);
  const committedSemanticRef = useRef({
    authorizationIncarnation: options.authorizationIncarnation,
    sourceSignature: signature,
    store: options.store,
  });
  const refreshInFlightRef = useRef<RefreshInFlight | null>(null);
  const refreshGenerationRef = useRef(0);
  const repairRequestedStoreRef = useRef<DriveInvoiceStoreController | null>(null);
  const repairScheduledRef = useRef(false);
  const repairInFlightRef = useRef(false);
  const actionErrorGenerationRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const operationSequenceRef = useRef(0);
  const currentOperationRef = useRef<OperationToken | null>(null);
  const [machine, setMachine] = useState<MachineState>(() =>
    initialState(options.store, options.authorizationIncarnation, signature)
  );
  const [repairWakeup, setRepairWakeup] = useState(0);
  const machineRef = useRef(machine);
  machineRef.current = machine;

  const updateMachine = useCallback((update: (current: MachineState) => MachineState): void => {
    if (!mountedRef.current) return;
    setMachine((current) => {
      const next = update(current);
      machineRef.current = next;
      return next;
    });
  }, []);

  const currentContext = useCallback((): SemanticContext => {
    const current = committedOptionsRef.current;
    return {
      incarnation: semanticIncarnationRef.current,
      authorizationIncarnation: current.authorizationIncarnation,
      sourceSignature: current.sourceSignature,
      store: current.store,
    };
  }, []);

  const contextIsCurrent = useCallback((context: SemanticContext): boolean => {
    const current = committedOptionsRef.current;
    return (
      mountedRef.current &&
      context.incarnation === semanticIncarnationRef.current &&
      context.authorizationIncarnation === current.authorizationIncarnation &&
      context.sourceSignature === current.sourceSignature &&
      context.store === current.store
    );
  }, []);

  const requireCurrentContext = useCallback(
    (context: SemanticContext): void => {
      if (!contextIsCurrent(context)) throw obsoleteContextError(context, currentContext());
    },
    [contextIsCurrent, currentContext]
  );

  const scheduleStoreRepair = useCallback((store: DriveInvoiceStoreController): void => {
    if (!mountedRef.current || committedOptionsRef.current.store !== store) return;
    repairRequestedStoreRef.current = store;
    if (repairInFlightRef.current || repairScheduledRef.current) return;
    repairScheduledRef.current = true;
    setRepairWakeup((current) => current + 1);
  }, []);

  const runRefresh: (
    force?: boolean,
    knownConfigured?: boolean,
    repairingStoreState?: boolean
  ) => Promise<void> = useCallback(
    (force = false, knownConfigured = false, repairingStoreState = false): Promise<void> => {
      const current = committedOptionsRef.current;
      const context: SemanticContext = {
        incarnation: semanticIncarnationRef.current,
        authorizationIncarnation: current.authorizationIncarnation,
        sourceSignature: current.sourceSignature,
        store: current.store,
      };
      const existing = refreshInFlightRef.current;
      if (
        !force &&
        existing !== null &&
        existing.semanticIncarnation === context.incarnation &&
        existing.authorizationIncarnation === current.authorizationIncarnation &&
        existing.sourceSignature === current.sourceSignature &&
        existing.store === current.store
      ) {
        return existing.promise;
      }

      const authorizationIncarnation = current.authorizationIncarnation;
      const store = current.store;
      const sources = current.sources;
      const hasSnapshot =
        knownConfigured ||
        (machineRef.current.store === store &&
          machineRef.current.authorizationIncarnation === authorizationIncarnation &&
          machineRef.current.snapshot !== null);
      const refreshGeneration = ++refreshGenerationRef.current;
      const actionErrorGeneration = actionErrorGenerationRef.current;

      updateMachine((state) => {
        if (
          state.store !== store ||
          state.authorizationIncarnation !== authorizationIncarnation ||
          state.sourceSignature !== current.sourceSignature
        ) {
          return initialState(store, authorizationIncarnation, current.sourceSignature);
        }
        return {
          ...state,
          status: 'loading',
          error: null,
        };
      });

      const promise = (async () => {
        try {
          let snapshot: DriveStoreSnapshot | null;
          if (hasSnapshot) {
            snapshot = await store.refresh(sources);
          } else {
            snapshot = await store.bootstrap([]);
            if (!contextIsCurrent(context) || refreshGenerationRef.current !== refreshGeneration) {
              const latest = committedOptionsRef.current;
              const currentMachine = machineRef.current;
              const currentGenerationConfigured =
                currentMachine.store === latest.store &&
                currentMachine.authorizationIncarnation === latest.authorizationIncarnation &&
                currentMachine.sourceSignature === latest.sourceSignature &&
                currentMachine.snapshot !== null;
              if (
                mountedRef.current &&
                latest.store === store &&
                (snapshot !== null || currentGenerationConfigured)
              ) {
                scheduleStoreRepair(store);
              }
              return;
            }
            if (snapshot !== null && sources.length > 0) {
              snapshot = await store.refresh(sources);
            }
          }
          if (!contextIsCurrent(context) || refreshGenerationRef.current !== refreshGeneration) {
            if (repairingStoreState) scheduleStoreRepair(store);
            return;
          }
          const preserveActionError = actionErrorGenerationRef.current !== actionErrorGeneration;
          const recoveryError = recoveryErrorForSnapshot(snapshot);
          updateMachine((state) => {
            if (recoveryError !== null) {
              return {
                ...state,
                store,
                authorizationIncarnation,
                sourceSignature: current.sourceSignature,
                status: 'blocked',
                snapshot,
                error: recoveryError,
              };
            }
            return preserveActionError
              ? {
                  ...state,
                  store,
                  authorizationIncarnation,
                  sourceSignature: current.sourceSignature,
                  snapshot,
                }
              : {
                  ...state,
                  store,
                  authorizationIncarnation,
                  sourceSignature: current.sourceSignature,
                  status: snapshot === null ? 'unconfigured' : 'ready',
                  snapshot,
                  error: null,
                };
          });
        } catch (cause) {
          const error = normalizeError(cause);
          if (
            contextIsCurrent(context) &&
            refreshGenerationRef.current === refreshGeneration &&
            actionErrorGenerationRef.current === actionErrorGeneration
          ) {
            updateMachine((state) => ({
              ...state,
              store,
              authorizationIncarnation,
              sourceSignature: current.sourceSignature,
              status: statusForError(error),
              error,
            }));
          }
          throw error;
        }
      })();

      const inFlight: RefreshInFlight = {
        semanticIncarnation: context.incarnation,
        authorizationIncarnation,
        sourceSignature: current.sourceSignature,
        store,
        promise,
      };
      refreshInFlightRef.current = inFlight;
      void promise.then(
        () => {
          if (refreshInFlightRef.current === inFlight) refreshInFlightRef.current = null;
        },
        () => {
          if (refreshInFlightRef.current === inFlight) refreshInFlightRef.current = null;
        }
      );
      return promise;
    },
    [contextIsCurrent, scheduleStoreRepair, updateMachine]
  );

  useEffect(() => {
    if (repairWakeup === 0) return;
    repairScheduledRef.current = false;
    const store = repairRequestedStoreRef.current;
    repairRequestedStoreRef.current = null;
    if (store === null || !mountedRef.current || committedOptionsRef.current.store !== store) {
      return;
    }

    repairInFlightRef.current = true;
    void runRefresh(true, true, true)
      .catch(() => undefined)
      .finally(() => {
        repairInFlightRef.current = false;
        const pendingStore = repairRequestedStoreRef.current;
        if (
          pendingStore !== null &&
          mountedRef.current &&
          committedOptionsRef.current.store === pendingStore &&
          !repairScheduledRef.current
        ) {
          repairScheduledRef.current = true;
          setRepairWakeup((current) => current + 1);
        }
      });
  }, [repairWakeup, runRefresh]);

  const beginOperation = useCallback(
    (key: string, context: SemanticContext): OperationToken => {
      const token = {
        id: ++operationSequenceRef.current,
        key,
        context,
      };
      currentOperationRef.current = token;
      updateMachine((state) =>
        state.authorizationIncarnation === context.authorizationIncarnation
          ? { ...state, operationKey: key }
          : state
      );
      return token;
    },
    [updateMachine]
  );

  const endOperation = useCallback(
    (token: OperationToken): void => {
      if (currentOperationRef.current?.id !== token.id) return;
      currentOperationRef.current = null;
      updateMachine((state) =>
        state.authorizationIncarnation === token.context.authorizationIncarnation &&
        state.operationKey === token.key
          ? { ...state, operationKey: null }
          : state
      );
    },
    [updateMachine]
  );

  const publishActionError = useCallback(
    (cause: unknown, context: SemanticContext): DriveStoreError => {
      const error = normalizeError(cause);
      if (contextIsCurrent(context)) {
        actionErrorGenerationRef.current += 1;
        updateMachine((state) => ({ ...state, status: statusForError(error), error }));
      }
      return error;
    },
    [contextIsCurrent, updateMachine]
  );

  const enqueueMutation = useCallback(
    <T>(
      key: string,
      mutate: (store: DriveInvoiceStoreController) => Promise<T>,
      refreshBefore = true
    ): Promise<T> => {
      const context = currentContext();
      const execute = async (): Promise<T> => {
        requireCurrentContext(context);
        const token = beginOperation(key, context);
        try {
          if (refreshBefore) {
            try {
              await runRefresh();
            } catch (cause) {
              requireCurrentContext(context);
              throw cause;
            }
            requireCurrentContext(context);
          }

          let result: T;
          try {
            result = await mutate(context.store);
          } catch (cause) {
            requireCurrentContext(context);
            throw publishActionError(cause, context);
          }
          requireCurrentContext(context);

          try {
            await runRefresh(true);
          } catch {
            requireCurrentContext(context);
            // The mutation succeeded. Its refresh error is already the current visible state.
          }
          requireCurrentContext(context);
          return result;
        } finally {
          endOperation(token);
        }
      };

      const queued = mutationQueueRef.current.then(execute, execute);
      mutationQueueRef.current = queued.then(
        () => undefined,
        () => undefined
      );
      return queued;
    },
    [
      beginOperation,
      currentContext,
      endOperation,
      publishActionError,
      requireCurrentContext,
      runRefresh,
    ]
  );

  const refresh = useCallback(() => runRefresh(), [runRefresh]);

  const activateRoot = useCallback(
    (staged: StagedDriveRoot, legacyLastInvoice?: string): Promise<void> => {
      const driveKey = staged.root.driveId ?? 'my-drive';
      const key = `activateRoot:${driveKey}:${staged.root.folderId}`;
      return enqueueMutation(
        key,
        (store) =>
          store
            .activateRoot(staged, committedOptionsRef.current.sources, legacyLastInvoice)
            .then(() => undefined),
        false
      );
    },
    [enqueueMutation]
  );

  const finalize = useCallback(
    (input: FinalizationInput): Promise<DriveInvoiceEntry> =>
      enqueueMutation(`finalize:${input.key.studioSlug}:${input.key.monthKey}`, (store) =>
        store.finalize(input)
      ),
    [enqueueMutation]
  );

  const refinalize = useCallback(
    (input: FinalizationInput, entry: DriveInvoiceEntry): Promise<DriveInvoiceEntry> =>
      enqueueMutation(`refinalize:${entry.file.id}`, (store) => store.refinalize(input, entry)),
    [enqueueMutation]
  );

  const recoverReservation = useCallback(
    (): Promise<void> =>
      enqueueMutation('recoverReservation', (store) =>
        store.recoverReservation(committedOptionsRef.current.sources).then(() => undefined)
      ),
    [enqueueMutation]
  );

  const downloadVerified = useCallback(
    async (entry: DriveInvoiceEntry): Promise<Uint8Array> => {
      const context = currentContext();
      requireCurrentContext(context);
      const token = beginOperation(`download:${entry.file.id}`, context);
      try {
        let bytes: Uint8Array;
        try {
          bytes = await context.store.downloadVerified(entry);
        } catch (cause) {
          requireCurrentContext(context);
          throw publishActionError(cause, context);
        }
        requireCurrentContext(context);
        return bytes;
      } finally {
        endOperation(token);
      }
    },
    [beginOperation, currentContext, endOperation, publishActionError, requireCurrentContext]
  );

  useLayoutEffect(() => {
    const committed = committedSemanticRef.current;
    committedOptionsRef.current = { ...options, sourceSignature: signature };
    if (
      committed.authorizationIncarnation !== options.authorizationIncarnation ||
      committed.sourceSignature !== signature ||
      committed.store !== options.store
    ) {
      committedSemanticRef.current = {
        authorizationIncarnation: options.authorizationIncarnation,
        sourceSignature: signature,
        store: options.store,
      };
      semanticIncarnationRef.current += 1;
      refreshInFlightRef.current = null;
    }
  });

  useLayoutEffect(() => {
    if (
      machineRef.current.store !== options.store ||
      machineRef.current.authorizationIncarnation !== options.authorizationIncarnation
    ) {
      const reset = initialState(options.store, options.authorizationIncarnation, signature);
      machineRef.current = reset;
      setMachine(reset);
    }
  }, [options.authorizationIncarnation, options.store, signature]);

  useEffect(() => {
    if (options.discoveryEnabled) void runRefresh().catch(() => undefined);
  }, [
    options.discoveryEnabled,
    options.authorizationIncarnation,
    options.store,
    signature,
    runRefresh,
  ]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (committedOptionsRef.current.foregroundRefreshEnabled && isVisible()) {
        void runRefresh().catch(() => undefined);
      }
    };
    const onFocus = (): void => {
      if (committedOptionsRef.current.foregroundRefreshEnabled && isVisible()) {
        void runRefresh().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [runRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      refreshInFlightRef.current = null;
      repairRequestedStoreRef.current = null;
      repairScheduledRef.current = false;
      currentOperationRef.current = null;
    };
  }, []);

  const visibleMachine =
    machine.store === options.store &&
    machine.authorizationIncarnation === options.authorizationIncarnation &&
    machine.sourceSignature === signature
      ? machine
      : initialState(options.store, options.authorizationIncarnation, signature);

  return {
    status: visibleMachine.status,
    snapshot: visibleMachine.snapshot,
    error: visibleMachine.error,
    operationKey: visibleMachine.operationKey,
    refresh,
    activateRoot,
    finalize,
    refinalize,
    recoverReservation,
    downloadVerified,
  };
}
