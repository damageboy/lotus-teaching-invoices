import React from 'react';
import { flushSync } from 'react-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { CalendarListEntry } from '../../src/lib/calendar/calendar-api.js';
import { listCalendars } from '../../src/lib/calendar/calendar-api.js';
import type { AppConfig } from '../../src/lib/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const unconfiguredConfig: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {},
};

const dependencies = { listCalendars: vi.fn<typeof listCalendars>() };

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useCalendarPicker } = await import('../../src/hooks/useCalendarPicker.js');

function renderControlledPicker(
  initialConfig: AppConfig,
  persist: (next: AppConfig) => Promise<void>
) {
  return renderHook(() => {
    const [config, setConfig] = React.useState(initialConfig);
    const saveConfig = React.useCallback(
      async (next: AppConfig) => {
        await persist(next);
        flushSync(() => {
          setConfig({
            teacher: next.teacher,
            ...(next.calendarId ? { calendarId: next.calendarId } : {}),
            ...(next.calendarName ? { calendarName: next.calendarName } : {}),
            ...(next.calendarAccessRole ? { calendarAccessRole: next.calendarAccessRole } : {}),
            ...(next.outputDir ? { outputDir: next.outputDir } : {}),
            ...(next.lastInvoice ? { lastInvoice: next.lastInvoice } : {}),
            studios: next.studios,
          });
        });
      },
      [persist]
    );
    return {
      config,
      setConfig,
      picker: useCalendarPicker({ config, saveConfig }, dependencies),
    };
  });
}

beforeEach(() => {
  dependencies.listCalendars.mockReset();
  dependencies.listCalendars.mockResolvedValue([]);
});

afterEach(() => cleanup());
afterAll(() => restoreDom());

describe('useCalendarPicker', () => {
  it('does not publish a Calendar selection until durable save succeeds', async () => {
    const pending = deferred<void>();
    const saveConfig = vi.fn(() => pending.promise);
    const view = renderHook(() =>
      useCalendarPicker({ config: unconfiguredConfig, saveConfig }, dependencies)
    );
    await act(() => view.result.current.openList());
    let selection!: Promise<void>;
    act(() => {
      selection = view.result.current.select({
        id: 'calendar-a',
        summary: 'Teaching',
        accessRole: 'owner',
      });
    });

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'calendar-a', calendarName: 'Teaching' })
    );
    expect(view.result.current.selectedName).toBe('Selected calendar');
    expect(view.result.current.listOpen).toBe(true);
    await act(async () => {
      pending.resolve();
      await selection;
    });
    expect(view.result.current.listOpen).toBe(false);
  });

  it('keeps the list open and reports a failed config save', async () => {
    const saveConfig = vi.fn(async () => {
      throw new Error('disk full');
    });
    const view = renderHook(() =>
      useCalendarPicker({ config: unconfiguredConfig, saveConfig }, dependencies)
    );
    await act(() => view.result.current.openList());
    await act(async () => {
      await expect(
        view.result.current.select({
          id: 'calendar-a',
          summary: 'Teaching',
          accessRole: 'owner',
        })
      ).resolves.toBeUndefined();
    });
    expect(view.result.current.error).toBe('disk full');
    expect(view.result.current.listOpen).toBe(true);
  });

  it('removes a previously persisted access role when the selected entry has none', async () => {
    const saveConfig = vi.fn(async () => undefined);
    const view = renderHook(() =>
      useCalendarPicker(
        {
          config: { ...unconfiguredConfig, calendarAccessRole: 'owner' },
          saveConfig,
        },
        dependencies
      )
    );

    await act(() => view.result.current.select({ id: 'calendar-a', summary: 'Teaching' }));

    const selected = saveConfig.mock.calls[0][0];
    expect(selected).not.toHaveProperty('calendarAccessRole');
    expect(JSON.parse(JSON.stringify(selected))).not.toHaveProperty('calendarAccessRole');
  });

  it('reports a failed Calendar list request without rejecting the button promise', async () => {
    dependencies.listCalendars.mockRejectedValueOnce(new Error('authorization denied'));
    const view = renderHook(() =>
      useCalendarPicker(
        { config: unconfiguredConfig, saveConfig: vi.fn(async () => undefined) },
        dependencies
      )
    );

    await act(async () => {
      await expect(view.result.current.openList()).resolves.toBeUndefined();
    });

    expect(view.result.current.error).toBe('authorization denied');
    expect(view.result.current.listOpen).toBe(false);
  });

  it('formats a structured Calendar error for stable display', async () => {
    dependencies.listCalendars.mockRejectedValueOnce({
      code: 'rateLimited',
      message: 'Calendar quota exceeded',
    });
    const view = renderHook(() =>
      useCalendarPicker(
        { config: unconfiguredConfig, saveConfig: vi.fn(async () => undefined) },
        dependencies
      )
    );

    await act(() => view.result.current.openList());

    expect(view.result.current.error).toBe('Calendar quota exceeded (rateLimited)');
  });

  it('ignores a list or save completion from an older close/reopen session', async () => {
    const first = deferred<CalendarListEntry[]>();
    const second = deferred<CalendarListEntry[]>();
    dependencies.listCalendars
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = renderHook(() =>
      useCalendarPicker(
        { config: unconfiguredConfig, saveConfig: vi.fn(async () => undefined) },
        dependencies
      )
    );
    act(() => {
      void view.result.current.openList();
    });
    act(() => view.result.current.closeList());
    act(() => {
      void view.result.current.openList();
    });
    await act(async () => {
      first.resolve([{ id: 'stale', summary: 'Stale' }]);
      await first.promise;
    });
    expect(view.result.current.calendars).toBeNull();

    second.resolve([{ id: 'current', summary: 'Current' }]);
    await waitFor(() => expect(view.result.current.calendars?.[0]?.id).toBe('current'));
  });

  it('does not let an older save close a reopened list', async () => {
    const firstWrite = deferred<void>();
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length === 1) await firstWrite.promise;
    });
    const view = renderControlledPicker(unconfiguredConfig, persist);
    await act(() => view.result.current.picker.openList());
    let selection!: Promise<void>;
    act(() => {
      selection = view.result.current.picker.select({ id: 'calendar-a', summary: 'Teaching' });
    });
    act(() => view.result.current.picker.closeList());
    await act(() => view.result.current.picker.openList());

    await act(async () => {
      firstWrite.resolve();
      await selection;
    });

    expect(view.result.current.config).toEqual(unconfiguredConfig);
    expect(view.result.current.picker.listOpen).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('restores the current A incarnation when an older selection publishes after A to B to A', async () => {
    const firstWrite = deferred<void>();
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length === 1) await firstWrite.promise;
    });
    const calendarA = { ...unconfiguredConfig, calendarId: 'calendar-a', calendarName: 'A' };
    const calendarB = { ...unconfiguredConfig, calendarId: 'calendar-b', calendarName: 'B' };
    const view = renderControlledPicker(calendarA, persist);
    await act(() => view.result.current.picker.openList());
    let selection!: Promise<void>;
    act(() => {
      selection = view.result.current.picker.select({
        id: 'calendar-c',
        summary: 'C',
        accessRole: 'owner',
      });
    });

    act(() => view.result.current.setConfig(calendarB));
    act(() => view.result.current.setConfig(calendarA));
    await act(() => view.result.current.picker.openList());
    expect(view.result.current.picker.saving).toBe(true);
    await act(async () => {
      firstWrite.resolve();
      await selection;
    });

    expect(view.result.current.config).toEqual(calendarA);
    expect(view.result.current.picker.listOpen).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('keeps Calendar selection persistence single-flight', async () => {
    const pending = deferred<void>();
    const persist = vi.fn(() => pending.promise);
    const view = renderControlledPicker(unconfiguredConfig, persist);
    let firstSelection!: Promise<void>;
    let secondSelection!: Promise<void>;
    act(() => {
      firstSelection = view.result.current.picker.select({ id: 'calendar-a', summary: 'A' });
      secondSelection = view.result.current.picker.select({ id: 'calendar-b', summary: 'B' });
    });

    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await Promise.all([firstSelection, secondSelection]);
    });
    expect(view.result.current.config.calendarId).toBe('calendar-a');
  });

  it('merges a Calendar selection into the latest config after a concurrent Rates edit', async () => {
    const firstWrite = deferred<void>();
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length === 1) await firstWrite.promise;
    });
    const view = renderControlledPicker(unconfiguredConfig, persist);
    let selection!: Promise<void>;
    act(() => {
      selection = view.result.current.picker.select({
        id: 'calendar-a',
        summary: 'Teaching',
        accessRole: 'writer',
      });
    });
    act(() => {
      view.result.current.setConfig({
        ...unconfiguredConfig,
        teacher: { ...unconfiguredConfig.teacher, name: 'Edited Teacher' },
      });
    });

    await act(async () => {
      firstWrite.resolve();
      await selection;
    });

    expect(view.result.current.config.teacher.name).toBe('Edited Teacher');
    expect(view.result.current.config.calendarId).toBe('calendar-a');
    expect(view.result.current.config.calendarName).toBe('Teaching');
    expect(view.result.current.config.calendarAccessRole).toBe('writer');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not publish the first A request into a later A incarnation', async () => {
    const first = deferred<CalendarListEntry[]>();
    const second = deferred<CalendarListEntry[]>();
    dependencies.listCalendars
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const calendarA = { ...unconfiguredConfig, calendarId: 'calendar-a', calendarName: 'A' };
    const calendarB = { ...unconfiguredConfig, calendarId: 'calendar-b', calendarName: 'B' };
    const saveConfig = vi.fn(async () => undefined);
    const view = renderHook(
      ({ config }: { config: AppConfig }) =>
        useCalendarPicker({ config, saveConfig }, dependencies),
      { initialProps: { config: calendarA } }
    );

    act(() => {
      void view.result.current.openList();
    });
    view.rerender({ config: calendarB });
    view.rerender({ config: calendarA });
    act(() => {
      void view.result.current.openList();
    });

    await act(async () => {
      first.resolve([{ id: 'stale', summary: 'Stale' }]);
      await first.promise;
    });
    expect(view.result.current.calendars).toBeNull();

    second.resolve([{ id: 'current', summary: 'Current' }]);
    await waitFor(() => expect(view.result.current.calendars?.[0]?.id).toBe('current'));
  });

  it('looks up the display name non-interactively for a legacy Calendar ID', async () => {
    dependencies.listCalendars.mockResolvedValueOnce([
      { id: 'calendar-a', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const view = renderHook(() =>
      useCalendarPicker(
        {
          config: { ...unconfiguredConfig, calendarId: 'calendar-a' },
          saveConfig: vi.fn(async () => undefined),
        },
        dependencies
      )
    );

    await waitFor(() => expect(view.result.current.selectedName).toBe('Teaching'));
    expect(dependencies.listCalendars).toHaveBeenCalledWith();
  });

  it('repeats legacy-name lookup after a role-only Calendar identity change', async () => {
    dependencies.listCalendars.mockResolvedValue([
      { id: 'calendar-a', summary: 'Teaching', accessRole: 'writer' },
    ]);
    const ownerConfig: AppConfig = {
      ...unconfiguredConfig,
      calendarId: 'calendar-a',
      calendarAccessRole: 'owner',
    };
    const view = renderControlledPicker(
      ownerConfig,
      vi.fn(async () => undefined)
    );
    await waitFor(() => expect(view.result.current.picker.selectedName).toBe('Teaching'));

    act(() => {
      view.result.current.setConfig({ ...ownerConfig, calendarAccessRole: 'writer' });
    });

    await waitFor(() => expect(view.result.current.picker.selectedName).toBe('Teaching'));
    expect(dependencies.listCalendars).toHaveBeenCalledTimes(2);
  });

  it('remains active after React Strict Mode replays mount effects', async () => {
    dependencies.listCalendars.mockResolvedValue([
      { id: 'calendar-a', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const view = renderHook(
      () =>
        useCalendarPicker(
          {
            config: { ...unconfiguredConfig, calendarId: 'calendar-a' },
            saveConfig: vi.fn(async () => undefined),
          },
          dependencies
        ),
      { wrapper: React.StrictMode }
    );

    await waitFor(() => expect(view.result.current.selectedName).toBe('Teaching'));
  });
});
