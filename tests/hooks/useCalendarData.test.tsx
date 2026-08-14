import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig, CalendarEvent } from '../../src/lib/types.js';
import { calendarEvent } from '../helpers/calendar-fixtures.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

vi.mock('../../src/lib/calendar/cache', () => ({
  listCachedCalendarEvents: vi.fn(),
  syncCalendar: vi.fn(),
}));
vi.mock('../../src/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const restoreDom = installReactTestEnvironment();
const { act, cleanup, render, renderHook, waitFor } = await import('@testing-library/react');
const { flushSync } = await import('react-dom');
const cacheMocks = await import('../../src/lib/calendar/cache.js');
const loggerMocks = await import('../../src/lib/logger.js');
const { useCalendarData } = await import('../../src/hooks/useCalendarData.js');

const studio = {
  fullName: 'Studio',
  address: '',
  rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
};

function config(calendarId?: string, studioNames: string[] = ['Studio']): AppConfig {
  return {
    teacher: {
      name: 'Teacher',
      address: '',
      taxNumber: '',
      bankDetails: { accountOwner: '', iban: '', bic: '' },
    },
    ...(calendarId ? { calendarId } : {}),
    outputDir: '',
    lastInvoice: '',
    studios: Object.fromEntries(studioNames.map((name) => [name, { ...studio, fullName: name }])),
  };
}

function cachedEvent(calendarId: string, eventId: string, summary: string): CalendarEvent {
  return calendarEvent({
    identity: { calendarId, eventId },
    summary,
    description: '5',
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const successfulSync = {
  fullSync: false,
  fetched: 1,
  upserted: 1,
  deleted: 0,
};

function renderSuspendableCalendar(calendarId = 'calendar-a') {
  const suspension = new Promise<never>(() => {});
  let committedData: ReturnType<typeof useCalendarData> | undefined;
  let setSuspended: React.Dispatch<React.SetStateAction<boolean>> | undefined;

  function Harness() {
    const [isSuspended, updateSuspended] = React.useState(false);
    setSuspended = updateSuspended;
    const data = useCalendarData(config(calendarId));
    React.useLayoutEffect(() => {
      committedData = data;
    });
    if (isSuspended) throw suspension;
    return <div>{data.classes[0]?.classType ?? 'empty'}</div>;
  }

  const view = render(
    <React.Suspense fallback={<div>fallback</div>}>
      <Harness />
    </React.Suspense>
  );

  return {
    view,
    current() {
      if (!committedData) throw new Error('calendar hook did not commit');
      return committedData;
    },
    suspend(value: boolean) {
      if (!setSuspended) throw new Error('calendar hook did not commit');
      act(() => setSuspended?.(value));
    },
    async settleThenSuspend(settle: () => void) {
      if (!setSuspended) throw new Error('calendar hook did not commit');
      await act(async () => {
        settle();
        await new Promise<void>((resolve) => {
          queueMicrotask(() => {
            flushSync(() => setSuspended?.(true));
            resolve();
          });
        });
        await Promise.resolve();
      });
    },
  };
}

function renderRemovableCalendar(onRemovedInLayout: () => void, calendarId = 'calendar-a') {
  const lifecycle: string[] = [];
  let committedData: ReturnType<typeof useCalendarData> | undefined;
  let setVisible: React.Dispatch<React.SetStateAction<boolean>> | undefined;

  function CalendarChild() {
    const data = useCalendarData(config(calendarId));
    React.useLayoutEffect(() => {
      committedData = data;
    });
    React.useLayoutEffect(
      () => () => {
        lifecycle.push('child layout cleanup');
      },
      []
    );
    React.useEffect(
      () => () => {
        lifecycle.push('child passive cleanup');
      },
      []
    );
    return null;
  }

  function Parent() {
    const [visible, updateVisible] = React.useState(true);
    setVisible = updateVisible;
    React.useLayoutEffect(() => {
      if (!visible) {
        lifecycle.push('parent layout callback');
        onRemovedInLayout();
      }
    }, [visible]);
    return visible ? <CalendarChild /> : null;
  }

  render(<Parent />);

  return {
    lifecycle,
    current() {
      if (!committedData) throw new Error('calendar hook did not commit');
      return committedData;
    },
    async remove() {
      if (!setVisible) throw new Error('calendar parent did not commit');
      const actEnvironment = globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      };
      const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        setVisible(false);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      } finally {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
      await act(async () => {});
    },
  };
}

beforeEach(() => {
  cacheMocks.listCachedCalendarEvents.mockReset();
  cacheMocks.syncCalendar.mockReset();
  loggerMocks.logInfo.mockReset();
  loggerMocks.logWarn.mockReset();
  loggerMocks.logError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  restoreDom();
});

describe('useCalendarData', () => {
  it('shows the existing helpful error without cache or sync calls when no calendar is selected', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => useCalendarData(value),
      { initialProps: { value: config() } }
    );

    expect(result.current.error).toBe('No calendar selected. Pick one in the Rates tab.');
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh();
      await result.current.reloadCache();
    });

    rerender({ value: config(undefined, ['Studio', 'New Studio']) });

    expect(result.current.error).toBe('No calendar selected. Pick one in the Rates tab.');
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.listCachedCalendarEvents).not.toHaveBeenCalled();
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
  });

  it('continues refresh when a manual reload supersedes its pending initial cache display', async () => {
    const initialCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockReturnValueOnce(initialCache.promise)
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'manual-1', 'Studio / Manual cached Flow')])
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'synced-1', 'Studio / Synced Flow')]);
    cacheMocks.syncCalendar.mockResolvedValue(successfulSync);
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1));

    await act(async () => result.current.reloadCache());
    expect(result.current.classes[0]?.classType).toBe('Manual cached Flow');

    await act(async () => {
      initialCache.resolve([
        cachedEvent('calendar-1', 'initial-1', 'Studio / Initial cached Flow'),
      ]);
      await refresh;
    });

    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(3);
    expect(result.current.classes[0]?.classType).toBe('Synced Flow');
  });

  it('continues refresh when its superseded initial cache read rejects after a manual reload succeeds', async () => {
    const initialCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockReturnValueOnce(initialCache.promise)
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'manual-1', 'Studio / Manual cached Flow')])
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'synced-1', 'Studio / Synced Flow')]);
    cacheMocks.syncCalendar.mockResolvedValue(successfulSync);
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1));

    await act(async () => result.current.reloadCache());
    expect(result.current.classes[0]?.classType).toBe('Manual cached Flow');

    await act(async () => {
      initialCache.reject(new Error('superseded initial cache failed'));
      await refresh;
    });

    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(3);
    expect(result.current.classes[0]?.classType).toBe('Synced Flow');
    expect(result.current.error).toBeNull();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('does not let a stale manual cache result overwrite the later post-sync cache', async () => {
    const sync = deferred<typeof successfulSync>();
    const manualCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-1', 'initial-1', 'Studio / Initial cached Flow'),
      ])
      .mockReturnValueOnce(manualCache.promise)
      .mockResolvedValueOnce([
        cachedEvent('calendar-1', 'synced-1', 'Studio / Authoritative Flow'),
      ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reloadCache();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));

    await act(async () => {
      sync.resolve(successfulSync);
      await refresh;
    });
    expect(result.current.classes[0]?.classType).toBe('Authoritative Flow');

    await act(async () => {
      manualCache.resolve([cachedEvent('calendar-1', 'manual-1', 'Studio / Stale manual Flow')]);
      await reload;
    });

    expect(result.current.classes[0]?.classType).toBe('Authoritative Flow');
    expect(result.current.error).toBeNull();
  });

  it('does not report a stale manual cache rejection after a successful post-sync reload', async () => {
    const sync = deferred<typeof successfulSync>();
    const manualCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-1', 'initial-1', 'Studio / Initial cached Flow'),
      ])
      .mockReturnValueOnce(manualCache.promise)
      .mockResolvedValueOnce([
        cachedEvent('calendar-1', 'synced-1', 'Studio / Authoritative Flow'),
      ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reloadCache();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));

    await act(async () => {
      sync.resolve(successfulSync);
      await refresh;
    });
    await act(async () => {
      manualCache.reject(new Error('stale cache failed'));
      await reload;
    });

    expect(result.current.classes[0]?.classType).toBe('Authoritative Flow');
    expect(result.current.error).toBeNull();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  for (const outcome of ['resolves', 'rejects'] as const) {
    it(`ignores a pending calendar-A cache read that ${outcome} after switching to B`, async () => {
      const calendarACache = deferred<CalendarEvent[]>();
      cacheMocks.listCachedCalendarEvents.mockImplementation((calendarId: string) => {
        if (calendarId === 'calendar-a') return calendarACache.promise;
        return Promise.resolve([
          cachedEvent('calendar-b', 'b-1', 'Studio / Calendar B'),
          cachedEvent('calendar-b', 'b-warning', 'invalid summary'),
        ]);
      });
      const renderSnapshots: Array<{
        calendarId?: string;
        classTypes: string[];
        warningCodes: string[];
        error: string | null;
        isLoading: boolean;
      }> = [];
      const { result, rerender } = renderHook(
        ({ value }: { value: AppConfig }) => {
          const data = useCalendarData(value);
          renderSnapshots.push({
            calendarId: value.calendarId,
            classTypes: data.classes.map((lesson) => lesson.classType),
            warningCodes: data.warnings.map((warning) => warning.code),
            error: data.error,
            isLoading: data.isLoading,
          });
          return data;
        },
        { initialProps: { value: config('calendar-a') } }
      );

      let refreshA!: Promise<void>;
      act(() => {
        refreshA = result.current.refresh();
      });
      await waitFor(() =>
        expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledWith('calendar-a')
      );

      const snapshotStart = renderSnapshots.length;
      rerender({ value: config('calendar-b') });
      const firstCalendarBRender = renderSnapshots
        .slice(snapshotStart)
        .find((snapshot) => snapshot.calendarId === 'calendar-b');
      expect(firstCalendarBRender).toEqual({
        calendarId: 'calendar-b',
        classTypes: [],
        warningCodes: [],
        error: null,
        isLoading: false,
      });

      await act(async () => result.current.reloadCache());
      expect(result.current.classes.map((lesson) => lesson.classType)).toEqual(['Calendar B']);
      expect(result.current.warnings.map((warning) => warning.code)).toEqual(['NO_SEPARATOR']);
      loggerMocks.logInfo.mockClear();
      loggerMocks.logWarn.mockClear();
      loggerMocks.logError.mockClear();

      await act(async () => {
        if (outcome === 'resolves') {
          calendarACache.resolve([cachedEvent('calendar-a', 'a-1', 'Studio / Stale Calendar A')]);
        } else {
          calendarACache.reject(new Error('stale calendar A cache failed'));
        }
        await refreshA;
      });

      expect(result.current.classes.map((lesson) => lesson.classType)).toEqual(['Calendar B']);
      expect(result.current.warnings.map((warning) => warning.code)).toEqual(['NO_SEPARATOR']);
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
      expect(loggerMocks.logInfo).not.toHaveBeenCalled();
      expect(loggerMocks.logWarn).not.toHaveBeenCalled();
      expect(loggerMocks.logError).not.toHaveBeenCalled();
    });
  }

  it('hides calendar-A data and status in the first render after switching to B', async () => {
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-a', 'a-1', 'Studio / Calendar A'),
      cachedEvent('calendar-a', 'a-warning', 'invalid summary'),
    ]);
    cacheMocks.syncCalendar.mockRejectedValue(new Error('calendar A offline'));
    const renderSnapshots: Array<{
      calendarId?: string;
      classTypes: string[];
      warningCodes: string[];
      error: string | null;
      isLoading: boolean;
    }> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => {
        const data = useCalendarData(value);
        renderSnapshots.push({
          calendarId: value.calendarId,
          classTypes: data.classes.map((lesson) => lesson.classType),
          warningCodes: data.warnings.map((warning) => warning.code),
          error: data.error,
          isLoading: data.isLoading,
        });
        return data;
      },
      { initialProps: { value: config('calendar-a') } }
    );

    await act(async () => result.current.refresh());
    expect(result.current.classes[0]?.classType).toBe('Calendar A');
    expect(result.current.warnings[0]?.code).toBe('NO_SEPARATOR');
    expect(result.current.error).toBe('Failed to sync calendar: calendar A offline');

    const snapshotStart = renderSnapshots.length;
    rerender({ value: config('calendar-b') });
    const firstCalendarBRender = renderSnapshots
      .slice(snapshotStart)
      .find((snapshot) => snapshot.calendarId === 'calendar-b');

    expect(firstCalendarBRender).toEqual({
      calendarId: 'calendar-b',
      classTypes: [],
      warningCodes: [],
      error: null,
      isLoading: false,
    });
  });

  it('keeps committed calendar A usable when a transition renders B but never commits it', async () => {
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([cachedEvent('calendar-a', 'a-1', 'Studio / Calendar A cached')])
      .mockResolvedValueOnce([cachedEvent('calendar-a', 'a-2', 'Studio / Calendar A refreshed')]);
    const suspended = new Promise<never>(() => {});
    const renderedCalendarIds: Array<string | undefined> = [];
    let committedData: ReturnType<typeof useCalendarData> | undefined;
    let setValue: React.Dispatch<React.SetStateAction<AppConfig>> | undefined;
    const calendarA = config('calendar-a');

    function Harness() {
      const [value, setConfig] = React.useState(calendarA);
      setValue = setConfig;
      const data = useCalendarData(value);
      renderedCalendarIds.push(value.calendarId);
      React.useLayoutEffect(() => {
        committedData = data;
      });
      if (value.calendarId === 'calendar-b') throw suspended;
      return <div>{data.classes[0]?.classType ?? 'empty'}</div>;
    }

    const view = render(
      <React.Suspense fallback={<div>loading</div>}>
        <Harness />
      </React.Suspense>
    );
    if (!committedData || !setValue) throw new Error('calendar A did not commit');

    await act(async () => committedData?.reloadCache());
    expect(view.container.textContent).toBe('Calendar A cached');

    act(() => {
      React.startTransition(() => setValue?.(config('calendar-b')));
    });
    expect(renderedCalendarIds).toContain('calendar-b');
    expect(view.container.textContent).toBe('Calendar A cached');

    await act(async () => committedData?.reloadCache());
    expect(cacheMocks.listCachedCalendarEvents.mock.calls).toEqual([
      ['calendar-a'],
      ['calendar-a'],
    ]);
    expect(view.container.textContent).toBe('Calendar A refreshed');

    act(() => setValue?.({ ...calendarA }));
    expect(view.container.textContent).toBe('Calendar A refreshed');
  });

  it('keeps a superseding usable cache across a Suspense hide and reveal', async () => {
    const initialRefreshCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
      ])
      .mockReturnValueOnce(initialRefreshCache.promise)
      .mockResolvedValueOnce([cachedEvent('calendar-a', 'manual-1', 'Studio / Manual Calendar A')])
      .mockResolvedValueOnce([cachedEvent('calendar-a', 'synced-1', 'Studio / Synced Calendar A')]);
    cacheMocks.syncCalendar.mockResolvedValue(successfulSync);
    const hidden = new Promise<never>(() => {});
    let committedData: ReturnType<typeof useCalendarData> | undefined;
    let setHidden: React.Dispatch<React.SetStateAction<boolean>> | undefined;

    function Harness() {
      const [isHidden, updateHidden] = React.useState(false);
      setHidden = updateHidden;
      const data = useCalendarData(config('calendar-a'));
      React.useLayoutEffect(() => {
        committedData = data;
      });
      if (isHidden) throw hidden;
      return <div>{data.classes[0]?.classType ?? 'empty'}</div>;
    }

    const view = render(
      <React.Suspense fallback={<div>fallback</div>}>
        <Harness />
      </React.Suspense>
    );
    if (!committedData || !setHidden) throw new Error('calendar A did not commit');

    await act(async () => committedData?.reloadCache());
    expect(view.container.textContent).toBe('Preloaded Calendar A');

    let refresh!: Promise<void>;
    act(() => {
      refresh = committedData!.refresh();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));

    await act(async () => committedData?.reloadCache());
    expect(view.container.textContent).toBe('Manual Calendar A');

    act(() => setHidden?.(true));
    expect(view.getByText('fallback')).toBeTruthy();

    act(() => setHidden?.(false));
    expect(view.queryByText('fallback')).toBeNull();
    expect(view.container.textContent).toBe('Manual Calendar A');

    await act(async () => {
      initialRefreshCache.reject(new Error('superseded initial cache failed'));
      await refresh;
    });

    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(4);
    expect(view.container.textContent).toBe('Synced Calendar A');
    expect(committedData?.error).toBeNull();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('keeps a distinct committed A2 authoritative after pending A1 reads settle', async () => {
    const a1InitialCache = deferred<CalendarEvent[]>();
    const a1ManualCache = deferred<CalendarEvent[]>();
    let calendarAReadCount = 0;
    cacheMocks.listCachedCalendarEvents.mockImplementation((calendarId: string) => {
      if (calendarId === 'calendar-b') {
        return Promise.resolve([cachedEvent('calendar-b', 'b-1', 'Studio / Calendar B')]);
      }

      calendarAReadCount += 1;
      if (calendarAReadCount === 1) return a1InitialCache.promise;
      if (calendarAReadCount === 2) return a1ManualCache.promise;
      return Promise.resolve([
        cachedEvent('calendar-a', 'a2-1', 'Studio / Calendar A2'),
        cachedEvent('calendar-a', 'a2-warning', 'invalid summary'),
      ]);
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => useCalendarData(value),
      { initialProps: { value: config('calendar-a') } }
    );
    const a1RefreshCallback = result.current.refresh;

    let a1Refresh!: Promise<void>;
    let a1ManualReload!: Promise<void>;
    act(() => {
      a1Refresh = result.current.refresh();
      a1ManualReload = result.current.reloadCache();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));

    rerender({ value: config('calendar-b') });
    await act(async () => result.current.reloadCache());
    expect(result.current.classes.map((lesson) => lesson.classType)).toEqual(['Calendar B']);

    rerender({ value: config('calendar-a') });
    expect(result.current.classes).toEqual([]);
    await act(async () => result.current.reloadCache());
    expect(result.current.classes.map((lesson) => lesson.classType)).toEqual(['Calendar A2']);
    expect(result.current.warnings.map((warning) => warning.code)).toEqual(['NO_SEPARATOR']);
    expect(result.current.refresh).not.toBe(a1RefreshCallback);
    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();

    await act(async () => {
      a1InitialCache.resolve([cachedEvent('calendar-a', 'a1-1', 'Studio / Stale Calendar A1')]);
      a1ManualCache.reject(new Error('stale calendar A1 cache failed'));
      await Promise.all([a1Refresh, a1ManualReload]);
    });

    expect(result.current.classes.map((lesson) => lesson.classType)).toEqual(['Calendar A2']);
    expect(result.current.warnings.map((warning) => warning.code)).toEqual(['NO_SEPARATOR']);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('settles a successful refresh and its authoritative cache while hidden', async () => {
    const sync = deferred<typeof successfulSync>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
      ])
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'refresh-1', 'Studio / Refresh cached Calendar A'),
      ])
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'synced-1', 'Studio / Authoritative Calendar A'),
      ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const harness = renderSuspendableCalendar();

    await act(async () => harness.current().reloadCache());
    let refresh!: Promise<void>;
    act(() => {
      refresh = harness.current().refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));
    expect(harness.current().classes[0]?.classType).toBe('Refresh cached Calendar A');
    expect(harness.current().isLoading).toBe(true);

    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();
    harness.suspend(true);
    expect(harness.view.getByText('fallback')).toBeTruthy();

    await act(async () => {
      sync.resolve(successfulSync);
      await Promise.resolve();
    });
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2);
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();

    harness.suspend(false);
    await act(async () => refresh);

    expect(harness.view.queryByText('fallback')).toBeNull();
    expect(harness.current().classes[0]?.classType).toBe('Authoritative Calendar A');
    expect(harness.current().error).toBeNull();
    expect(harness.current().isLoading).toBe(false);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(3);
    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(
      loggerMocks.logInfo.mock.calls.filter(([message]) => message.startsWith('Calendar loaded:'))
    ).toHaveLength(1);
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('settles a failed sync while hidden without losing its cached classes', async () => {
    const sync = deferred<never>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
      ])
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'refresh-1', 'Studio / Refresh cached Calendar A'),
      ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const harness = renderSuspendableCalendar();

    await act(async () => harness.current().reloadCache());
    let refresh!: Promise<void>;
    act(() => {
      refresh = harness.current().refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));
    harness.suspend(true);
    expect(harness.view.getByText('fallback')).toBeTruthy();

    await act(async () => {
      sync.reject(new Error('offline while hidden'));
      await Promise.resolve();
    });
    expect(loggerMocks.logError).not.toHaveBeenCalled();

    harness.suspend(false);
    await act(async () => refresh);

    expect(harness.current().classes[0]?.classType).toBe('Refresh cached Calendar A');
    expect(harness.current().error).toBe('Failed to sync calendar: offline while hidden');
    expect(harness.current().isLoading).toBe(false);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2);
    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(loggerMocks.logError).toHaveBeenCalledWith(
      'Failed to sync calendar: offline while hidden'
    );
  });

  for (const outcome of ['resolves', 'rejects'] as const) {
    it(`settles a manual cache reload that ${outcome} while hidden`, async () => {
      const manualCache = deferred<CalendarEvent[]>();
      cacheMocks.listCachedCalendarEvents
        .mockResolvedValueOnce([
          cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
        ])
        .mockReturnValueOnce(manualCache.promise);
      const harness = renderSuspendableCalendar();

      await act(async () => harness.current().reloadCache());
      let reload!: Promise<void>;
      act(() => {
        reload = harness.current().reloadCache();
      });
      await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));
      harness.suspend(true);
      expect(harness.view.getByText('fallback')).toBeTruthy();

      await act(async () => {
        if (outcome === 'resolves') {
          manualCache.resolve([
            cachedEvent('calendar-a', 'manual-1', 'Studio / Manual hidden Calendar A'),
          ]);
        } else {
          manualCache.reject(new Error('hidden cache unavailable'));
        }
        await Promise.resolve();
      });
      expect(loggerMocks.logError).not.toHaveBeenCalled();

      harness.suspend(false);
      await act(async () => reload);

      expect(harness.current().classes[0]?.classType).toBe(
        outcome === 'resolves' ? 'Manual hidden Calendar A' : 'Preloaded Calendar A'
      );
      expect(harness.current().error).toBe(
        outcome === 'resolves' ? null : 'Failed to load calendar cache: hidden cache unavailable'
      );
      expect(harness.current().isLoading).toBe(false);
      expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2);
      expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
      if (outcome === 'rejects') {
        expect(loggerMocks.logError).toHaveBeenCalledWith(
          'Failed to load calendar cache: hidden cache unavailable'
        );
      } else {
        expect(loggerMocks.logError).not.toHaveBeenCalled();
      }
    });
  }

  it('does not lose a reload when Suspense detaches at its attachment boundary', async () => {
    const reloadCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
      ])
      .mockReturnValueOnce(reloadCache.promise);
    const harness = renderSuspendableCalendar();

    await act(async () => harness.current().reloadCache());
    let reload!: Promise<void>;
    act(() => {
      reload = harness.current().reloadCache();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2));

    await harness.settleThenSuspend(() => {
      reloadCache.resolve([
        cachedEvent('calendar-a', 'reloaded-1', 'Studio / Reloaded Calendar A'),
      ]);
    });

    expect(harness.view.getByText('fallback')).toBeTruthy();

    harness.suspend(false);
    await act(async () => reload);

    expect(harness.current().classes[0]?.classType).toBe('Reloaded Calendar A');
    expect(harness.current().error).toBeNull();
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
  });

  it('settles a superseded reload without retaining an attachment waiter while hidden', async () => {
    const staleCache = deferred<CalendarEvent[]>();
    const currentCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([
        cachedEvent('calendar-a', 'preloaded-1', 'Studio / Preloaded Calendar A'),
      ])
      .mockReturnValueOnce(staleCache.promise)
      .mockReturnValueOnce(currentCache.promise);
    const harness = renderSuspendableCalendar();

    await act(async () => harness.current().reloadCache());
    let staleReload!: Promise<void>;
    let currentReload!: Promise<void>;
    let staleSettled = false;
    let currentSettled = false;
    act(() => {
      staleReload = harness.current().reloadCache();
      currentReload = harness.current().reloadCache();
      void staleReload.then(() => {
        staleSettled = true;
      });
      void currentReload.then(() => {
        currentSettled = true;
      });
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(3));
    harness.suspend(true);

    await act(async () => {
      staleCache.resolve([cachedEvent('calendar-a', 'stale-1', 'Studio / Stale Calendar A')]);
      await Promise.resolve();
    });
    expect(staleSettled).toBe(true);
    expect(currentSettled).toBe(false);

    await act(async () => {
      currentCache.resolve([cachedEvent('calendar-a', 'current-1', 'Studio / Current Calendar A')]);
      await Promise.resolve();
    });
    expect(currentSettled).toBe(false);

    harness.suspend(false);
    await act(async () => Promise.all([staleReload, currentReload]));

    expect(harness.current().classes[0]?.classType).toBe('Current Calendar A');
    expect(harness.current().error).toBeNull();
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
  });

  it('cancels an initial cache completion settled between removal layout and passive cleanup', async () => {
    const initialCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents.mockReturnValue(initialCache.promise);
    cacheMocks.syncCalendar.mockResolvedValue(successfulSync);
    let passiveCleanupObservedAtSettlement: boolean | undefined;
    let harness!: ReturnType<typeof renderRemovableCalendar>;
    harness = renderRemovableCalendar(() => {
      passiveCleanupObservedAtSettlement = harness.lifecycle.includes('child passive cleanup');
      initialCache.resolve([cachedEvent('calendar-a', 'removed-1', 'Studio / Removed Calendar A')]);
    });

    let refresh!: Promise<void>;
    act(() => {
      refresh = harness.current().refresh();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1));
    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();

    await harness.remove();
    await refresh;

    expect(passiveCleanupObservedAtSettlement).toBe(false);
    expect(harness.lifecycle).toEqual([
      'child layout cleanup',
      'parent layout callback',
      'child passive cleanup',
    ]);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('cancels a sync completion settled between removal layout and passive cleanup', async () => {
    const sync = deferred<typeof successfulSync>();
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-a', 'cached-1', 'Studio / Cached Calendar A'),
    ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    let passiveCleanupObservedAtSettlement: boolean | undefined;
    let harness!: ReturnType<typeof renderRemovableCalendar>;
    harness = renderRemovableCalendar(() => {
      passiveCleanupObservedAtSettlement = harness.lifecycle.includes('child passive cleanup');
      sync.resolve(successfulSync);
    });

    let refresh!: Promise<void>;
    act(() => {
      refresh = harness.current().refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();

    await harness.remove();
    await refresh;

    expect(passiveCleanupObservedAtSettlement).toBe(false);
    expect(harness.lifecycle).toEqual([
      'child layout cleanup',
      'parent layout callback',
      'child passive cleanup',
    ]);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1);
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
  });

  it('aborts sync and reports an initial cache-read failure as a cache error', async () => {
    cacheMocks.listCachedCalendarEvents.mockRejectedValue(new Error('database unavailable'));
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    await act(async () => result.current.refresh());

    expect(result.current.error).toBe('Failed to load calendar cache: database unavailable');
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(loggerMocks.logError).toHaveBeenCalledWith(
      'Failed to load calendar cache: database unavailable'
    );
  });

  it('reports a current manual reload failure as a cache error', async () => {
    cacheMocks.listCachedCalendarEvents.mockRejectedValue(new Error('database unavailable'));
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    await act(async () => result.current.reloadCache());

    expect(result.current.error).toBe('Failed to load calendar cache: database unavailable');
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(loggerMocks.logError).toHaveBeenCalledWith(
      'Failed to load calendar cache: database unavailable'
    );
  });

  it('does not parse or log until cache events have actually loaded', () => {
    const { rerender } = renderHook(({ value }: { value: AppConfig }) => useCalendarData(value), {
      initialProps: { value: config('calendar-1') },
    });

    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();

    rerender({ value: config('calendar-1', ['Studio', 'New Studio']) });

    expect(cacheMocks.listCachedCalendarEvents).not.toHaveBeenCalled();
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
  });

  it('does nothing after unmount while the initial cache read is pending', async () => {
    const initialCache = deferred<CalendarEvent[]>();
    cacheMocks.listCachedCalendarEvents.mockReturnValue(initialCache.promise);
    cacheMocks.syncCalendar.mockResolvedValue(successfulSync);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1));

    unmount();
    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();
    consoleError.mockClear();

    await act(async () => {
      initialCache.resolve([cachedEvent('calendar-1', 'cached-1', 'Studio / Should not load')]);
      await refresh;
    });

    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does nothing after unmount while remote sync is pending', async () => {
    const sync = deferred<typeof successfulSync>();
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-1', 'cached-1', 'Studio / Cached Flow'),
    ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => expect(cacheMocks.syncCalendar).toHaveBeenCalledTimes(1));
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);

    unmount();
    loggerMocks.logInfo.mockClear();
    loggerMocks.logWarn.mockClear();
    loggerMocks.logError.mockClear();
    consoleError.mockClear();

    await act(async () => {
      sync.resolve(successfulSync);
      await refresh;
    });

    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(loggerMocks.logInfo).not.toHaveBeenCalled();
    expect(loggerMocks.logWarn).not.toHaveBeenCalled();
    expect(loggerMocks.logError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('renders cached lessons before sync settles and preserves them if sync fails', async () => {
    const sync = deferred<never>();
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-1', 'cached-1', 'Studio / Cached Flow'),
    ]);
    cacheMocks.syncCalendar.mockReturnValue(sync.promise);
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });

    await waitFor(() => expect(result.current.classes[0]?.classType).toBe('Cached Flow'));
    expect(result.current.isLoading).toBe(true);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(cacheMocks.listCachedCalendarEvents.mock.invocationCallOrder[0]).toBeLessThan(
      cacheMocks.syncCalendar.mock.invocationCallOrder[0]
    );

    await act(async () => {
      sync.reject(new Error('offline'));
      await refresh;
    });

    expect(result.current.classes[0]?.classType).toBe('Cached Flow');
    expect(result.current.error).toBe('Failed to sync calendar: offline');
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
  });

  it('reloads and reparses the authoritative cache exactly once after a successful sync', async () => {
    cacheMocks.listCachedCalendarEvents
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'old-1', 'Studio / Cached Flow')])
      .mockResolvedValueOnce([cachedEvent('calendar-1', 'new-1', 'Studio / Synced Flow')]);
    cacheMocks.syncCalendar.mockResolvedValue({
      fullSync: false,
      fetched: 1,
      upserted: 1,
      deleted: 0,
    });
    const { result } = renderHook(() => useCalendarData(config('calendar-1')));
    loggerMocks.logInfo.mockClear();

    await act(async () => result.current.refresh());
    await waitFor(() => expect(result.current.classes[0]?.classType).toBe('Synced Flow'));

    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(2);
    expect(cacheMocks.listCachedCalendarEvents.mock.invocationCallOrder[0]).toBeLessThan(
      cacheMocks.syncCalendar.mock.invocationCallOrder[0]
    );
    expect(cacheMocks.syncCalendar.mock.invocationCallOrder[0]).toBeLessThan(
      cacheMocks.listCachedCalendarEvents.mock.invocationCallOrder[1]
    );
    expect(
      loggerMocks.logInfo.mock.calls.filter(([message]) => message.startsWith('Calendar loaded:'))
    ).toHaveLength(1);
  });

  it('ignores a stale calendar sync failure without overwriting the active calendar state', async () => {
    const syncA = deferred<never>();
    const syncB = deferred<{
      fullSync: boolean;
      fetched: number;
      upserted: number;
      deleted: number;
    }>();
    let bCacheReads = 0;
    cacheMocks.listCachedCalendarEvents.mockImplementation(async (calendarId: string) => {
      if (calendarId === 'calendar-a') {
        return [cachedEvent('calendar-a', 'a-1', 'Studio / Calendar A')];
      }
      bCacheReads += 1;
      return [
        cachedEvent(
          'calendar-b',
          `b-${bCacheReads}`,
          bCacheReads === 1 ? 'Studio / Calendar B cached' : 'Studio / Calendar B synced'
        ),
      ];
    });
    cacheMocks.syncCalendar.mockImplementation((calendarId: string) =>
      calendarId === 'calendar-a' ? syncA.promise : syncB.promise
    );

    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => useCalendarData(value),
      { initialProps: { value: config('calendar-a') } }
    );
    let refreshA!: Promise<void>;
    act(() => {
      refreshA = result.current.refresh();
    });
    await waitFor(() => expect(result.current.classes[0]?.classType).toBe('Calendar A'));

    rerender({ value: config('calendar-b') });
    let refreshB!: Promise<void>;
    act(() => {
      refreshB = result.current.refresh();
    });
    await waitFor(() => expect(result.current.classes[0]?.classType).toBe('Calendar B cached'));

    await act(async () => {
      syncA.reject(new Error('stale calendar failed'));
      await refreshA;
    });
    expect(result.current.classes[0]?.classType).toBe('Calendar B cached');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      syncB.resolve({ fullSync: false, fetched: 1, upserted: 1, deleted: 0 });
      await refreshB;
    });
    await waitFor(() => expect(result.current.classes[0]?.classType).toBe('Calendar B synced'));

    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(cacheMocks.listCachedCalendarEvents.mock.calls).toEqual([
      ['calendar-a'],
      ['calendar-b'],
      ['calendar-b'],
    ]);
  });

  it('reparses loaded events for new studio keys without reloading the cache', async () => {
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-1', 'unknown-1', 'New Studio / Flow'),
    ]);
    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => useCalendarData(value),
      { initialProps: { value: config('calendar-1') } }
    );
    const initialRefresh = result.current.refresh;

    await act(async () => result.current.reloadCache());
    await waitFor(() => expect(result.current.classes[0]?.unconfigured).toBe(true));

    rerender({ value: config('calendar-1', ['Studio', 'New Studio']) });
    await waitFor(() => expect(result.current.classes[0]?.unconfigured).toBeUndefined());

    expect(result.current.classes[0]?.studioName).toBe('New Studio');
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
    expect(result.current.refresh).not.toBe(initialRefresh);
  });

  it('reparses collision-prone studio key changes without cache I/O', async () => {
    cacheMocks.listCachedCalendarEvents.mockResolvedValue([
      cachedEvent('calendar-1', 'studio-a-1', 'A / Flow'),
    ]);
    const { result, rerender } = renderHook(
      ({ value }: { value: AppConfig }) => useCalendarData(value),
      { initialProps: { value: config('calendar-1', ['A,B']) } }
    );

    await act(async () => result.current.reloadCache());
    expect(result.current.classes[0]?.unconfigured).toBe(true);
    const initialRefresh = result.current.refresh;

    rerender({ value: config('calendar-1', ['A', 'B']) });

    expect(result.current.classes[0]?.studioName).toBe('A');
    expect(result.current.classes[0]?.unconfigured).toBeUndefined();
    expect(result.current.refresh).not.toBe(initialRefresh);
    expect(cacheMocks.listCachedCalendarEvents).toHaveBeenCalledTimes(1);
    expect(cacheMocks.syncCalendar).not.toHaveBeenCalled();
  });
});
