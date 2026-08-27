import { useCallback, useEffect, useRef, useState } from 'react';
import type { DriveConfigSnapshot } from '../lib/drive/configFile.js';
import { DriveStoreError } from '../lib/drive/invoiceStore.js';
import { DEFAULT_CONFIG } from '../lib/config/defaults.js';
import { parseLegacyLocalConfigYaml, validateConfig } from '../lib/config/schema.js';
import type { AppConfig } from '../lib/types.js';

export interface UseConfigOptions {
  remote: DriveConfigSnapshot | null;
  unconfigured: boolean;
  legacyLocalYaml?: string;
  saveRemote(next: AppConfig): Promise<DriveConfigSnapshot>;
}

function legacyDraft(raw: string | undefined): { config: AppConfig; error: string | null } {
  if (raw === undefined) return { config: DEFAULT_CONFIG, error: null };
  try {
    const legacy = parseLegacyLocalConfigYaml(raw);
    if (legacy.lastInvoice === undefined) return { config: legacy.config, error: null };
    const [sequence, year] = legacy.lastInvoice.split('/');
    return {
      config: {
        ...legacy.config,
        invoiceSequenceByYear: { [year]: Number(sequence) },
      },
      error: null,
    };
  } catch (cause) {
    return {
      config: DEFAULT_CONFIG,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function useConfig(options: UseConfigOptions) {
  const fallback = legacyDraft(options.legacyLocalYaml);
  const initial = options.remote?.config ?? fallback.config;
  const [config, setConfig] = useState<AppConfig>(initial);
  const [isDirty, setIsDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(
    options.remote === null && options.unconfigured ? fallback.error : null
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const configRef = useRef(config);
  const dirtyRef = useRef(false);
  const remoteFileRef = useRef(options.remote?.file.id ?? null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const publish = useCallback((next: AppConfig, dirty: boolean): void => {
    configRef.current = next;
    dirtyRef.current = dirty;
    setConfig(next);
    setIsDirty(dirty);
  }, []);

  useEffect(() => {
    const fileId = options.remote?.file.id ?? null;
    const firstRemote = remoteFileRef.current === null && fileId !== null;
    remoteFileRef.current = fileId;
    if (options.remote !== null && (!dirtyRef.current || firstRemote)) {
      publish(options.remote.config, false);
      setLoadError(null);
      setSaveError(null);
    } else if (options.unconfigured && fileId === null && !dirtyRef.current) {
      const local = legacyDraft(options.legacyLocalYaml);
      publish(local.config, false);
      setLoadError(local.error);
    }
  }, [options.legacyLocalYaml, options.remote, options.unconfigured, publish]);

  const updateConfig = useCallback(
    (next: AppConfig): void => publish(validateConfig(next), true),
    [publish]
  );

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const result = writeQueueRef.current.then(operation, operation);
    writeQueueRef.current = result.catch(() => undefined);
    return result;
  }, []);

  const persist = useCallback(
    (throwOnFailure: boolean): Promise<void> =>
      enqueue(async () => {
        setSaveError(null);
        const next = validateConfig(configRef.current);
        if (options.unconfigured) {
          publish(next, true);
          return;
        }
        try {
          const saved = await options.saveRemote(next);
          publish(saved.config, false);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          setSaveError(error.message);
          if (cause instanceof DriveStoreError && cause.code === 'conflict') {
            const fresh = cause.snapshot?.config.config ?? options.remote?.config;
            if (fresh !== undefined) publish(fresh, false);
          }
          if (throwOnFailure) throw cause;
        }
      }),
    [enqueue, options, publish]
  );

  const save = useCallback(() => persist(false), [persist]);
  const saveOrThrow = useCallback(() => persist(true), [persist]);

  const saveUpdateOrThrow = useCallback(
    (update: (current: AppConfig) => AppConfig | null): Promise<void> =>
      enqueue(async () => {
        const requested = update(configRef.current);
        if (requested === null) return;
        const next = validateConfig(requested);
        publish(next, true);
        if (options.unconfigured) return;
        setSaveError(null);
        try {
          const saved = await options.saveRemote(next);
          publish(saved.config, false);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          setSaveError(error.message);
          if (cause instanceof DriveStoreError && cause.code === 'conflict') {
            const fresh = cause.snapshot?.config.config ?? options.remote?.config;
            if (fresh !== undefined) publish(fresh, false);
          }
          throw cause;
        }
      }),
    [enqueue, options, publish]
  );

  return {
    config,
    isDirty,
    isLoading: options.remote === null && !options.unconfigured,
    loadError,
    saveError,
    updateConfig,
    save,
    saveOrThrow,
    saveUpdateOrThrow,
  };
}
