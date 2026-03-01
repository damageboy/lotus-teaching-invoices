import { useState, useEffect, useCallback } from 'react';
import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AppConfig } from '../lib/types';
import { validateConfig } from '../lib/config/schema';
import { DEFAULT_CONFIG } from '../lib/config/defaults';

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
        // First launch — write defaults
        await writeTextFile(CONFIG_FILE, stringifyYaml(DEFAULT_CONFIG), { baseDir: BASE_DIR });
        setConfig(DEFAULT_CONFIG);
      } else {
        const raw = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
        const parsed = parseYaml(raw);
        setConfig(validateConfig(parsed));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
      setIsDirty(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateConfig = useCallback((next: AppConfig) => {
    setConfig(next);
    setIsDirty(true);
  }, []);

  const save = useCallback(async (next?: AppConfig) => {
    const toSave = next ?? config;
    await writeTextFile(CONFIG_FILE, stringifyYaml(toSave), { baseDir: BASE_DIR });
    setConfig(toSave);
    setIsDirty(false);
  }, [config]);

  return { config, isDirty, isLoading, error, updateConfig, save, reload: load };
}
