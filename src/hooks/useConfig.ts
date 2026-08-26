import { useState, useEffect, useCallback, useRef } from 'react';
import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AppConfig } from '../lib/types';
import { validateConfig } from '../lib/config/schema';
import { DEFAULT_CONFIG } from '../lib/config/defaults';
import { logInfo, logError } from '../lib/logger';
import { invoke } from '@tauri-apps/api/core';

const CONFIG_FILE = 'config.yaml';
const BASE_DIR = BaseDirectory.AppData;

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const configRef = useRef(config);
  const configRevisionRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const publishConfig = useCallback((next: AppConfig, dirty: boolean): void => {
    configRef.current = next;
    configRevisionRef.current += 1;
    setConfig(next);
    setIsDirty(dirty);
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const configPath = await invoke<string | null>('get_config_path');
      const fileExists = configPath
        ? await exists(configPath)
        : await exists(CONFIG_FILE, { baseDir: BASE_DIR });
      if (!fileExists) {
        logInfo('Config file not found — using defaults');
        publishConfig(DEFAULT_CONFIG, false);
      } else {
        const raw = configPath
          ? await readTextFile(configPath)
          : await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
        const parsed = parseYaml(raw);
        publishConfig(validateConfig(parsed), false);
        logInfo('Config loaded from disk');
      }
    } catch (e) {
      logError(`Config load failed: ${e}`);
      setLoadError(String(e));
    } finally {
      setIsLoading(false);
      setIsDirty(false);
    }
  }, [publishConfig]);

  useEffect(() => {
    load();
  }, [load]);

  const updateConfig = useCallback(
    (next: AppConfig) => {
      publishConfig(next, true);
    },
    [publishConfig]
  );

  const enqueueWrite = useCallback((operation: () => Promise<void>): Promise<void> => {
    const result = writeQueueRef.current.then(operation, operation);
    writeQueueRef.current = result.catch(() => undefined);
    return result;
  }, []);

  function validatedConfig(raw: AppConfig): AppConfig {
    // Sanitize: JSON round-trip strips Symbol values/keys that yaml can't serialize.
    // Also log any symbols found so we can diagnose the root cause.
    const symbols: string[] = [];
    function scanSymbols(obj: unknown, path: string) {
      if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'symbol') symbols.push(`${path} = Symbol`);
        return;
      }
      for (const k of Object.getOwnPropertySymbols(obj))
        symbols.push(`${path}[${String(k)}] (key)`);
      for (const [k, v] of Object.entries(obj as Record<string, unknown>))
        scanSymbols(v, `${path}.${k}`);
    }
    scanSymbols(raw, 'config');
    if (symbols.length > 0)
      logError(`Symbol values found in config before save: ${symbols.join('; ')}`);
    return validateConfig(raw);
  }

  async function configPath(): Promise<string | null> {
    return invoke<string | null>('get_config_path');
  }

  async function writeConfig(path: string | null, next: AppConfig): Promise<void> {
    const serialized = stringifyYaml(next);
    if (path) {
      await writeTextFile(path, serialized);
    } else {
      await writeTextFile(CONFIG_FILE, serialized, { baseDir: BASE_DIR });
    }
  }

  async function repairLatestConfig(path: string | null): Promise<void> {
    while (true) {
      const revision = configRevisionRef.current;
      const latest = validatedConfig(configRef.current);
      await writeConfig(path, latest);
      if (revision === configRevisionRef.current) return;
    }
  }

  const persist = useCallback(
    async (next?: AppConfig, throwOnFailure = false) => {
      return enqueueWrite(async () => {
        setSaveError(null);
        logInfo(`Saving config to ${CONFIG_FILE}`);
        try {
          const path = await configPath();
          let revision = configRevisionRef.current;
          let toSave = validatedConfig(next ?? configRef.current);
          while (true) {
            await writeConfig(path, toSave);
            if (revision === configRevisionRef.current) break;
            revision = configRevisionRef.current;
            toSave = validatedConfig(configRef.current);
          }
          publishConfig(toSave, false);
          logInfo('Config saved successfully');
        } catch (e) {
          logError(`Config save failed: ${e}`);
          setSaveError(String(e));
          if (throwOnFailure) throw e;
        }
      });
    },
    [enqueueWrite, publishConfig]
  );

  const saveUpdateOrThrow = useCallback(
    (update: (current: AppConfig) => AppConfig | null): Promise<void> => {
      return enqueueWrite(async () => {
        setSaveError(null);
        logInfo(`Saving config to ${CONFIG_FILE}`);
        try {
          const path = await configPath();
          while (true) {
            const revision = configRevisionRef.current;
            const requested = update(configRef.current);
            if (requested === null) return;
            const toSave = validatedConfig(requested);
            await writeConfig(path, toSave);
            const currentRequest = update(configRef.current);
            if (currentRequest === null) {
              await repairLatestConfig(path);
              return;
            }
            if (revision !== configRevisionRef.current) continue;
            publishConfig(toSave, false);
            logInfo('Config saved successfully');
            return;
          }
        } catch (e) {
          logError(`Config save failed: ${e}`);
          setSaveError(String(e));
          throw e;
        }
      });
    },
    [enqueueWrite, publishConfig]
  );

  const save = useCallback((next?: AppConfig) => persist(next), [persist]);
  const saveOrThrow = useCallback((next?: AppConfig) => persist(next, true), [persist]);

  return {
    config,
    isDirty,
    isLoading,
    loadError,
    saveError,
    updateConfig,
    save,
    saveOrThrow,
    saveUpdateOrThrow,
    reload: load,
  };
}
