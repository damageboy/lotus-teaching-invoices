import { useState, useEffect, useCallback, useRef } from 'react';
import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AppConfig } from '../lib/types';
import { validateConfig } from '../lib/config/schema';
import { DEFAULT_CONFIG } from '../lib/config/defaults';
import { logInfo, logError } from '../lib/logger';

const CONFIG_FILE = 'config.yaml';
const BASE_DIR = BaseDirectory.AppData;

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
      if (!fileExists) {
        logInfo('Config file not found — using defaults');
        setConfig(DEFAULT_CONFIG);
      } else {
        const raw = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
        const parsed = parseYaml(raw);
        setConfig(validateConfig(parsed));
        logInfo('Config loaded from disk');
      }
    } catch (e) {
      logError(`Config load failed: ${e}`);
      setError(String(e));
    } finally {
      setIsLoading(false);
      setIsDirty(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  const updateConfig = useCallback((next: AppConfig) => {
    setConfig(next);
    setIsDirty(true);
  }, []);

  const save = useCallback(async (next?: AppConfig) => {
    const raw = next ?? configRef.current;
    setError(null);

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

    logInfo(`Saving config to ${CONFIG_FILE}`);
    try {
      const toSave: AppConfig = JSON.parse(JSON.stringify(raw));
      await writeTextFile(CONFIG_FILE, stringifyYaml(toSave), { baseDir: BASE_DIR });
      setConfig(toSave);
      setIsDirty(false);
      logInfo('Config saved successfully');
    } catch (e) {
      logError(`Config save failed: ${e}`);
      setError(String(e));
    }
  }, []);

  return { config, isDirty, isLoading, error, updateConfig, save, reload: load };
}
