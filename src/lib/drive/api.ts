import type { DriveFileRecord } from './types.js';

export interface DriveApi {
  listSharedDrives(request: ListSharedDrivesRequest): Promise<DriveListPage<SharedDrive>>;
  listFiles(request: ListFilesRequest): Promise<DriveListPage<DriveFileRecord>>;
  getFile(request: GetDriveFileRequest): Promise<DriveFileRecord>;
  downloadFile(request: GetDriveFileRequest): Promise<DriveDownload>;
  generateFileIds(count: number): Promise<string[]>;
  createFolder(request: CreateFolderRequest): Promise<DriveFileRecord>;
  createFile(request: CreateDriveFileRequest): Promise<DriveFileRecord>;
  updateFile(request: UpdateDriveFileRequest): Promise<DriveFileRecord>;
  patchMetadata(request: PatchDriveMetadataRequest): Promise<DriveFileRecord>;
}

export interface DriveListPage<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface SharedDrive {
  id: string;
  name: string;
}

export interface DriveDownload {
  file: DriveFileRecord;
  bytes: Uint8Array;
}

export interface ListSharedDrivesRequest {
  pageToken?: string;
  pageSize: number;
}

export interface ListFilesRequest {
  query: string;
  corpora: 'user' | 'drive';
  driveId?: string;
  pageToken?: string;
  pageSize: number;
  includeItemsFromAllDrives: boolean;
  supportsAllDrives: boolean;
}

export interface GetDriveFileRequest {
  fileId: string;
  supportsAllDrives: boolean;
}

export interface CreateFolderRequest {
  name: string;
  parentId: string;
  supportsAllDrives: boolean;
}

export interface CreateDriveFileRequest {
  fileId: string;
  name: string;
  mimeType: string;
  parents: string[];
  properties: Record<string, string>;
  bytes: number[];
  supportsAllDrives: boolean;
}

export interface UpdateDriveFileRequest extends CreateDriveFileRequest {
  ifMatch: string;
}

export interface PatchDriveMetadataRequest {
  fileId: string;
  properties: Record<string, string>;
  ifMatch: string;
  supportsAllDrives: boolean;
}
