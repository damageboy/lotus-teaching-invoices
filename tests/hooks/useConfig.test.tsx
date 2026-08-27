import { afterAll, describe, expect, it, vi } from 'vitest';
import { DriveStoreError } from '../../src/lib/drive/invoiceStore.js';
import type { DriveConfigSnapshot } from '../../src/lib/drive/configFile.js';
import type { AppConfig } from '../../src/lib/types.js';
import { validateConfig } from '../../src/lib/config/schema.js';
import { serializeConfigYaml } from '../../src/lib/config/schema.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
const { act, renderHook, waitFor } = await import('@testing-library/react');
const { useConfig } = await import('../../src/hooks/useConfig.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: 'Street',
    taxNumber: 'Tax',
    bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
  },
  calendarId: 'calendar-id',
  studios: {
    Studio: {
      fullName: 'Studio',
      address: 'Studio Street',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
  invoiceSequenceByYear: { '2026': 7 },
};

function remote(value = config, etag = '"config-v1"'): DriveConfigSnapshot {
  return {
    file: {
      id: 'config-file',
      name: 'lotus-invoices-config.yaml',
      mimeType: 'application/yaml',
      parents: ['invoice-root'],
      driveId: null,
      ownedByMe: true,
      trashed: false,
      version: '1',
      size: '1',
      md5Checksum: null,
      sha256Checksum: null,
      properties: { lotusConfigSchema: '1' },
      capabilities: {
        canListChildren: false,
        canAddChildren: false,
        canEdit: true,
        canDownload: true,
      },
      etag,
    },
    config: value,
  };
}

describe('useConfig Drive draft', () => {
  afterAll(restoreDom);

  it('adopts a clean remote configuration', () => {
    const saveRemote = vi.fn();
    const { result } = renderHook(() =>
      useConfig({ remote: remote(), unconfigured: false, saveRemote })
    );

    expect(result.current.config).toEqual(config);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it('keeps unconfigured edits in memory for initial Drive activation', async () => {
    const saveRemote = vi.fn();
    const { result } = renderHook(() =>
      useConfig({ remote: null, unconfigured: true, saveRemote })
    );
    const next = { ...config, calendarName: 'Teaching' };
    const normalized = validateConfig(next);

    act(() => result.current.updateConfig(next));
    await act(() => result.current.save());

    expect(result.current.config).toEqual(normalized);
    expect(result.current.isDirty).toBe(true);
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('uses legacy local YAML as the initial draft when Drive is unconfigured', () => {
    const saveRemote = vi.fn();
    const legacyYaml = `${serializeConfigYaml({
      ...config,
      invoiceSequenceByYear: {},
    })}outputDir: ./old-invoices\nlastInvoice: 7/2026\n`;
    const { result } = renderHook(() =>
      useConfig({
        remote: null,
        unconfigured: true,
        legacyLocalYaml: legacyYaml,
        saveRemote,
      })
    );

    expect(result.current.config).toEqual(validateConfig(config));
    expect(result.current.isLoading).toBe(false);
  });

  it('saves the validated draft through Drive and adopts the returned ETag', async () => {
    const next = { ...config, calendarName: 'Teaching' };
    const normalized = validateConfig(next);
    const saved = remote(normalized, '"config-v2"');
    const saveRemote = vi.fn(async () => saved);
    const base = remote();
    const { result } = renderHook(() =>
      useConfig({ remote: base, unconfigured: false, saveRemote })
    );

    act(() => result.current.updateConfig(next));
    await act(() => result.current.saveOrThrow());

    expect(saveRemote).toHaveBeenCalledWith(normalized);
    expect(result.current.config).toEqual(normalized);
    expect(result.current.isDirty).toBe(false);
  });

  it('drops a rejected draft and exposes the fresh remote after an ETag conflict', async () => {
    const freshConfig = validateConfig({ ...config, calendarName: 'Other device' });
    const fresh = remote(freshConfig, '"config-v2"');
    const saveRemote = vi.fn(async () => {
      throw new DriveStoreError(
        'conflict',
        'Drive configuration changed elsewhere; repeat the edit',
        false,
        { config: fresh } as never
      );
    });
    const base = remote();
    const { result } = renderHook(() =>
      useConfig({ remote: base, unconfigured: false, saveRemote })
    );
    act(() => result.current.updateConfig({ ...config, calendarName: 'My edit' }));

    await act(async () => {
      await expect(result.current.saveOrThrow()).rejects.toMatchObject({ code: 'conflict' });
    });

    await waitFor(() => expect(result.current.config).toEqual(freshConfig));
    expect(result.current.isDirty).toBe(false);
    expect(result.current.saveError).toContain('changed elsewhere');
  });
});
