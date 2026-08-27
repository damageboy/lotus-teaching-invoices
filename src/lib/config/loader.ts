import { readFileSync } from 'node:fs';
import { AppConfig, AppError } from '../types.js';
import { parseConfigYaml } from './schema.js';

export function loadConfig(filePath: string): AppConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new AppError(`Cannot read config file: ${filePath}`, 'CONFIG_NOT_FOUND');
  }

  return parseConfigYaml(content);
}
