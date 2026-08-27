import type { DriveApi, SharedDrive } from './api.js';
import { DriveError, type DriveFileRecord } from './types.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const FINAL_FOLDER_NAME = 'Final';
const PAGE_SIZE = 100;

export type DriveLocation =
  | { kind: 'myDrive'; id: 'root'; name: 'My Drive'; driveId: null }
  | { kind: 'sharedDrive'; id: string; name: string; driveId: string };

export interface DriveFolderPage {
  folders: DriveFileRecord[];
  nextPageToken: string | null;
}

export interface StagedDriveRoot {
  root: DriveRoot;
  rootFile: DriveFileRecord;
  finalFolder: DriveFileRecord;
}

export interface DriveRoot {
  folderId: string;
  driveId: string | null;
  folderName: string;
}

export type DriveFolderErrorCode = 'duplicateFinalFolder';

export class DriveFolderError extends Error {
  readonly retryable = false;
  readonly status = 409;

  constructor(
    readonly code: DriveFolderErrorCode,
    message: string,
    readonly fileIds: string[]
  ) {
    super(message);
    this.name = 'DriveFolderError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidResponse(message: string, fileId?: string): DriveError {
  return new DriveError('invalidResponse', message, false, undefined, fileId);
}

function permission(message: string, fileId: string): DriveError {
  return new DriveError('permission', message, false, 403, fileId);
}

function conflict(message: string, fileId: string): DriveError {
  return new DriveError('conflict', message, false, 409, fileId);
}

function requireLocation(location: DriveLocation): DriveLocation {
  if (
    location.kind === 'myDrive' &&
    location.id === 'root' &&
    location.name === 'My Drive' &&
    location.driveId === null
  ) {
    return location;
  }
  if (
    location.kind === 'sharedDrive' &&
    isNonEmptyString(location.id) &&
    isNonEmptyString(location.name) &&
    location.driveId === location.id
  ) {
    return location;
  }
  throw invalidResponse('Drive location is invalid');
}

function requireSharedDrive(value: unknown): SharedDrive {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.name)) {
    throw invalidResponse('Drive returned an invalid Shared Drive record');
  }
  return { id: value.id, name: value.name };
}

function requireFolderShape(value: unknown, fileId?: string): DriveFileRecord {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.name !== 'string' ||
    value.mimeType !== FOLDER_MIME_TYPE ||
    !Array.isArray(value.parents) ||
    !value.parents.every(isNonEmptyString) ||
    !(value.driveId === null || isNonEmptyString(value.driveId)) ||
    value.trashed !== false ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.canListChildren !== 'boolean' ||
    typeof value.capabilities.canAddChildren !== 'boolean' ||
    typeof value.capabilities.canEdit !== 'boolean' ||
    typeof value.capabilities.canDownload !== 'boolean'
  ) {
    throw invalidResponse('Drive returned an invalid folder record', fileId);
  }
  return value as unknown as DriveFileRecord;
}

function requireFolder(
  value: unknown,
  options: {
    expectedId?: string;
    expectedName?: string;
    parentId?: string;
    driveId?: string | null;
  } = {}
): DriveFileRecord {
  const fallbackId =
    isRecord(value) && typeof value.id === 'string' ? value.id : options.expectedId;
  const file = requireFolderShape(value, fallbackId);
  if (options.expectedId !== undefined && file.id !== options.expectedId) {
    throw invalidResponse('Drive returned a different folder ID', options.expectedId);
  }
  if (options.expectedName !== undefined && file.name !== options.expectedName) {
    throw invalidResponse('Drive returned a folder with an unexpected name', file.id);
  }
  if (
    options.parentId !== undefined &&
    (file.parents.length !== 1 || file.parents[0] !== options.parentId)
  ) {
    throw invalidResponse('Drive returned a folder outside the requested parent', file.id);
  }
  if (options.driveId !== undefined && file.driveId !== options.driveId) {
    throw invalidResponse('Drive returned a folder from a different Drive location', file.id);
  }
  return file;
}

function validateNextPageToken(value: unknown, current?: string): string | null {
  if (value === null) return null;
  if (!isNonEmptyString(value)) {
    throw invalidResponse('Drive returned a blank or invalid folder page token');
  }
  if (value === current) {
    throw invalidResponse('Drive repeated a folder page token');
  }
  return value;
}

function requireInputPageToken(pageToken?: string): string | undefined {
  if (pageToken === undefined) return undefined;
  if (!isNonEmptyString(pageToken)) {
    throw invalidResponse('Drive folder page token is blank');
  }
  return pageToken;
}

function escapeQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function folderQuery(parentId: string): string {
  return `'${escapeQueryString(parentId)}' in parents and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
}

function locationForDriveId(driveId: string | null): DriveLocation {
  if (driveId === null) {
    return { kind: 'myDrive', id: 'root', name: 'My Drive', driveId: null };
  }
  return { kind: 'sharedDrive', id: driveId, name: driveId, driveId };
}

export class DriveFolderService {
  constructor(private readonly api: DriveApi) {}

  private async resolveParentId(location: DriveLocation, parentId: string): Promise<string> {
    if (location.kind !== 'myDrive' || parentId !== 'root') return parentId;

    const root = requireFolder(
      await this.api.getFile({ fileId: 'root', supportsAllDrives: true }),
      { driveId: null }
    );
    if (root.id === 'root' || !root.ownedByMe || root.parents.length !== 0) {
      throw invalidResponse('Drive returned an invalid canonical My Drive root', root.id);
    }
    return root.id;
  }

  private async listFinalFolders(
    location: DriveLocation,
    rootId: string
  ): Promise<Map<string, DriveFileRecord>> {
    const finalsById = new Map<string, DriveFileRecord>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.listChildren(location, rootId, pageToken);
      for (const child of page.folders) {
        if (child.name === FINAL_FOLDER_NAME && !finalsById.has(child.id)) {
          finalsById.set(child.id, child);
        }
      }
      if (page.nextPageToken === null) break;
      if (seenPageTokens.has(page.nextPageToken)) {
        throw invalidResponse('Drive repeated a child-folder page token');
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } while (true);
    return finalsById;
  }

  private requireAtMostOneFinal(finalsById: Map<string, DriveFileRecord>): void {
    if (finalsById.size <= 1) return;
    const fileIds = [...finalsById.keys()].sort();
    throw new DriveFolderError(
      'duplicateFinalFolder',
      'Selected Drive root contains multiple direct Final folders',
      fileIds
    );
  }

  async listLocations(): Promise<DriveLocation[]> {
    const locations: DriveLocation[] = [
      { kind: 'myDrive', id: 'root', name: 'My Drive', driveId: null },
    ];
    const drivesById = new Map<string, SharedDrive>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const page = await this.api.listSharedDrives({
        pageSize: PAGE_SIZE,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw invalidResponse('Drive returned an invalid Shared Drive page');
      }
      for (const item of page.items) {
        const drive = requireSharedDrive(item);
        if (!drivesById.has(drive.id)) drivesById.set(drive.id, drive);
      }

      const nextPageToken = validateNextPageToken(page.nextPageToken, pageToken);
      if (nextPageToken === null) break;
      if (seenPageTokens.has(nextPageToken)) {
        throw invalidResponse('Drive repeated a Shared Drive page token');
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (true);

    for (const drive of drivesById.values()) {
      locations.push({
        kind: 'sharedDrive',
        id: drive.id,
        name: drive.name,
        driveId: drive.id,
      });
    }
    return locations;
  }

  async listChildren(
    location: DriveLocation,
    parentId: string,
    pageToken?: string
  ): Promise<DriveFolderPage> {
    const exactLocation = requireLocation(location);
    if (!isNonEmptyString(parentId)) {
      throw invalidResponse('Drive parent folder ID is blank');
    }
    const exactPageToken = requireInputPageToken(pageToken);
    const exactParentId = await this.resolveParentId(exactLocation, parentId);
    const shared = exactLocation.kind === 'sharedDrive';
    const page = await this.api.listFiles({
      query: folderQuery(exactParentId),
      corpora: shared ? 'drive' : 'user',
      ...(exactLocation.kind === 'sharedDrive' ? { driveId: exactLocation.driveId } : {}),
      ...(exactPageToken === undefined ? {} : { pageToken: exactPageToken }),
      pageSize: PAGE_SIZE,
      includeItemsFromAllDrives: shared,
      supportsAllDrives: true,
    });
    if (!isRecord(page) || !Array.isArray(page.items)) {
      throw invalidResponse('Drive returned an invalid folder page');
    }

    const foldersById = new Map<string, DriveFileRecord>();
    for (const item of page.items) {
      const child = requireFolder(item, {
        parentId: exactParentId,
        driveId: exactLocation.driveId,
      });
      if (!foldersById.has(child.id)) foldersById.set(child.id, child);
    }
    return {
      folders: [...foldersById.values()],
      nextPageToken: validateNextPageToken(page.nextPageToken, exactPageToken),
    };
  }

  async createChild(
    location: DriveLocation,
    parentId: string,
    name: string
  ): Promise<DriveFileRecord> {
    const exactLocation = requireLocation(location);
    if (!isNonEmptyString(parentId)) {
      throw invalidResponse('Drive parent folder ID is blank');
    }
    if (!isNonEmptyString(name)) {
      throw invalidResponse('Drive child folder name is blank');
    }
    const exactParentId = await this.resolveParentId(exactLocation, parentId);
    const created = await this.api.createFolder({
      name,
      parentId: exactParentId,
      supportsAllDrives: true,
    });
    return requireFolder(created, {
      expectedName: name,
      parentId: exactParentId,
      driveId: exactLocation.driveId,
    });
  }

  async stageRoot(folder: DriveFileRecord): Promise<StagedDriveRoot> {
    const selected = requireFolderShape(folder);
    const location = locationForDriveId(selected.driveId);
    const rootFile = requireFolder(
      await this.api.getFile({ fileId: selected.id, supportsAllDrives: true }),
      { expectedId: selected.id, driveId: selected.driveId }
    );
    if (!rootFile.capabilities.canListChildren) {
      throw permission('Selected Drive folder cannot list children', rootFile.id);
    }
    if (!rootFile.capabilities.canAddChildren) {
      throw permission('Selected Drive folder cannot add children', rootFile.id);
    }

    const finalsById = await this.listFinalFolders(location, rootFile.id);
    this.requireAtMostOneFinal(finalsById);

    const listedFinal = finalsById.values().next().value as DriveFileRecord | undefined;
    let finalId = listedFinal?.id;
    if (finalId === undefined) {
      const created = await this.createChild(location, rootFile.id, FINAL_FOLDER_NAME);
      const visibleFinals = await this.listFinalFolders(location, rootFile.id);
      this.requireAtMostOneFinal(visibleFinals);
      const visibleFinal = visibleFinals.values().next().value as DriveFileRecord | undefined;
      if (visibleFinal?.id !== created.id) {
        throw conflict(
          'Created Final folder is not the sole visible direct Final folder',
          created.id
        );
      }
      finalId = created.id;
    }
    const finalFolder = requireFolder(
      await this.api.getFile({ fileId: finalId, supportsAllDrives: true }),
      {
        expectedId: finalId,
        expectedName: FINAL_FOLDER_NAME,
        parentId: rootFile.id,
        driveId: rootFile.driveId,
      }
    );
    if (!finalFolder.capabilities.canListChildren) {
      throw permission('Final Drive folder cannot list invoices', finalFolder.id);
    }
    if (!finalFolder.capabilities.canAddChildren) {
      throw permission('Final Drive folder cannot receive invoices', finalFolder.id);
    }
    if (!finalFolder.capabilities.canEdit) {
      throw permission('Final Drive folder cannot update invoices', finalFolder.id);
    }

    return {
      root: {
        folderId: rootFile.id,
        driveId: rootFile.driveId,
        folderName: rootFile.name,
      },
      rootFile,
      finalFolder,
    };
  }

  async resolveRootFromConfigParent(parentId: string): Promise<StagedDriveRoot> {
    if (!isNonEmptyString(parentId)) {
      throw invalidResponse('Drive configuration parent folder ID is blank');
    }
    const rootFile = requireFolder(
      await this.api.getFile({ fileId: parentId, supportsAllDrives: true }),
      { expectedId: parentId }
    );
    if (!rootFile.capabilities.canListChildren || !rootFile.capabilities.canAddChildren) {
      throw permission('Drive configuration parent is not usable as an invoice root', rootFile.id);
    }

    const location = locationForDriveId(rootFile.driveId);
    const finalsById = await this.listFinalFolders(location, rootFile.id);
    this.requireAtMostOneFinal(finalsById);
    const listedFinal = finalsById.values().next().value as DriveFileRecord | undefined;
    if (listedFinal === undefined) {
      throw conflict('Drive invoice root has no direct Final folder', rootFile.id);
    }
    const finalFolder = requireFolder(
      await this.api.getFile({ fileId: listedFinal.id, supportsAllDrives: true }),
      {
        expectedId: listedFinal.id,
        expectedName: FINAL_FOLDER_NAME,
        parentId: rootFile.id,
        driveId: rootFile.driveId,
      }
    );
    if (
      !finalFolder.capabilities.canListChildren ||
      !finalFolder.capabilities.canAddChildren ||
      !finalFolder.capabilities.canEdit
    ) {
      throw permission('Final Drive folder is not usable for invoices', finalFolder.id);
    }

    return {
      root: {
        folderId: rootFile.id,
        driveId: rootFile.driveId,
        folderName: rootFile.name,
      },
      rootFile,
      finalFolder,
    };
  }
}
