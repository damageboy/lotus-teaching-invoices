import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  invoke: vi.fn(),
};

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

const {
  DriveConfigPointerConflictError,
  installDriveConfigPointer,
  parseDriveConfigPointer,
  readDriveConfigPointer,
} = await import('../../src/lib/drive/configPointer.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseDriveConfigPointer', () => {
  it('distinguishes an absent record from every invalid record', () => {
    expect(parseDriveConfigPointer(null)).toEqual({ kind: 'absent', raw: null });

    for (const raw of [
      '{',
      'null',
      '[]',
      '{"version":2,"configFileId":"file-1"}',
      '{"version":1,"configFileId":""}',
      '{"version":1,"configFileId":"   "}',
      '{"version":1,"configFileId":"file-1","folderId":"folder-1"}',
    ]) {
      expect(parseDriveConfigPointer(raw)).toMatchObject({ kind: 'invalid', raw });
    }
  });

  it('returns the exact raw snapshot and nonblank file ID', () => {
    const raw = '{"version":1,"configFileId":"file-1"}';

    expect(parseDriveConfigPointer(raw)).toEqual({
      kind: 'valid',
      raw,
      fileId: 'file-1',
    });
  });
});

describe('Drive config pointer storage', () => {
  it('reads and parses the raw Tauri record', async () => {
    mocks.invoke.mockResolvedValueOnce('{"version":1,"configFileId":"file-1"}');

    await expect(readDriveConfigPointer()).resolves.toMatchObject({
      kind: 'valid',
      fileId: 'file-1',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('read_drive_config_pointer');
  });

  it.each([{ status: 'durable' }, { status: 'committedButDurabilityUncertain' }])(
    'installs one strict record after $status storage',
    async (outcome) => {
      mocks.invoke.mockResolvedValueOnce(outcome);

      const installed = await installDriveConfigPointer('file-2', 'old raw');

      expect(installed).toEqual({
        fileId: 'file-2',
        raw: '{\n  "version": 1,\n  "configFileId": "file-2"\n}',
      });
      expect(mocks.invoke).toHaveBeenCalledWith('write_drive_config_pointer', {
        raw: installed.raw,
        expectedRaw: 'old raw',
      });
    }
  );

  it('rejects stale compare-and-write without claiming installation', async () => {
    mocks.invoke.mockResolvedValueOnce({ status: 'conflict' });

    await expect(installDriveConfigPointer('file-2', 'stale raw')).rejects.toBeInstanceOf(
      DriveConfigPointerConflictError
    );
  });

  it('rejects a blank file ID before invoking storage', async () => {
    await expect(installDriveConfigPointer('  ', null)).rejects.toThrow(
      'Drive configuration file ID is required'
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
