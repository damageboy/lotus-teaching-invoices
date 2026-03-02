import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// Fixed temp path — wdio.conf.ts writes here, tests read here.
// maxInstances: 1 so no parallelism concern.
export const TMP_CONFIG_PATH = '/tmp/lotus-e2e-config.yaml';

export function readTmpConfig(): Record<string, unknown> {
  return parse(readFileSync(TMP_CONFIG_PATH, 'utf-8'));
}
