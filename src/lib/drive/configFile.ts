import type { AppConfig } from '../types.js';
import { parseConfigYaml, serializeConfigYaml, validateConfig } from '../config/schema.js';
import type { DriveApi } from './api.js';
import { DriveError, type DriveFileRecord } from './types.js';

export const DRIVE_CONFIG_NAME = 'lotus-invoices-config.yaml';
export const DRIVE_CONFIG_MIME_TYPE = 'application/yaml';
export const DRIVE_CONFIG_PROPERTY = { lotusConfigSchema: '1' } as const;

const LEGACY_CONTROL_NAME = '.lotus-teaching-invoices.json';
const LEGACY_CONTROL_MIME_TYPE = 'application/json';
const PAGE_SIZE = 100;

export interface DriveConfigSnapshot {
  file: DriveFileRecord;
  config: AppConfig;
}

export interface LegacyControlSnapshot {
  file: DriveFileRecord;
  sequenceByYear: Record<string, number>;
}

export type DriveConfigDiscoveryCandidate =
  | { kind: 'configured'; file: DriveFileRecord }
  | { kind: 'legacy'; file: DriveFileRecord };

export type DriveConfigDiscovery =
  | { kind: 'unconfigured' }
  | { kind: 'configured'; snapshot: DriveConfigSnapshot }
  | { kind: 'legacy'; snapshot: LegacyControlSnapshot }
  | { kind: 'conflict'; fileIds: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneFile(file: DriveFileRecord): DriveFileRecord {
  return {
    ...file,
    parents: [...file.parents],
    properties: { ...file.properties },
    capabilities: { ...file.capabilities },
  };
}

function corrupt(message: string, fileId?: string): DriveError {
  return new DriveError('corrupt', message, false, undefined, fileId);
}

function invalidResponse(message: string, fileId?: string): DriveError {
  return new DriveError('invalidResponse', message, false, undefined, fileId);
}

function conflict(message: string, fileId?: string): DriveError {
  return new DriveError('conflict', message, false, 409, fileId);
}

function exactMarker(file: DriveFileRecord): boolean {
  return file.properties.lotusConfigSchema === DRIVE_CONFIG_PROPERTY.lotusConfigSchema;
}

function isCandidate(file: DriveFileRecord, name: string, mimeType: string): boolean {
  return (
    file.name === name &&
    file.mimeType === mimeType &&
    exactMarker(file) &&
    !file.trashed &&
    file.capabilities.canEdit &&
    file.capabilities.canDownload
  );
}

function requireExactFile(
  file: DriveFileRecord,
  fileId: string,
  name: string,
  mimeType: string
): DriveFileRecord {
  if (file.id !== fileId || !isCandidate(file, name, mimeType)) {
    throw invalidResponse('Drive returned a different configuration file', fileId);
  }
  if (!isNonEmptyString(file.etag)) {
    throw invalidResponse('Drive configuration response is missing an ETag', fileId);
  }
  if (file.parents.length !== 1 || !isNonEmptyString(file.parents[0])) {
    throw corrupt('Drive configuration must have exactly one parent', fileId);
  }
  return file;
}

function mapsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function coherent(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    left.id === right.id &&
    left.etag === right.etag &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.driveId === right.driveId &&
    left.trashed === right.trashed &&
    left.parents.length === right.parents.length &&
    left.parents.every((parent, index) => parent === right.parents[index]) &&
    mapsEqual(left.properties, right.properties) &&
    left.capabilities.canEdit === right.capabilities.canEdit &&
    left.capabilities.canDownload === right.capabilities.canDownload
  );
}

function decodeUtf8(bytes: Uint8Array, fileId: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw corrupt('Drive configuration is not valid UTF-8', fileId);
  }
}

function parseLegacySequence(bytes: Uint8Array, fileId: string): Record<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, fileId));
  } catch (error) {
    if (error instanceof DriveError) throw error;
    throw corrupt('Legacy Drive control file is not valid JSON', fileId);
  }
  if (!isRecord(value) || !isRecord(value.sequenceByYear)) {
    throw corrupt('Legacy Drive control sequence is invalid', fileId);
  }
  const result: Record<string, number> = {};
  for (const [year, sequence] of Object.entries(value.sequenceByYear)) {
    if (!/^[1-9]\d{3}$/.test(year) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      throw corrupt('Legacy Drive control sequence entry is invalid', fileId);
    }
    result[year] = sequence as number;
  }
  return result;
}

function escapeQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function queryFor(name: string, parentId?: string): string {
  const directParent =
    parentId === undefined ? '' : `'${escapeQueryString(parentId)}' in parents and `;
  return `${directParent}name = '${name}' and trashed = false and properties has { key='lotusConfigSchema' and value='1' }`;
}

export function nextInvoiceConfig(
  snapshot: DriveConfigSnapshot,
  year: number
): { invoiceNumber: string; config: AppConfig } {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) {
    throw corrupt('Invoice year is invalid', snapshot.file.id);
  }
  const key = String(year);
  const current = snapshot.config.invoiceSequenceByYear[key] ?? 0;
  if (current === Number.MAX_SAFE_INTEGER) {
    throw corrupt('Invoice sequence cannot be incremented', snapshot.file.id);
  }
  const next = current + 1;
  return {
    invoiceNumber: `${next}/${year}`,
    config: {
      ...snapshot.config,
      invoiceSequenceByYear: { ...snapshot.config.invoiceSequenceByYear, [key]: next },
    },
  };
}

export class DriveConfigRepository {
  constructor(private readonly api: DriveApi) {}

  private async list(
    name: string,
    mimeType: string,
    parentId?: string
  ): Promise<DriveFileRecord[]> {
    const byId = new Map<string, DriveFileRecord>();
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.api.listFiles({
        query: queryFor(name, parentId),
        corpora: 'user',
        ...(pageToken === undefined ? {} : { pageToken }),
        pageSize: PAGE_SIZE,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      for (const file of page.items) {
        if (isCandidate(file, name, mimeType) && !byId.has(file.id)) byId.set(file.id, file);
      }
      if (page.nextPageToken === null) {
        return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
      }
      if (!isNonEmptyString(page.nextPageToken) || seen.has(page.nextPageToken)) {
        throw invalidResponse('Drive returned an invalid configuration page token');
      }
      seen.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } while (true);
  }

  private async exactDownload(
    fileId: string,
    name: string,
    mimeType: string
  ): Promise<{ file: DriveFileRecord; bytes: Uint8Array }> {
    const metadata = requireExactFile(
      await this.api.getFile({ fileId, supportsAllDrives: true }),
      fileId,
      name,
      mimeType
    );
    const downloaded = await this.api.downloadFile({ fileId, supportsAllDrives: true });
    const media = requireExactFile(downloaded.file, fileId, name, mimeType);
    if (!coherent(metadata, media)) {
      throw invalidResponse('Drive configuration metadata and media are incoherent', fileId);
    }
    return { file: cloneFile(media), bytes: new Uint8Array(downloaded.bytes) };
  }

  async loadByFileId(fileId: string): Promise<DriveConfigSnapshot> {
    if (!isNonEmptyString(fileId)) throw invalidResponse('Drive configuration file ID is invalid');
    const exact = await this.exactDownload(fileId, DRIVE_CONFIG_NAME, DRIVE_CONFIG_MIME_TYPE);
    try {
      return { file: exact.file, config: parseConfigYaml(decodeUtf8(exact.bytes, fileId)) };
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw corrupt(
        error instanceof Error ? error.message : 'Drive configuration is invalid',
        fileId
      );
    }
  }

  async loadLegacyByFileId(fileId: string): Promise<LegacyControlSnapshot> {
    if (!isNonEmptyString(fileId)) throw invalidResponse('Legacy Drive file ID is invalid');
    const exact = await this.exactDownload(fileId, LEGACY_CONTROL_NAME, LEGACY_CONTROL_MIME_TYPE);
    return { file: exact.file, sequenceByYear: parseLegacySequence(exact.bytes, fileId) };
  }

  async discoverCandidates(): Promise<DriveConfigDiscoveryCandidate[]> {
    const [configured, legacy] = await Promise.all([
      this.list(DRIVE_CONFIG_NAME, DRIVE_CONFIG_MIME_TYPE),
      this.list(LEGACY_CONTROL_NAME, LEGACY_CONTROL_MIME_TYPE),
    ]);
    return [
      ...configured.map((file) => ({ kind: 'configured' as const, file: cloneFile(file) })),
      ...legacy.map((file) => ({ kind: 'legacy' as const, file: cloneFile(file) })),
    ];
  }

  async listDirectChildren(parentId: string): Promise<DriveConfigDiscoveryCandidate[]> {
    if (!isNonEmptyString(parentId)) throw invalidResponse('Drive configuration parent is invalid');
    const [configured, legacy] = await Promise.all([
      this.list(DRIVE_CONFIG_NAME, DRIVE_CONFIG_MIME_TYPE, parentId),
      this.list(LEGACY_CONTROL_NAME, LEGACY_CONTROL_MIME_TYPE, parentId),
    ]);
    return [
      ...configured.map((file) => ({ kind: 'configured' as const, file: cloneFile(file) })),
      ...legacy.map((file) => ({ kind: 'legacy' as const, file: cloneFile(file) })),
    ];
  }

  async discover(): Promise<DriveConfigDiscovery> {
    const candidates = await this.discoverCandidates();
    if (candidates.length === 0) return { kind: 'unconfigured' };
    if (candidates.length !== 1) {
      return { kind: 'conflict', fileIds: candidates.map(({ file }) => file.id).sort() };
    }
    const candidate = candidates[0];
    if (candidate.kind === 'configured') {
      return { kind: 'configured', snapshot: await this.loadByFileId(candidate.file.id) };
    }
    return { kind: 'legacy', snapshot: await this.loadLegacyByFileId(candidate.file.id) };
  }

  async create(parentId: string, config: AppConfig): Promise<DriveConfigSnapshot> {
    if (!isNonEmptyString(parentId)) throw invalidResponse('Drive configuration parent is invalid');
    const normalized = validateConfig(config);
    const before = await this.listDirectChildren(parentId);
    if (before.length !== 0) {
      throw conflict('A Drive configuration appeared during setup');
    }
    const ids = await this.api.generateFileIds(1);
    if (ids.length !== 1 || !isNonEmptyString(ids[0])) {
      throw invalidResponse('Drive did not return exactly one generated file ID');
    }
    const fileId = ids[0];
    await this.api.createFile({
      fileId,
      name: DRIVE_CONFIG_NAME,
      mimeType: DRIVE_CONFIG_MIME_TYPE,
      parents: [parentId],
      properties: { ...DRIVE_CONFIG_PROPERTY },
      bytes: Array.from(new TextEncoder().encode(serializeConfigYaml(normalized))),
      supportsAllDrives: true,
    });
    const after = await this.listDirectChildren(parentId);
    if (after.length !== 1 || after[0].kind !== 'configured' || after[0].file.id !== fileId) {
      throw conflict('Drive configuration creation raced with another setup', fileId);
    }
    return this.loadByFileId(fileId);
  }

  private async update(
    file: DriveFileRecord,
    parentId: string,
    config: AppConfig
  ): Promise<DriveConfigSnapshot> {
    requireExactFile(file, file.id, file.name, file.mimeType);
    const normalized = validateConfig(config);
    await this.api.updateFile({
      fileId: file.id,
      name: DRIVE_CONFIG_NAME,
      mimeType: DRIVE_CONFIG_MIME_TYPE,
      parents: [parentId],
      properties: { ...file.properties, ...DRIVE_CONFIG_PROPERTY },
      bytes: Array.from(new TextEncoder().encode(serializeConfigYaml(normalized))),
      supportsAllDrives: true,
      ifMatch: file.etag!,
    });
    const verified = await this.loadByFileId(file.id);
    if (JSON.stringify(verified.config) !== JSON.stringify(normalized)) {
      throw corrupt('Drive configuration write did not preserve the requested content', file.id);
    }
    return verified;
  }

  async replace(snapshot: DriveConfigSnapshot, config: AppConfig): Promise<DriveConfigSnapshot> {
    const file = requireExactFile(
      snapshot.file,
      snapshot.file.id,
      DRIVE_CONFIG_NAME,
      DRIVE_CONFIG_MIME_TYPE
    );
    return this.update(file, file.parents[0], config);
  }

  async move(snapshot: DriveConfigSnapshot, parentId: string): Promise<DriveConfigSnapshot> {
    if (!isNonEmptyString(parentId)) throw invalidResponse('Drive configuration parent is invalid');
    const moved = await this.update(snapshot.file, parentId, snapshot.config);
    if (moved.file.id !== snapshot.file.id || moved.file.parents[0] !== parentId) {
      throw corrupt('Drive configuration move was not verified', snapshot.file.id);
    }
    return moved;
  }

  async migrate(snapshot: LegacyControlSnapshot, config: AppConfig): Promise<DriveConfigSnapshot> {
    const file = requireExactFile(
      snapshot.file,
      snapshot.file.id,
      LEGACY_CONTROL_NAME,
      LEGACY_CONTROL_MIME_TYPE
    );
    const migrated = validateConfig({
      ...config,
      invoiceSequenceByYear: { ...snapshot.sequenceByYear },
    });
    const result = await this.update(file, file.parents[0], migrated);
    if (result.file.id !== file.id) {
      throw corrupt('Drive configuration migration changed the file ID', file.id);
    }
    return result;
  }
}
