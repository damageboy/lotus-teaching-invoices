import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  clearEphemeralAccessToken,
  getAccessToken,
  type GetAccessTokenOptions,
} from '../gmail/auth.js';
import { AuthorizationRequiredError } from '../google/mobile-authorization.js';
import type {
  CreateDriveFileRequest,
  CreateFolderRequest,
  DriveApi,
  DriveDownload,
  DriveListPage,
  GetDriveFileRequest,
  ListFilesRequest,
  ListSharedDrivesRequest,
  PatchDriveMetadataRequest,
  SharedDrive,
  UpdateDriveFileRequest,
} from './api.js';
import { DriveError, type DriveErrorCode, type DriveFileRecord } from './types.js';

export type {
  CreateDriveFileRequest,
  CreateFolderRequest,
  DriveApi,
  DriveDownload,
  DriveListPage,
  GetDriveFileRequest,
  ListFilesRequest,
  ListSharedDrivesRequest,
  PatchDriveMetadataRequest,
  SharedDrive,
  UpdateDriveFileRequest,
} from './api.js';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type TokenOperation<T> = (accessToken: string) => Promise<T>;

export interface DriveTransportDependencies {
  invoke: Invoke;
  getAccessToken: (options?: GetAccessTokenOptions) => Promise<string>;
  clearEphemeralAccessToken: () => Promise<void>;
}

const defaultDependencies: DriveTransportDependencies = {
  invoke: tauriInvoke,
  getAccessToken,
  clearEphemeralAccessToken,
};

const ERROR_CODES = new Set<DriveErrorCode>([
  'authorization',
  'offline',
  'notFound',
  'permission',
  'conflict',
  'rateLimited',
  'server',
  'invalidResponse',
  'corrupt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message = 'Drive returned an invalid response'): DriveError {
  return new DriveError('invalidResponse', message, false);
}

function normalizeError(value: unknown): DriveError {
  if (value instanceof DriveError) return value;
  if (value instanceof AuthorizationRequiredError) {
    return new DriveError('authorization', value.message, true);
  }
  if (!isRecord(value)) return invalidResponse();

  const { code, message, retryable, status, fileId } = value;
  if (
    typeof code !== 'string' ||
    !ERROR_CODES.has(code as DriveErrorCode) ||
    typeof message !== 'string' ||
    typeof retryable !== 'boolean' ||
    (status != null && (!Number.isInteger(status) || (status as number) < 0)) ||
    (fileId != null && typeof fileId !== 'string')
  ) {
    return invalidResponse();
  }

  return new DriveError(
    code as DriveErrorCode,
    message,
    retryable,
    status == null ? undefined : (status as number),
    fileId == null ? undefined : fileId
  );
}

function requireToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidResponse();
  return value;
}

async function callTokenDependency<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeError(error);
  }
}

async function withDriveTokenRetryUsing<T>(
  operation: TokenOperation<T>,
  dependencies: DriveTransportDependencies
): Promise<T> {
  const initialToken = requireToken(
    await callTokenDependency(() =>
      dependencies.getAccessToken({ requireDrive: true, interactive: false })
    )
  );

  try {
    return await operation(initialToken);
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code !== 'authorization' || normalized.status !== 401) throw normalized;
  }

  await callTokenDependency(() => dependencies.clearEphemeralAccessToken());
  const refreshedToken = requireToken(
    await callTokenDependency(() =>
      dependencies.getAccessToken({ requireDrive: true, forceRefresh: true, interactive: false })
    )
  );

  try {
    return await operation(refreshedToken);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function withDriveTokenRetry<T>(operation: TokenOperation<T>): Promise<T> {
  return withDriveTokenRetryUsing(operation, defaultDependencies);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseDriveFile(value: unknown): DriveFileRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !Array.isArray(value.parents) ||
    !value.parents.every((parent) => typeof parent === 'string') ||
    !isNullableString(value.driveId) ||
    typeof value.ownedByMe !== 'boolean' ||
    typeof value.trashed !== 'boolean' ||
    typeof value.version !== 'string' ||
    !isNullableString(value.size) ||
    !isNullableString(value.md5Checksum) ||
    !isNullableString(value.sha256Checksum) ||
    !isStringMap(value.properties) ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.canListChildren !== 'boolean' ||
    typeof value.capabilities.canAddChildren !== 'boolean' ||
    typeof value.capabilities.canEdit !== 'boolean' ||
    typeof value.capabilities.canDownload !== 'boolean' ||
    !isNullableString(value.etag)
  ) {
    throw invalidResponse();
  }
  return value as unknown as DriveFileRecord;
}

function parseSharedDrive(value: unknown): SharedDrive {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw invalidResponse();
  }
  return { id: value.id, name: value.name };
}

function parseListPage<T>(value: unknown, parseItem: (item: unknown) => T): DriveListPage<T> {
  if (!isRecord(value) || !Array.isArray(value.items) || !isNullableString(value.nextPageToken)) {
    throw invalidResponse();
  }
  return { items: value.items.map(parseItem), nextPageToken: value.nextPageToken };
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidResponse();
  }
  return value;
}

function parseDownload(value: unknown): DriveDownload {
  if (
    !isRecord(value) ||
    !Array.isArray(value.bytes) ||
    !value.bytes.every(
      (byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255
    )
  ) {
    throw invalidResponse();
  }
  return {
    file: parseDriveFile(value.file),
    bytes: Uint8Array.from(value.bytes as number[]),
  };
}

export function createTauriDriveApi(
  dependencies: DriveTransportDependencies = defaultDependencies
): DriveApi {
  const call = <T>(
    command: string,
    request: unknown,
    parseResponse: (value: unknown) => T
  ): Promise<T> =>
    withDriveTokenRetryUsing(async (accessToken) => {
      let response: unknown;
      try {
        response = await dependencies.invoke<unknown>(command, { accessToken, request });
      } catch (error) {
        throw normalizeError(error);
      }
      return parseResponse(response);
    }, dependencies);

  return {
    listSharedDrives: (request: ListSharedDrivesRequest) =>
      call('list_shared_drives', request, (value) => parseListPage(value, parseSharedDrive)),
    listFiles: (request: ListFilesRequest) =>
      call('list_files', request, (value) => parseListPage(value, parseDriveFile)),
    getFile: (request: GetDriveFileRequest) => call('get_file', request, parseDriveFile),
    downloadFile: (request: GetDriveFileRequest) => call('download_file', request, parseDownload),
    generateFileIds: (count: number) =>
      call('generate_file_ids', { count, space: 'drive' }, parseStringArray),
    createFolder: (request: CreateFolderRequest) => call('create_folder', request, parseDriveFile),
    createFile: (request: CreateDriveFileRequest) =>
      call('create_file', { ...request, bytes: Array.from(request.bytes) }, parseDriveFile),
    updateFile: (request: UpdateDriveFileRequest) =>
      call('update_file', { ...request, bytes: Array.from(request.bytes) }, parseDriveFile),
    patchMetadata: (request: PatchDriveMetadataRequest) =>
      call('patch_metadata', request, parseDriveFile),
  };
}
