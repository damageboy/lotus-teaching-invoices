import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/lib/types.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const fs = {
  exists: vi.fn().mockResolvedValue(false),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
};
const invoke = vi.fn().mockResolvedValue('/tmp/config.yaml');

vi.mock('@tauri-apps/plugin-fs', () => ({
  ...fs,
  BaseDirectory: { AppData: 'AppData' },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../src/lib/logger.js', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useConfig } = await import('../../src/hooks/useConfig.js');

const legacyConfig: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: 'Street',
    taxNumber: 'Tax',
    bankDetails: { accountOwner: 'Teacher', iban: 'DE00', bic: 'BIC' },
  },
  calendarId: 'calendar-id',
  outputDir: '/legacy/invoices',
  lastInvoice: '7/2026',
  studios: {
    Studio: {
      fullName: 'Studio',
      address: 'Studio Street',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
};

describe('useConfig error boundaries', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    fs.exists.mockResolvedValue(false);
    invoke.mockResolvedValue('/tmp/config.yaml');
  });

  afterAll(restoreDom);

  it('handles an ordinary settings save failure without exposing a fatal load error', async () => {
    fs.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.save(legacyConfig);
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toBeUndefined();
    expect(result.current.config).not.toEqual(legacyConfig);
    expect(result.current.loadError).toBeNull();
    expect(result.current.saveError).toContain('disk full');
  });

  it('offers Drive activation a throwing save boundary without making the failure fatal', async () => {
    fs.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.saveOrThrow(legacyConfig);
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toEqual(expect.objectContaining({ message: 'disk full' }));
    expect(result.current.loadError).toBeNull();
    expect(result.current.saveError).toContain('disk full');
  });

  it('reserves loadError for a failed initial configuration load', async () => {
    fs.exists.mockRejectedValueOnce(new Error('invalid config bytes'));
    const { result } = renderHook(() => useConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toContain('invalid config bytes');
    expect(result.current.saveError).toBeNull();
  });
});
