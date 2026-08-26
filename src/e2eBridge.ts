import { invoke } from '@tauri-apps/api/core';

export type E2eFailpoint = 'cacheReconcileAfterRemote';

export interface E2eAuthorizationSeed {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  authorizationVersion: number;
  grantedScopes: string[];
}

export interface E2eEventSeed {
  eventId: string;
  recurringEventId: string | null;
  originalStartTime: string | null;
  etag: string | null;
  summary: string;
  description: string;
  start: string;
  end: string;
  updated: string | null;
  status: string;
}

export interface E2eSeedRequest {
  configYaml: string;
  calendarId: string;
  authorization: E2eAuthorizationSeed;
  events: E2eEventSeed[];
  syncToken: string;
  syncedAt: string;
}

export interface E2eRuntimeStatus {
  dataRoot: string;
  configPath: string;
  authRecordPresent: boolean;
  cachedEventCount: number;
  syncStatePresent: boolean;
  writeCapable: boolean;
  pendingEditJournalPath: string;
}

export interface LotusE2eBridge {
  seedRuntime(seed: E2eSeedRequest): Promise<E2eRuntimeStatus>;
  runtimeStatus(calendarId: string): Promise<E2eRuntimeStatus>;
  armFailpoint(failpoint: E2eFailpoint): Promise<void>;
  readCachedPdf(filename: string): Promise<number[]>;
}

const bridge: LotusE2eBridge = Object.freeze({
  seedRuntime: (seed: E2eSeedRequest) => invoke<E2eRuntimeStatus>('e2e_seed_runtime', { seed }),
  runtimeStatus: (calendarId: string) =>
    invoke<E2eRuntimeStatus>('e2e_runtime_status', { calendarId }),
  armFailpoint: (failpoint: E2eFailpoint) => invoke<void>('e2e_arm_failpoint', { failpoint }),
  readCachedPdf: (filename: string) => invoke<number[]>('e2e_read_cached_pdf', { filename }),
});

export function installE2eBridge(): void {
  Object.defineProperty(window, '__LOTUS_E2E__', {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
