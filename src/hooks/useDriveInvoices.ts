import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StagedDriveRoot } from '../lib/drive/folders.js';
import type { CurrentInvoiceSource, DriveInvoiceEntry } from '../lib/drive/invoiceCatalog.js';
import {
  DriveInvoiceStore,
  DriveStoreError,
  type DriveConfigCandidate,
  type DriveRecoveryIssue,
  type DriveStoreSnapshot,
  type FinalizationInput,
} from '../lib/drive/invoiceStore.js';
import type { DriveConfigSnapshot } from '../lib/drive/configFile.js';
import type { DriveConfigPointerRead } from '../lib/drive/configPointer.js';
import type { AppConfig } from '../lib/types.js';

export type DriveInvoicesStatus =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'confirmationRequired'
  | 'loading'
  | 'ready'
  | 'offline'
  | 'blocked';

export interface DriveInvoicesState {
  status: DriveInvoicesStatus;
  configSnapshot: DriveConfigSnapshot | null;
  snapshot: DriveStoreSnapshot | null;
  error: DriveStoreError | null;
  operationKey: string | null;
  recovery: DriveRecoveryState | null;
  refresh(): Promise<void>;
  activateRoot(staged: StagedDriveRoot, initialConfig?: AppConfig): Promise<DriveStoreSnapshot>;
  resolveRoot(staged: StagedDriveRoot, initialConfig?: AppConfig): Promise<DriveRootResolution>;
  completeNewRoot(staged: StagedDriveRoot, config: AppConfig): Promise<DriveStoreSnapshot>;
  confirmRecoveryCandidate(fileId: string): Promise<DriveStoreSnapshot>;
  saveConfig(next: AppConfig): Promise<DriveConfigSnapshot>;
  finalize(input: FinalizationInput): Promise<DriveInvoiceEntry>;
  refinalize(input: FinalizationInput, entry: DriveInvoiceEntry): Promise<DriveInvoiceEntry>;
  downloadVerified(entry: DriveInvoiceEntry): Promise<Uint8Array>;
}

export type DriveRootResolution =
  | { kind: 'activated'; snapshot: DriveStoreSnapshot }
  | { kind: 'confirmationRequired'; recovery: DriveRecoveryState }
  | { kind: 'calendarRequired'; stagedRoot: StagedDriveRoot };

export interface DriveRecoveryState {
  candidates: readonly DriveConfigCandidate[];
  issues: readonly DriveRecoveryIssue[];
  previousPointerRaw: string | null;
}

type DriveInvoiceStoreController = Pick<
  DriveInvoiceStore,
  | 'bootstrap'
  | 'loadByFileId'
  | 'loadConfigByFileId'
  | 'loadInvoicesForConfig'
  | 'discoverRecovery'
  | 'inspectRecoveryFolder'
  | 'adoptRecoveryCandidate'
  | 'refresh'
  | 'rescanInvoices'
  | 'activateRoot'
  | 'saveConfig'
  | 'finalize'
  | 'refinalize'
  | 'downloadVerified'
>;

export interface UseDriveInvoicesOptions {
  store: DriveInvoiceStoreController;
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  authorizationIncarnation: number;
  discoveryEnabled: boolean;
  foregroundRefreshEnabled: boolean;
  pointer?: DriveConfigPointerRead;
  installPointer?(
    fileId: string,
    expectedRaw: string | null
  ): Promise<{ raw: string; fileId: string }>;
  legacyLocalYaml?: string;
}

interface MachineState {
  store: DriveInvoiceStoreController;
  authorizationIncarnation: number;
  sourceSignature: string;
  pointerSignature: string;
  status: DriveInvoicesStatus;
  configSnapshot: DriveConfigSnapshot | null;
  snapshot: DriveStoreSnapshot | null;
  error: DriveStoreError | null;
  operationKey: string | null;
  recovery: DriveRecoveryState | null;
}

interface SemanticContext {
  incarnation: number;
  authorizationIncarnation: number;
  sourceSignature: string;
  pointerSignature: string;
  store: DriveInvoiceStoreController;
}

interface RefreshInFlight {
  semanticIncarnation: number;
  authorizationIncarnation: number;
  sourceSignature: string;
  pointerSignature: string;
  store: DriveInvoiceStoreController;
  promise: Promise<void>;
}

interface OperationToken {
  id: number;
  key: string;
  context: SemanticContext;
}

interface MutationBehavior {
  refreshBefore?: boolean;
  refreshAfter?: boolean;
  tolerateSourceChanges?: boolean;
}

function initialState(
  store: DriveInvoiceStoreController,
  authorizationIncarnation: number,
  signature: string,
  pointerSignature: string
): MachineState {
  return {
    store,
    authorizationIncarnation,
    sourceSignature: signature,
    pointerSignature,
    status: 'loading',
    configSnapshot: null,
    snapshot: null,
    error: null,
    operationKey: null,
    recovery: null,
  };
}

function pointerSignature(pointer: DriveConfigPointerRead | undefined): string {
  return JSON.stringify(pointer);
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
  const selectedPointerSignature = pointerSignature(options.pointer);
  const mountedRef = useRef(true);
  const committedOptionsRef = useRef({ ...options, sourceSignature: signature });

  const semanticIncarnationRef = useRef(0);
  const committedSemanticRef = useRef({
    authorizationIncarnation: options.authorizationIncarnation,
    sourceSignature: signature,
    pointerSignature: selectedPointerSignature,
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
    initialState(
      options.store,
      options.authorizationIncarnation,
      signature,
      selectedPointerSignature
    )
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
      pointerSignature: pointerSignature(current.pointer),
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
      context.pointerSignature === pointerSignature(current.pointer) &&
      context.store === current.store
    );
  }, []);

  const identityIsCurrent = useCallback((context: SemanticContext): boolean => {
    const current = committedOptionsRef.current;
    return (
      mountedRef.current &&
      context.authorizationIncarnation === current.authorizationIncarnation &&
      context.pointerSignature === pointerSignature(current.pointer) &&
      context.store === current.store
    );
  }, []);

  const requireCurrentContext = useCallback(
    (context: SemanticContext): void => {
      if (!contextIsCurrent(context)) throw obsoleteContextError(context, currentContext());
    },
    [contextIsCurrent, currentContext]
  );

  const requireCurrentIdentity = useCallback(
    (context: SemanticContext): void => {
      if (!identityIsCurrent(context)) throw obsoleteContextError(context, currentContext());
    },
    [currentContext, identityIsCurrent]
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
        pointerSignature: pointerSignature(current.pointer),
        store: current.store,
      };
      const existing = refreshInFlightRef.current;
      const pointedDiscoveryInFlight =
        current.pointer?.kind === 'valid' &&
        machineRef.current.configSnapshot !== null &&
        machineRef.current.snapshot === null;
      if (
        !force &&
        existing !== null &&
        existing.authorizationIncarnation === current.authorizationIncarnation &&
        existing.pointerSignature === context.pointerSignature &&
        existing.store === current.store &&
        (pointedDiscoveryInFlight ||
          (existing.semanticIncarnation === context.incarnation &&
            existing.sourceSignature === current.sourceSignature))
      ) {
        return existing.promise;
      }

      const authorizationIncarnation = current.authorizationIncarnation;
      const store = current.store;
      const sources = current.sources;
      const previousMachine = machineRef.current;
      const hasSnapshot =
        knownConfigured ||
        (previousMachine.store === store &&
          previousMachine.authorizationIncarnation === authorizationIncarnation &&
          previousMachine.pointerSignature === context.pointerSignature &&
          previousMachine.snapshot !== null);
      const sourceOnlyRefresh =
        !force &&
        hasSnapshot &&
        previousMachine.sourceSignature !== current.sourceSignature &&
        previousMachine.store === store &&
        previousMachine.authorizationIncarnation === authorizationIncarnation &&
        previousMachine.pointerSignature === context.pointerSignature;
      const refreshGeneration = ++refreshGenerationRef.current;
      const actionErrorGeneration = actionErrorGenerationRef.current;

      updateMachine((state) => {
        if (
          state.store !== store ||
          state.authorizationIncarnation !== authorizationIncarnation ||
          state.pointerSignature !== context.pointerSignature
        ) {
          return initialState(
            store,
            authorizationIncarnation,
            current.sourceSignature,
            context.pointerSignature
          );
        }
        return {
          ...state,
          sourceSignature: current.sourceSignature,
          pointerSignature: context.pointerSignature,
          status: state.snapshot === null ? 'loading' : 'ready',
          error: null,
        };
      });

      const promise = (async () => {
        let resolvedSourceSignature = context.sourceSignature;
        try {
          let snapshot: DriveStoreSnapshot | null;
          if (hasSnapshot) {
            snapshot = sourceOnlyRefresh
              ? await store.rescanInvoices(sources)
              : await store.refresh(sources);
          } else {
            let recoveryError: DriveStoreError | null = null;
            if (current.pointer === undefined) {
              snapshot = await store.bootstrap([], current.legacyLocalYaml);
              if (snapshot !== null && sources.length > 0) {
                snapshot = await store.refresh(sources);
              }
            } else if (current.pointer.kind === 'valid') {
              try {
                const configSnapshot = await store.loadConfigByFileId(current.pointer.fileId);
                if (
                  !contextIsCurrent(context) ||
                  refreshGenerationRef.current !== refreshGeneration
                ) {
                  return;
                }
                updateMachine((state) => ({ ...state, configSnapshot }));
                snapshot = await store.loadInvoicesForConfig(configSnapshot, sources);
              } catch (cause) {
                recoveryError = normalizeError(cause);
                if (
                  recoveryError.retryable ||
                  recoveryError.code === 'authorizationRequired' ||
                  recoveryError.code === 'offline'
                ) {
                  throw recoveryError;
                }
                snapshot = null;
              }
            } else {
              snapshot = null;
            }

            if (snapshot === null) {
              const discovered = await store.discoverRecovery(current.legacyLocalYaml);
              if (
                !contextIsCurrent(context) ||
                refreshGenerationRef.current !== refreshGeneration
              ) {
                return;
              }
              const recovery: DriveRecoveryState = {
                candidates: discovered.candidates,
                issues: discovered.issues,
                previousPointerRaw: current.pointer?.raw ?? null,
              };
              updateMachine((state) => ({
                ...state,
                store,
                authorizationIncarnation,
                sourceSignature: current.sourceSignature,
                pointerSignature: context.pointerSignature,
                status: recovery.candidates.length === 0 ? 'unconfigured' : 'confirmationRequired',
                snapshot: null,
                recovery,
                error: recoveryError,
              }));
              return;
            }
            if (!identityIsCurrent(context) || refreshGenerationRef.current !== refreshGeneration) {
              const latest = committedOptionsRef.current;
              const currentMachine = machineRef.current;
              const currentGenerationConfigured =
                currentMachine.store === latest.store &&
                currentMachine.authorizationIncarnation === latest.authorizationIncarnation &&
                currentMachine.sourceSignature === latest.sourceSignature &&
                currentMachine.pointerSignature === pointerSignature(latest.pointer) &&
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
          }
          while (
            snapshot !== null &&
            identityIsCurrent(context) &&
            refreshGenerationRef.current === refreshGeneration
          ) {
            const latest = committedOptionsRef.current;
            if (latest.sourceSignature === resolvedSourceSignature) break;
            resolvedSourceSignature = latest.sourceSignature;
            snapshot = await store.rescanInvoices(latest.sources);
          }
          const latest = committedOptionsRef.current;
          const resolvedContextIsCurrent =
            identityIsCurrent(context) && latest.sourceSignature === resolvedSourceSignature;
          if (!resolvedContextIsCurrent || refreshGenerationRef.current !== refreshGeneration) {
            if (repairingStoreState) scheduleStoreRepair(store);
            return;
          }
          const preserveActionError = actionErrorGenerationRef.current !== actionErrorGeneration;
          updateMachine((state) => {
            return preserveActionError
              ? {
                  ...state,
                  store,
                  authorizationIncarnation,
                  sourceSignature: resolvedSourceSignature,
                  pointerSignature: context.pointerSignature,
                  configSnapshot: snapshot?.config ?? state.configSnapshot,
                  snapshot,
                }
              : {
                  ...state,
                  store,
                  authorizationIncarnation,
                  sourceSignature: resolvedSourceSignature,
                  pointerSignature: context.pointerSignature,
                  status: snapshot === null ? 'unconfigured' : 'ready',
                  configSnapshot: snapshot?.config ?? state.configSnapshot,
                  snapshot,
                  recovery: null,
                  error: null,
                };
          });
        } catch (cause) {
          const error = normalizeError(cause);
          if (
            identityIsCurrent(context) &&
            refreshGenerationRef.current === refreshGeneration &&
            actionErrorGenerationRef.current === actionErrorGeneration
          ) {
            const status = statusForError(error);
            const latest = committedOptionsRef.current;
            updateMachine((state) => ({
              ...state,
              store,
              authorizationIncarnation,
              sourceSignature: latest.sourceSignature,
              pointerSignature: context.pointerSignature,
              status,
              snapshot:
                status === 'unconfigured' || status === 'authorizationRequired'
                  ? (error.snapshot ?? null)
                  : state.snapshot,
              configSnapshot: error.snapshot?.config ?? state.configSnapshot,
              error,
              recovery: null,
            }));
          }
          throw error;
        }
      })();

      const inFlight: RefreshInFlight = {
        semanticIncarnation: context.incarnation,
        authorizationIncarnation,
        sourceSignature: current.sourceSignature,
        pointerSignature: context.pointerSignature,
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
    [contextIsCurrent, identityIsCurrent, scheduleStoreRepair, updateMachine]
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
        updateMachine((state) => ({
          ...state,
          status: statusForError(error),
          snapshot: error.snapshot ?? state.snapshot,
          configSnapshot: error.snapshot?.config ?? state.configSnapshot,
          error,
        }));
      }
      return error;
    },
    [contextIsCurrent, updateMachine]
  );

  const enqueueMutation = useCallback(
    <T>(
      key: string,
      mutate: (
        store: DriveInvoiceStoreController,
        requireOperationContext: () => void
      ) => Promise<T>,
      behavior: MutationBehavior = {}
    ): Promise<T> => {
      const context = currentContext();
      const execute = async (): Promise<T> => {
        const requireOperationContext = behavior.tolerateSourceChanges
          ? () => requireCurrentIdentity(context)
          : () => requireCurrentContext(context);
        requireOperationContext();
        const token = beginOperation(key, context);
        try {
          if (behavior.refreshBefore !== false) {
            try {
              await runRefresh();
            } catch (cause) {
              requireOperationContext();
              throw cause;
            }
            requireOperationContext();
          }

          let result: T;
          try {
            result = await mutate(context.store, requireOperationContext);
          } catch (cause) {
            requireOperationContext();
            throw publishActionError(
              cause,
              behavior.tolerateSourceChanges ? currentContext() : context
            );
          }
          requireOperationContext();

          if (behavior.refreshAfter === false) {
            return result;
          }
          if (behavior.tolerateSourceChanges) {
            while (true) {
              requireOperationContext();
              const refreshSignature = committedOptionsRef.current.sourceSignature;
              try {
                await runRefresh(true, true);
              } catch {
                requireOperationContext();
                if (committedOptionsRef.current.sourceSignature !== refreshSignature) continue;
                // The mutation succeeded. Its refresh error is already the current visible state.
                break;
              }
              requireOperationContext();
              if (committedOptionsRef.current.sourceSignature === refreshSignature) break;
            }
          } else {
            try {
              await runRefresh(true);
            } catch {
              requireCurrentContext(context);
              // The mutation succeeded. Its refresh error is already the current visible state.
            }
            requireCurrentContext(context);
          }
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
      requireCurrentIdentity,
      runRefresh,
    ]
  );

  const refresh = useCallback(() => runRefresh(), [runRefresh]);

  const confirmRecoveryCandidate = useCallback(
    (fileId: string): Promise<DriveStoreSnapshot> => {
      const recovery = machineRef.current.recovery;
      if (
        recovery === null ||
        !recovery.candidates.some((candidate) => candidate.fileId === fileId)
      ) {
        return Promise.reject(
          new DriveStoreError(
            'invalidState',
            'Drive recovery candidate is no longer available',
            false
          )
        );
      }
      const expectedRaw = recovery.previousPointerRaw;
      const installPointer = committedOptionsRef.current.installPointer;
      if (installPointer === undefined) {
        return Promise.reject(
          new DriveStoreError('invalidState', 'Local Drive pointer storage is unavailable', false)
        );
      }
      const legacyLocalYaml = committedOptionsRef.current.legacyLocalYaml;
      return enqueueMutation(
        `confirmRecovery:${fileId}`,
        async (store, requireOperationContext) => {
          const adopted = await store.adoptRecoveryCandidate(
            fileId,
            committedOptionsRef.current.sources,
            legacyLocalYaml
          );
          requireOperationContext();
          await installPointer(fileId, expectedRaw);
          requireOperationContext();
          updateMachine((state) => ({
            ...state,
            status: 'ready',
            configSnapshot: adopted.config,
            snapshot: adopted,
            recovery: null,
            error: null,
          }));
          return adopted;
        },
        { refreshBefore: false, refreshAfter: false }
      );
    },
    [enqueueMutation, updateMachine]
  );

  const activateRoot = useCallback(
    (staged: StagedDriveRoot, initialConfig?: AppConfig): Promise<DriveStoreSnapshot> => {
      const driveKey = staged.root.driveId ?? 'my-drive';
      const key = `activateRoot:${driveKey}:${staged.root.folderId}`;
      return enqueueMutation(
        key,
        (store) => store.activateRoot(staged, committedOptionsRef.current.sources, initialConfig),
        { refreshBefore: false, tolerateSourceChanges: true }
      );
    },
    [enqueueMutation]
  );

  const resolveRoot = useCallback(
    (staged: StagedDriveRoot, initialConfig?: AppConfig): Promise<DriveRootResolution> => {
      const driveKey = staged.root.driveId ?? 'my-drive';
      return enqueueMutation(
        `resolveRoot:${driveKey}:${staged.root.folderId}`,
        async (store, requireOperationContext) => {
          const current = committedOptionsRef.current;
          if (current.pointer === undefined || machineRef.current.snapshot !== null) {
            const activated = await store.activateRoot(
              staged,
              current.sources,
              machineRef.current.snapshot === null ? initialConfig : undefined
            );
            requireOperationContext();
            updateMachine((state) => ({
              ...state,
              status: 'ready',
              configSnapshot: activated.config,
              snapshot: activated,
              recovery: null,
              error: null,
            }));
            return { kind: 'activated', snapshot: activated };
          }
          const discovered = await store.inspectRecoveryFolder(
            staged.root.folderId,
            current.legacyLocalYaml
          );
          requireOperationContext();
          if (discovered.candidates.length > 0) {
            const recovery: DriveRecoveryState = {
              candidates: discovered.candidates,
              issues: discovered.issues,
              previousPointerRaw: current.pointer.raw,
            };
            updateMachine((state) => ({
              ...state,
              status: 'confirmationRequired',
              snapshot: null,
              recovery,
              error: null,
            }));
            return { kind: 'confirmationRequired', recovery };
          }
          return { kind: 'calendarRequired', stagedRoot: staged };
        },
        { refreshBefore: false, refreshAfter: false, tolerateSourceChanges: true }
      );
    },
    [enqueueMutation, updateMachine]
  );

  const completeNewRoot = useCallback(
    (staged: StagedDriveRoot, config: AppConfig): Promise<DriveStoreSnapshot> => {
      const driveKey = staged.root.driveId ?? 'my-drive';
      return enqueueMutation(
        `completeNewRoot:${driveKey}:${staged.root.folderId}`,
        async (store, requireOperationContext) => {
          const current = committedOptionsRef.current;
          const activated = await store.activateRoot(staged, current.sources, config);
          requireOperationContext();
          if (current.installPointer !== undefined && current.pointer !== undefined) {
            await current.installPointer(activated.config.file.id, current.pointer.raw);
            requireOperationContext();
          }
          updateMachine((state) => ({
            ...state,
            status: 'ready',
            configSnapshot: activated.config,
            snapshot: activated,
            recovery: null,
            error: null,
          }));
          return activated;
        },
        { refreshBefore: false, refreshAfter: false, tolerateSourceChanges: true }
      );
    },
    [enqueueMutation, updateMachine]
  );

  const saveConfig = useCallback(
    (next: AppConfig): Promise<DriveConfigSnapshot> => {
      const snapshot = machineRef.current.snapshot;
      if (snapshot === null) {
        return Promise.reject(
          new DriveStoreError('unconfigured', 'Drive invoice storage is not configured', false)
        );
      }
      return enqueueMutation('saveConfig', (store) =>
        store
          .saveConfig(snapshot, next, committedOptionsRef.current.sources)
          .then((result) => result.config)
      );
    },
    [enqueueMutation]
  );

  const finalize = useCallback(
    (input: FinalizationInput): Promise<DriveInvoiceEntry> =>
      enqueueMutation(`finalize:${input.key.studioSlug}:${input.key.monthKey}`, (store) =>
        store.finalize(input).then((result) => result.entry)
      ),
    [enqueueMutation]
  );

  const refinalize = useCallback(
    (input: FinalizationInput, entry: DriveInvoiceEntry): Promise<DriveInvoiceEntry> =>
      enqueueMutation(`refinalize:${entry.file.id}`, (store) =>
        store.refinalize(input, entry).then((result) => result.entry)
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
    const identityChanged =
      committed.authorizationIncarnation !== options.authorizationIncarnation ||
      committed.pointerSignature !== selectedPointerSignature ||
      committed.store !== options.store;
    if (identityChanged || committed.sourceSignature !== signature) {
      committedSemanticRef.current = {
        authorizationIncarnation: options.authorizationIncarnation,
        sourceSignature: signature,
        pointerSignature: selectedPointerSignature,
        store: options.store,
      };
      semanticIncarnationRef.current += 1;
      if (identityChanged) refreshInFlightRef.current = null;
    }
  });

  useLayoutEffect(() => {
    if (
      machineRef.current.store !== options.store ||
      machineRef.current.authorizationIncarnation !== options.authorizationIncarnation ||
      machineRef.current.pointerSignature !== selectedPointerSignature
    ) {
      const reset = initialState(
        options.store,
        options.authorizationIncarnation,
        signature,
        selectedPointerSignature
      );
      machineRef.current = reset;
      setMachine(reset);
    }
  }, [options.authorizationIncarnation, options.store, selectedPointerSignature, signature]);

  useEffect(() => {
    if (options.discoveryEnabled) void runRefresh().catch(() => undefined);
  }, [
    options.discoveryEnabled,
    options.authorizationIncarnation,
    options.store,
    selectedPointerSignature,
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
    machine.pointerSignature === selectedPointerSignature
      ? machine.sourceSignature === signature
        ? machine
        : {
            ...machine,
            sourceSignature: signature,
            status: machine.snapshot === null ? ('loading' as const) : ('ready' as const),
          }
      : initialState(
          options.store,
          options.authorizationIncarnation,
          signature,
          selectedPointerSignature
        );

  return {
    status: visibleMachine.status,
    configSnapshot: visibleMachine.configSnapshot,
    snapshot: visibleMachine.snapshot,
    error: visibleMachine.error,
    operationKey: visibleMachine.operationKey,
    recovery: visibleMachine.recovery,
    refresh,
    activateRoot,
    resolveRoot,
    completeNewRoot,
    confirmRecoveryCandidate,
    saveConfig,
    finalize,
    refinalize,
    downloadVerified,
  };
}
