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
} from '../../src/lib/drive/api.js';
import { DriveError, type DriveFileRecord } from '../../src/lib/drive/types.js';
import { parseConfigYaml } from '../../src/lib/config/schema.js';
import { sha256Hex } from '../../src/lib/invoice/sourceFingerprint.js';

export interface MemoryDriveFile extends DriveFileRecord {
  bytes: Uint8Array;
}

export interface MemoryDriveApiOptions {
  generatedIds?: readonly string[];
  maxPageSize?: number;
  sharedDrives?: readonly SharedDrive[];
}

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function cloneRecord(file: DriveFileRecord): DriveFileRecord {
  return {
    ...file,
    parents: [...file.parents],
    properties: { ...file.properties },
    capabilities: { ...file.capabilities },
  };
}

function cloneFile(file: MemoryDriveFile): MemoryDriveFile {
  return { ...cloneRecord(file), bytes: new Uint8Array(file.bytes) };
}

function driveError(
  code: 'notFound' | 'permission' | 'conflict' | 'invalidResponse',
  message: string,
  status: number,
  fileId?: string
): DriveError {
  return new DriveError(code, message, false, status, fileId);
}

function decodeQueryString(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function queryString(query: string, expression: RegExp): string | null {
  const match = expression.exec(query);
  return match == null ? null : decodeQueryString(match[1]);
}

function pageOffset(pageToken: string | undefined): number {
  if (pageToken == null) return 0;
  const match = /^memory-page:(\d+)$/.exec(pageToken);
  if (match == null) {
    throw driveError('invalidResponse', 'Invalid memory Drive page token', 400);
  }
  return Number(match[1]);
}

function supportsFile(file: DriveFileRecord, supportsAllDrives: boolean): void {
  if (file.driveId !== null && !supportsAllDrives) {
    throw driveError(
      'invalidResponse',
      'Shared Drive operation omitted supportsAllDrives',
      400,
      file.id
    );
  }
}

export class MemoryDriveApi implements DriveApi {
  private readonly files = new Map<string, MemoryDriveFile>();
  private readonly generatedIds: string[];
  private readonly maxPageSize: number;
  private readonly sharedDrives: SharedDrive[];
  private readonly operationLog: string[] = [];
  private readonly listFileRequests: ListFilesRequest[] = [];
  private readonly updateRequests = new Map<string, UpdateDriveFileRequest>();
  private readonly patchRequests = new Map<string, PatchDriveMetadataRequest>();
  private generatedCounter = 0;

  constructor(files: readonly MemoryDriveFile[] = [], options: MemoryDriveApiOptions = {}) {
    for (const file of files) {
      if (this.files.has(file.id))
        throw new TypeError(`Duplicate memory Drive file ID: ${file.id}`);
      this.files.set(file.id, cloneFile(file));
    }
    this.generatedIds = [...(options.generatedIds ?? [])];
    this.maxPageSize = options.maxPageSize ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(this.maxPageSize) || this.maxPageSize < 1) {
      throw new TypeError('Memory Drive max page size must be a positive safe integer');
    }
    this.sharedDrives = (options.sharedDrives ?? []).map((drive) => ({ ...drive }));
  }

  file(fileId: string): MemoryDriveFile {
    const file = this.files.get(fileId);
    if (file == null) {
      throw driveError('notFound', 'Memory Drive file not found', 404, fileId);
    }
    return cloneFile(file);
  }

  replaceFile(file: MemoryDriveFile): void {
    if (!this.files.has(file.id)) {
      throw driveError('notFound', 'Memory Drive file not found', 404, file.id);
    }
    this.files.set(file.id, cloneFile(file));
  }

  addFile(file: MemoryDriveFile): void {
    if (this.files.has(file.id)) {
      throw new TypeError(`Duplicate memory Drive file ID: ${file.id}`);
    }
    this.files.set(file.id, cloneFile(file));
  }

  mutations(): string[] {
    return [...this.operationLog];
  }

  listRequests(): ListFilesRequest[] {
    return this.listFileRequests.map((request) => ({ ...request }));
  }

  clearListRequests(): void {
    this.listFileRequests.length = 0;
  }

  updateRequest(fileId: string): UpdateDriveFileRequest | null {
    const request = this.updateRequests.get(fileId);
    return request == null
      ? null
      : {
          ...request,
          parents: [...request.parents],
          properties: { ...request.properties },
          bytes: [...request.bytes],
        };
  }

  patchRequest(fileId: string): PatchDriveMetadataRequest | null {
    const request = this.patchRequests.get(fileId);
    return request == null ? null : { ...request, properties: { ...request.properties } };
  }

  async listSharedDrives(request: ListSharedDrivesRequest): Promise<DriveListPage<SharedDrive>> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1) {
      throw driveError('invalidResponse', 'Invalid Shared Drive page size', 400);
    }
    const offset = pageOffset(request.pageToken);
    const pageSize = Math.min(request.pageSize, this.maxPageSize);
    const items = this.sharedDrives.slice(offset, offset + pageSize).map((drive) => ({ ...drive }));
    const nextOffset = offset + items.length;
    return {
      items,
      nextPageToken: nextOffset < this.sharedDrives.length ? `memory-page:${nextOffset}` : null,
    };
  }

  async listFiles(request: ListFilesRequest): Promise<DriveListPage<DriveFileRecord>> {
    this.listFileRequests.push({ ...request });
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1) {
      throw driveError('invalidResponse', 'Invalid Drive file page size', 400);
    }
    if (request.corpora === 'drive') {
      if (
        request.driveId == null ||
        !request.includeItemsFromAllDrives ||
        !request.supportsAllDrives
      ) {
        throw driveError('invalidResponse', 'Invalid Shared Drive list flags', 400);
      }
    }

    const parentId = queryString(request.query, /'((?:\\'|[^'])*)' in parents/);
    const name = queryString(request.query, /name = '((?:\\'|[^'])*)'/);
    const mimeType = queryString(request.query, /mimeType = '((?:\\'|[^'])*)'/);
    const propertyMatch =
      /properties has \{ key='((?:\\'|[^'])*)' and value='((?:\\'|[^'])*)' \}/.exec(request.query);
    const propertyKey = propertyMatch == null ? null : decodeQueryString(propertyMatch[1]);
    const propertyValue = propertyMatch == null ? null : decodeQueryString(propertyMatch[2]);
    const trashedMatch = /(?:^| and )trashed = (true|false)(?:$| and )/.exec(request.query);
    const trashed = trashedMatch == null ? null : trashedMatch[1] === 'true';

    if (parentId !== null) {
      const parent = this.files.get(parentId);
      if (parent != null) {
        supportsFile(parent, request.supportsAllDrives);
        if (parent.mimeType !== FOLDER_MIME_TYPE || !parent.capabilities.canListChildren) {
          throw driveError('permission', 'Memory Drive parent cannot list children', 403, parentId);
        }
      }
    }

    let matches = [...this.files.values()].filter((file) => {
      if (request.corpora === 'drive' && file.driveId !== request.driveId) return false;
      if (!request.includeItemsFromAllDrives && file.driveId !== null) return false;
      if (parentId !== null && !file.parents.includes(parentId)) return false;
      if (name !== null && file.name !== name) return false;
      if (mimeType !== null && file.mimeType !== mimeType) return false;
      if (trashed !== null && file.trashed !== trashed) return false;
      if (
        propertyKey !== null &&
        (propertyValue === null || file.properties[propertyKey] !== propertyValue)
      ) {
        return false;
      }
      return true;
    });
    matches = matches.sort((left, right) => left.id.localeCompare(right.id));

    const offset = pageOffset(request.pageToken);
    const pageSize = Math.min(request.pageSize, this.maxPageSize);
    const items = matches.slice(offset, offset + pageSize).map((file) => ({
      ...cloneRecord(file),
      etag: null,
    }));
    const nextOffset = offset + items.length;
    return {
      items,
      nextPageToken: nextOffset < matches.length ? `memory-page:${nextOffset}` : null,
    };
  }

  async getFile(request: GetDriveFileRequest): Promise<DriveFileRecord> {
    const file = this.files.get(request.fileId);
    if (file == null || file.trashed) {
      throw driveError('notFound', 'Memory Drive file not found', 404, request.fileId);
    }
    supportsFile(file, request.supportsAllDrives);
    if (file.mimeType === 'application/pdf') this.operationLog.push(`pdf:get:${file.id}`);
    return cloneRecord(file);
  }

  async downloadFile(request: GetDriveFileRequest): Promise<DriveDownload> {
    const file = this.files.get(request.fileId);
    if (file == null || file.trashed) {
      throw driveError('notFound', 'Memory Drive file not found', 404, request.fileId);
    }
    supportsFile(file, request.supportsAllDrives);
    if (!file.capabilities.canDownload) {
      throw driveError('permission', 'Memory Drive download denied', 403, file.id);
    }
    return { file: cloneRecord(file), bytes: new Uint8Array(file.bytes) };
  }

  async generateFileIds(count: number): Promise<string[]> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw driveError('invalidResponse', 'Invalid generated ID count', 400);
    }
    const ids: string[] = [];
    while (ids.length < count) {
      const supplied = this.generatedIds.shift();
      this.generatedCounter += 1;
      const id = supplied ?? `generated-file-${this.generatedCounter}`;
      if (!this.files.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async createFolder(request: CreateFolderRequest): Promise<DriveFileRecord> {
    if (request.name.trim().length === 0) {
      throw driveError('invalidResponse', 'Memory Drive folder name is blank', 400);
    }
    const parent = this.requireParent(request.parentId, request.supportsAllDrives);
    const [id] = await this.generateFileIds(1);
    const file: MemoryDriveFile = {
      id,
      name: request.name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [request.parentId],
      driveId: parent?.driveId ?? null,
      ownedByMe: parent?.driveId == null,
      trashed: false,
      version: '1',
      size: null,
      md5Checksum: null,
      sha256Checksum: null,
      properties: {},
      capabilities: {
        canListChildren: true,
        canAddChildren: true,
        canEdit: true,
        canDownload: false,
      },
      etag: `"${id}-v1"`,
      bytes: new Uint8Array(),
    };
    this.files.set(id, file);
    return cloneRecord(file);
  }

  async createFile(request: CreateDriveFileRequest): Promise<DriveFileRecord> {
    if (this.files.has(request.fileId)) {
      throw driveError('conflict', 'Memory Drive file ID already exists', 409, request.fileId);
    }
    const driveId = this.requireParents(request.parents, request.supportsAllDrives);
    const bytes = Uint8Array.from(request.bytes);
    const file: MemoryDriveFile = {
      id: request.fileId,
      name: request.name,
      mimeType: request.mimeType,
      parents: [...request.parents],
      driveId,
      ownedByMe: driveId === null,
      trashed: false,
      version: '1',
      size: String(bytes.byteLength),
      md5Checksum: null,
      sha256Checksum: await sha256Hex(bytes),
      properties: { ...request.properties },
      capabilities: {
        canListChildren: false,
        canAddChildren: false,
        canEdit: true,
        canDownload: true,
      },
      etag: `"${request.fileId}-v1"`,
      bytes,
    };
    this.files.set(file.id, file);
    this.operationLog.push(
      file.properties.lotusConfigSchema === '1'
        ? `config:create:${file.id}`
        : `pdf:create:${file.id}`
    );
    return cloneRecord(file);
  }

  async updateFile(request: UpdateDriveFileRequest): Promise<DriveFileRecord> {
    const current = this.requireEditable(
      request.fileId,
      request.ifMatch,
      request.supportsAllDrives
    );
    const driveId = this.requireParents(request.parents, request.supportsAllDrives);
    if (driveId !== current.driveId) {
      throw driveError('invalidResponse', 'Memory Drive update changed location', 400, current.id);
    }
    this.updateRequests.set(request.fileId, {
      ...request,
      parents: [...request.parents],
      properties: { ...request.properties },
      bytes: [...request.bytes],
    });
    const bytes = Uint8Array.from(request.bytes);
    const sha256Checksum = await sha256Hex(bytes);
    const verified = this.requireEditable(
      request.fileId,
      request.ifMatch,
      request.supportsAllDrives
    );
    const next = this.nextVersion(verified, {
      name: request.name,
      mimeType: request.mimeType,
      parents: [...request.parents],
      properties: { ...current.properties, ...request.properties },
      bytes,
      size: String(bytes.byteLength),
      sha256Checksum,
    });
    this.files.set(next.id, next);
    this.logUpdate(current, next);
    return cloneRecord(next);
  }

  async patchMetadata(request: PatchDriveMetadataRequest): Promise<DriveFileRecord> {
    const current = this.requireEditable(
      request.fileId,
      request.ifMatch,
      request.supportsAllDrives
    );
    this.patchRequests.set(request.fileId, {
      ...request,
      properties: { ...request.properties },
    });
    const next = this.nextVersion(current, {
      properties: { ...current.properties, ...request.properties },
    });
    this.files.set(next.id, next);
    this.operationLog.push(`pdf:patch:${next.id}`);
    return cloneRecord(next);
  }

  private requireParent(parentId: string, supportsAllDrives: boolean): MemoryDriveFile | null {
    if (parentId === 'root') return null;
    const parent = this.files.get(parentId);
    if (parent == null || parent.trashed || parent.mimeType !== FOLDER_MIME_TYPE) {
      throw driveError('notFound', 'Memory Drive parent folder not found', 404, parentId);
    }
    supportsFile(parent, supportsAllDrives);
    if (!parent.capabilities.canAddChildren) {
      throw driveError('permission', 'Memory Drive parent cannot add children', 403, parentId);
    }
    return parent;
  }

  private requireParents(parents: readonly string[], supportsAllDrives: boolean): string | null {
    if (parents.length !== 1) {
      throw driveError('invalidResponse', 'Memory Drive requires exactly one parent', 400);
    }
    return this.requireParent(parents[0], supportsAllDrives)?.driveId ?? null;
  }

  private requireEditable(
    fileId: string,
    ifMatch: string,
    supportsAllDrives: boolean
  ): MemoryDriveFile {
    const file = this.files.get(fileId);
    if (file == null || file.trashed) {
      throw driveError('notFound', 'Memory Drive file not found', 404, fileId);
    }
    supportsFile(file, supportsAllDrives);
    if (!file.capabilities.canEdit) {
      throw driveError('permission', 'Memory Drive edit denied', 403, fileId);
    }
    if (file.etag == null || ifMatch !== file.etag) {
      throw driveError('conflict', 'Memory Drive If-Match failed', 412, fileId);
    }
    return file;
  }

  private nextVersion(
    current: MemoryDriveFile,
    changed: Partial<MemoryDriveFile>
  ): MemoryDriveFile {
    if (!/^(0|[1-9]\d*)$/.test(current.version)) {
      throw driveError('invalidResponse', 'Memory Drive version overflow', 500, current.id);
    }
    const version = (BigInt(current.version) + 1n).toString();
    return {
      ...cloneFile(current),
      ...changed,
      version,
      etag: `"${current.id}-v${version}"`,
    };
  }

  private logUpdate(previous: MemoryDriveFile, next: MemoryDriveFile): void {
    if (next.properties.lotusConfigSchema !== '1') {
      this.operationLog.push(`pdf:update:${next.id}`);
      return;
    }
    try {
      const previousConfig = parseConfigYaml(new TextDecoder().decode(previous.bytes));
      const nextConfig = parseConfigYaml(new TextDecoder().decode(next.bytes));
      if (
        JSON.stringify(previousConfig.invoiceSequenceByYear) !==
        JSON.stringify(nextConfig.invoiceSequenceByYear)
      ) {
        this.operationLog.push('config:sequence:if-match');
        return;
      }
    } catch {
      // Legacy JSON migration is a normal configuration update.
    }
    this.operationLog.push('config:update:if-match');
  }
}
