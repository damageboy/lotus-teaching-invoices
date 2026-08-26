import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CalendarPickerController } from '../../src/hooks/useCalendarPicker.js';
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
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import('@testing-library/react');
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;
const { useConfig } = await import('../../src/hooks/useConfig.js');
const { RatesTab } = await import('../../src/components/RatesTab/index.js');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

const calendarPicker: CalendarPickerController = {
  calendars: null,
  listOpen: false,
  loading: false,
  saving: false,
  error: null,
  selectedName: 'Selected calendar',
  openList: vi.fn(async () => undefined),
  select: vi.fn(async () => undefined),
  closeList: vi.fn(),
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
    act(() => result.current.updateConfig(legacyConfig));

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.save();
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toBeUndefined();
    expect(result.current.config).toEqual(legacyConfig);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.loadError).toBeNull();
    expect(result.current.saveError).toContain('disk full');
  });

  it('offers Drive activation a throwing save boundary without making the failure fatal', async () => {
    fs.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.updateConfig(legacyConfig));

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.saveOrThrow();
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

  it('serializes an older ordinary save before a later conditional Calendar update', async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    fs.writeTextFile
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const ratesConfig: AppConfig = {
      ...legacyConfig,
      teacher: { ...legacyConfig.teacher, name: 'Edited Teacher' },
    };
    act(() => result.current.updateConfig(ratesConfig));
    let ratesSave!: Promise<void>;
    let calendarSave!: Promise<void>;
    act(() => {
      ratesSave = result.current.save();
      calendarSave = result.current.saveUpdateOrThrow((current) => ({
        ...current,
        calendarId: 'calendar-b',
        calendarName: 'Teaching',
        calendarAccessRole: 'writer',
      }));
    });

    await waitFor(() => expect(fs.writeTextFile).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await waitFor(() => expect(fs.writeTextFile).toHaveBeenCalledTimes(2));
    const durableCalendarConfig = parseYaml(fs.writeTextFile.mock.calls[1][1]);
    expect(durableCalendarConfig.teacher.name).toBe('Edited Teacher');
    expect(durableCalendarConfig.calendarId).toBe('calendar-b');
    secondWrite.resolve();
    await act(() => Promise.all([ratesSave, calendarSave]));

    expect(result.current.config.teacher.name).toBe('Edited Teacher');
    expect(result.current.config.calendarId).toBe('calendar-b');
  });

  it('rejects a stale Calendar save when repairing the latest config fails', async () => {
    const staleWrite = deferred<void>();
    fs.writeTextFile
      .mockImplementationOnce(() => staleWrite.promise)
      .mockRejectedValueOnce(new Error('repair failed'));
    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let active = true;
    let calendarSave!: Promise<void>;
    act(() => {
      calendarSave = result.current.saveUpdateOrThrow((current) =>
        active
          ? {
              ...current,
              calendarId: 'calendar-b',
              calendarName: 'Teaching',
            }
          : null
      );
    });
    await waitFor(() => expect(fs.writeTextFile).toHaveBeenCalledTimes(1));
    const latestConfig: AppConfig = {
      ...legacyConfig,
      teacher: { ...legacyConfig.teacher, name: 'Latest Teacher' },
    };
    active = false;
    act(() => result.current.updateConfig(latestConfig));

    let rejection: unknown;
    await act(async () => {
      staleWrite.resolve();
      try {
        await calendarSave;
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toEqual(expect.objectContaining({ message: 'repair failed' }));
    expect(fs.writeTextFile).toHaveBeenCalledTimes(2);
    const attemptedRepair = parseYaml(fs.writeTextFile.mock.calls[1][1]);
    expect(attemptedRepair.teacher.name).toBe('Latest Teacher');
    expect(result.current.config).toEqual(latestConfig);
    expect(result.current.saveError).toContain('repair failed');
  });

  it('keeps a clean-config repair failure unsaved and retryable until disk is current', async () => {
    const staleWrite = deferred<void>();
    const retryWrite = deferred<void>();
    fs.writeTextFile
      .mockImplementationOnce(() => staleWrite.promise)
      .mockRejectedValueOnce(new Error('repair failed'))
      .mockImplementationOnce(() => retryWrite.promise);
    let latest!: ReturnType<typeof useConfig>;
    function Harness() {
      latest = useConfig();
      return (
        <RatesTab
          layout="mobile"
          config={latest.config}
          calendarPicker={calendarPicker}
          isDirty={latest.isDirty}
          saveError={latest.saveError}
          onUpdate={latest.updateConfig}
          onSave={latest.save}
        />
      );
    }
    const view = render(<Harness />);
    await waitFor(() => expect(view.getByText('Saved')).toBeTruthy());
    const saveButton = view.getByRole('button', {
      name: 'Save settings',
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    let active = true;
    let calendarSave!: Promise<void>;
    act(() => {
      calendarSave = latest.saveUpdateOrThrow((current) =>
        active
          ? {
              ...current,
              calendarId: 'stale-calendar',
              calendarName: 'Stale',
            }
          : null
      );
    });
    await waitFor(() => expect(fs.writeTextFile).toHaveBeenCalledTimes(1));
    active = false;
    await act(async () => {
      staleWrite.resolve();
      await expect(calendarSave).rejects.toThrow('repair failed');
    });

    expect(view.getByText('Save failed')).toBeTruthy();
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(fs.writeTextFile).toHaveBeenCalledTimes(3));
    expect(view.queryByText('Saved')).toBeNull();
    expect(view.getByText('Unsaved changes')).toBeTruthy();

    retryWrite.resolve();
    await waitFor(() => expect(view.getByText('Saved')).toBeTruthy());
    expect(saveButton.disabled).toBe(true);
    const repaired = parseYaml(fs.writeTextFile.mock.calls[2][1]);
    expect(repaired.calendarId).toBeUndefined();
  });
});
