import { describe, expect, it } from 'vitest';
import {
  DRIVE_CONFIG_MIME_TYPE,
  DRIVE_CONFIG_NAME,
  DRIVE_CONFIG_PROPERTY,
  DriveConfigRepository,
  nextInvoiceConfig,
  type DriveConfigSnapshot,
} from '../../src/lib/drive/configFile.js';
import { serializeConfigYaml, validateConfig } from '../../src/lib/config/schema.js';
import { DriveError } from '../../src/lib/drive/types.js';
import type { AppConfig } from '../../src/lib/types.js';
import { MemoryDriveApi, type MemoryDriveFile } from './memoryDriveApi.js';

const ROOT_ID = 'invoice-root';
const CONFIG_ID = 'config-file';

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: 'Street',
    taxNumber: '12/345/67890',
    bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
  },
  calendarId: 'calendar@example.test',
  calendarName: 'Teaching',
  studios: {
    Studio: {
      fullName: 'Studio GmbH',
      address: 'Studio Street',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }],
    },
  },
  invoiceSequenceByYear: { '2026': 8 },
};

function folder(id = ROOT_ID, driveId: string | null = null): MemoryDriveFile {
  return {
    id,
    name: 'Invoices',
    mimeType: 'application/vnd.google-apps.folder',
    parents: [],
    driveId,
    ownedByMe: driveId === null,
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
}

function file(
  overrides: Partial<MemoryDriveFile> = {},
  body = serializeConfigYaml(config)
): MemoryDriveFile {
  const bytes = new TextEncoder().encode(body);
  return {
    id: CONFIG_ID,
    name: DRIVE_CONFIG_NAME,
    mimeType: DRIVE_CONFIG_MIME_TYPE,
    parents: [ROOT_ID],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: String(bytes.byteLength),
    md5Checksum: null,
    sha256Checksum: null,
    properties: { ...DRIVE_CONFIG_PROPERTY },
    capabilities: {
      canListChildren: false,
      canAddChildren: false,
      canEdit: true,
      canDownload: true,
    },
    etag: `"${CONFIG_ID}-v1"`,
    bytes,
    ...overrides,
  };
}

function legacyFile(overrides: Partial<MemoryDriveFile> = {}): MemoryDriveFile {
  return file(
    {
      name: '.lotus-teaching-invoices.json',
      mimeType: 'application/json',
      ...overrides,
    },
    JSON.stringify({
      schemaVersion: 1,
      generation: 3,
      root: { folderId: ROOT_ID, driveId: null, folderName: 'Invoices' },
      finalFolderId: 'final',
      sequenceByYear: { '2026': 8 },
      reservation: null,
    })
  );
}

function snapshot(configFile = file()): DriveConfigSnapshot {
  return { file: configFile, config: structuredClone(config) };
}

describe('DriveConfigRepository', () => {
  it('discovers and validates one exact unified YAML file', async () => {
    const result = await new DriveConfigRepository(
      new MemoryDriveApi([folder(), file()])
    ).discover();

    expect(result).toMatchObject({
      kind: 'configured',
      snapshot: { file: { id: CONFIG_ID, parents: [ROOT_ID] }, config },
    });
  });

  it('discovers the marked config in a shared Drive', async () => {
    const shared = 'shared-drive';
    const result = await new DriveConfigRepository(
      new MemoryDriveApi([folder(ROOT_ID, shared), file({ driveId: shared, ownedByMe: false })])
    ).discover();

    expect(result).toMatchObject({ kind: 'configured', snapshot: { file: { driveId: shared } } });
  });

  it('ignores wrong names, MIME types, and markers', async () => {
    const wrongName = file({ id: 'wrong-name', name: 'config.yaml' });
    const wrongMime = file({ id: 'wrong-mime', mimeType: 'text/yaml' });
    const wrongMarker = file({ id: 'wrong-marker', properties: {} });
    const result = await new DriveConfigRepository(
      new MemoryDriveApi([folder(), wrongName, wrongMime, wrongMarker])
    ).discover();

    expect(result).toEqual({ kind: 'unconfigured' });
  });

  it('blocks duplicate unified files and unified-plus-legacy state', async () => {
    const duplicate = file({ id: 'config-2', etag: '"config-2-v1"' });
    await expect(
      new DriveConfigRepository(new MemoryDriveApi([folder(), file(), duplicate])).discover()
    ).resolves.toEqual({ kind: 'conflict', fileIds: ['config-2', CONFIG_ID] });
    await expect(
      new DriveConfigRepository(
        new MemoryDriveApi([folder(), file(), legacyFile({ id: 'legacy' })])
      ).discover()
    ).resolves.toEqual({ kind: 'conflict', fileIds: [CONFIG_ID, 'legacy'] });
  });

  it('rejects invalid YAML and a configuration with multiple parents', async () => {
    await expect(
      new DriveConfigRepository(new MemoryDriveApi([folder(), file({}, 'not: [valid')])).discover()
    ).rejects.toMatchObject({ code: 'corrupt', fileId: CONFIG_ID });
    await expect(
      new DriveConfigRepository(
        new MemoryDriveApi([folder(), folder('other'), file({ parents: [ROOT_ID, 'other'] })])
      ).discover()
    ).rejects.toMatchObject({ code: 'corrupt', fileId: CONFIG_ID });
  });

  it('creates one YAML file under the selected root', async () => {
    const api = new MemoryDriveApi([folder()], { generatedIds: [CONFIG_ID] });
    const result = await new DriveConfigRepository(api).create(ROOT_ID, config);

    expect(result).toMatchObject({ file: { id: CONFIG_ID, parents: [ROOT_ID] }, config });
    expect(api.file(CONFIG_ID)).toMatchObject({
      name: DRIVE_CONFIG_NAME,
      mimeType: DRIVE_CONFIG_MIME_TYPE,
      properties: DRIVE_CONFIG_PROPERTY,
    });
  });

  it('replaces content with If-Match and preserves the file identity', async () => {
    const api = new MemoryDriveApi([folder(), file()]);
    const next = { ...config, teacher: { ...config.teacher, name: 'Changed' } };
    const result = await new DriveConfigRepository(api).replace(snapshot(), next);

    expect(result.file.id).toBe(CONFIG_ID);
    expect(result.config.teacher.name).toBe('Changed');
    expect(api.updateRequest(CONFIG_ID)).toMatchObject({
      fileId: CONFIG_ID,
      ifMatch: `"${CONFIG_ID}-v1"`,
      parents: [ROOT_ID],
    });
  });

  it('preserves a typed stale-ETag conflict', async () => {
    const api = new MemoryDriveApi([folder(), file({ etag: '"current"' })]);
    const stale = snapshot(file({ etag: '"stale"' }));

    await expect(new DriveConfigRepository(api).replace(stale, config)).rejects.toMatchObject({
      code: 'conflict',
      status: 412,
      fileId: CONFIG_ID,
    });
  });

  it('moves the same file ID without changing YAML content', async () => {
    const target = folder('target-root');
    const api = new MemoryDriveApi([folder(), target, file()]);
    const result = await new DriveConfigRepository(api).move(snapshot(), target.id);

    expect(result.file.id).toBe(CONFIG_ID);
    expect(result.file.parents).toEqual([target.id]);
    expect(result.config).toEqual(validateConfig(config));
  });

  it('migrates the legacy JSON file in place', async () => {
    const legacy = legacyFile();
    const api = new MemoryDriveApi([folder(), legacy]);
    const repository = new DriveConfigRepository(api);
    const discovery = await repository.discover();
    expect(discovery.kind).toBe('legacy');
    if (discovery.kind !== 'legacy') throw new Error('expected legacy discovery');

    const result = await repository.migrate(discovery.snapshot, {
      ...config,
      invoiceSequenceByYear: {},
    });

    expect(result.file.id).toBe(CONFIG_ID);
    expect(result.file.name).toBe(DRIVE_CONFIG_NAME);
    expect(result.file.mimeType).toBe(DRIVE_CONFIG_MIME_TYPE);
    expect(result.file.parents).toEqual([ROOT_ID]);
    expect(result.config.invoiceSequenceByYear).toEqual({ '2026': 8 });
    expect(api.updateRequest(CONFIG_ID)).toMatchObject({
      fileId: CONFIG_ID,
      name: DRIVE_CONFIG_NAME,
      mimeType: DRIVE_CONFIG_MIME_TYPE,
      parents: [ROOT_ID],
      properties: DRIVE_CONFIG_PROPERTY,
      ifMatch: legacy.etag,
    });
  });
});

describe('nextInvoiceConfig', () => {
  it('increments one year without mutating its snapshot', () => {
    const current = snapshot();
    const original = structuredClone(current);
    const next = nextInvoiceConfig(current, 2026);

    expect(next).toMatchObject({
      invoiceNumber: '9/2026',
      config: { invoiceSequenceByYear: { '2026': 9 } },
    });
    expect(current).toEqual(original);
  });

  it('rejects invalid years and sequence overflow', () => {
    expect(() => nextInvoiceConfig(snapshot(), 0)).toThrow(DriveError);
    expect(() =>
      nextInvoiceConfig(
        {
          ...snapshot(),
          config: {
            ...config,
            invoiceSequenceByYear: { '2026': Number.MAX_SAFE_INTEGER },
          },
        },
        2026
      )
    ).toThrow(/cannot be incremented/);
  });
});
