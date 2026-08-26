export interface DriveCapabilities {
  canListChildren: boolean;
  canAddChildren: boolean;
  canEdit: boolean;
  canDownload: boolean;
}

export interface DriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId: string | null;
  ownedByMe: boolean;
  trashed: boolean;
  version: string;
  size: string | null;
  md5Checksum: string | null;
  sha256Checksum: string | null;
  properties: Readonly<Record<string, string>>;
  capabilities: DriveCapabilities;
  etag: string | null;
}

export interface LotusPdfProperties {
  lotusSchema: '1';
  lotusCalendarHash: string;
  lotusStudioSlug: string;
  lotusMonth: string;
  lotusInvoiceNumber: string;
  lotusSourceSha256: string;
  lotusPdfSha256: string;
  lotusOperationId: string;
}

export interface InvoiceKey {
  studioSlug: string;
  monthKey: string;
}

export interface InvoiceSourceFingerprint {
  sourceSha256: string;
  calendarSha256: string;
}

export type DriveErrorCode =
  | 'authorization'
  | 'offline'
  | 'notFound'
  | 'permission'
  | 'conflict'
  | 'rateLimited'
  | 'server'
  | 'invalidResponse'
  | 'corrupt';

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly fileId?: string
  ) {
    super(message);
    this.name = 'DriveError';
  }
}
