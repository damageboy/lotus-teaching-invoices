import { invoke } from '@tauri-apps/api/core';

export const DRIVE_CONFIG_POINTER_VERSION = 1 as const;

export type DriveConfigPointerRead =
  | { kind: 'absent'; raw: null }
  | { kind: 'valid'; raw: string; fileId: string }
  | { kind: 'invalid'; raw: string; message: string };

type StorageWriteOutcome =
  | { status: 'durable' }
  | { status: 'committedButDurabilityUncertain' }
  | { status: 'conflict' };

export class DriveConfigPointerConflictError extends Error {
  constructor() {
    super('Drive configuration selection changed before it could be saved');
    this.name = 'DriveConfigPointerConflictError';
  }
}

function invalid(raw: string, message: string): DriveConfigPointerRead {
  return { kind: 'invalid', raw, message };
}

export function parseDriveConfigPointer(raw: string | null): DriveConfigPointerRead {
  if (raw === null) return { kind: 'absent', raw: null };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid(raw, 'The local Drive configuration pointer is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(raw, 'The local Drive configuration pointer must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'configFileId' || keys[1] !== 'version') {
    return invalid(raw, 'The local Drive configuration pointer has unexpected fields');
  }
  if (record.version !== DRIVE_CONFIG_POINTER_VERSION) {
    return invalid(raw, 'The local Drive configuration pointer version is unsupported');
  }
  if (typeof record.configFileId !== 'string' || record.configFileId.trim().length === 0) {
    return invalid(raw, 'The local Drive configuration pointer file ID is invalid');
  }
  return { kind: 'valid', raw, fileId: record.configFileId };
}

export async function readDriveConfigPointer(): Promise<DriveConfigPointerRead> {
  return parseDriveConfigPointer(await invoke<string | null>('read_drive_config_pointer'));
}

export async function installDriveConfigPointer(
  fileId: string,
  expectedRaw: string | null
): Promise<{ raw: string; fileId: string }> {
  if (fileId.trim().length === 0) throw new Error('Drive configuration file ID is required');
  const raw = JSON.stringify(
    { version: DRIVE_CONFIG_POINTER_VERSION, configFileId: fileId },
    null,
    2
  );
  const outcome = await invoke<StorageWriteOutcome>('write_drive_config_pointer', {
    raw,
    expectedRaw,
  });
  if (outcome.status === 'conflict') throw new DriveConfigPointerConflictError();
  return { raw, fileId };
}
