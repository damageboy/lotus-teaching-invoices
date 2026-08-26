import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DriveError,
  type DriveErrorCode,
  type DriveFileRecord,
  type LotusPdfProperties,
} from '../../src/lib/drive/types.js';

describe('Drive domain types', () => {
  it('retains nullable list metadata without treating an ETag as guaranteed', () => {
    const record: DriveFileRecord = {
      id: 'file-1',
      name: '8-2026-studio-a-2026-08.pdf',
      mimeType: 'application/pdf',
      parents: ['final-folder'],
      driveId: null,
      ownedByMe: true,
      trashed: false,
      version: '7',
      size: null,
      md5Checksum: null,
      sha256Checksum: null,
      properties: {},
      capabilities: {
        canListChildren: false,
        canAddChildren: false,
        canEdit: true,
        canDownload: true,
      },
      etag: null,
    };

    expect(record.etag).toBeNull();
    expect(record.trashed).toBe(false);
    expectTypeOf(record.etag).toEqualTypeOf<string | null>();
  });

  it('defines the complete standard Lotus PDF property set', () => {
    const properties: LotusPdfProperties = {
      lotusSchema: '1',
      lotusCalendarHash: 'calendar-sha256',
      lotusStudioSlug: 'studio-a',
      lotusMonth: '2026-08',
      lotusInvoiceNumber: '8/2026',
      lotusSourceSha256: 'source-sha256',
      lotusPdfSha256: 'pdf-sha256',
      lotusOperationId: 'operation-1',
    };

    expect(Object.keys(properties).sort()).toEqual([
      'lotusCalendarHash',
      'lotusInvoiceNumber',
      'lotusMonth',
      'lotusOperationId',
      'lotusPdfSha256',
      'lotusSchema',
      'lotusSourceSha256',
      'lotusStudioSlug',
    ]);
  });

  it.each<DriveErrorCode>([
    'authorization',
    'offline',
    'notFound',
    'permission',
    'conflict',
    'rateLimited',
    'server',
    'invalidResponse',
    'corrupt',
  ])('models the %s failure code', (code) => {
    const error = new DriveError(code, 'Drive failed', true, 503, 'file-1');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DriveError');
    expect(error).toMatchObject({
      code,
      message: 'Drive failed',
      retryable: true,
      status: 503,
      fileId: 'file-1',
    });
  });
});
