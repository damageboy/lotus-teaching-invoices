import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { extractClasses } from '../lib/calendar/parser';
import { listCachedCalendarEvents, syncCalendar } from '../lib/calendar/cache';
import { CalendarEvent, ParsedClass, ParseWarning, AppConfig } from '../lib/types';
import { logInfo, logWarn, logError } from '../lib/logger';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  reloadCache: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface CalendarIncarnation {
  readonly calendarId?: string;
}

interface OperationContext {
  calendarId: string;
  incarnation: CalendarIncarnation;
  lifetime: number;
}

interface LoadedCache extends OperationContext {
  cacheReadId: number;
  events: CalendarEvent[];
}

interface CalendarError extends OperationContext {
  kind: 'cache' | 'sync';
  message: string;
}

interface ActiveRefresh extends OperationContext {
  refreshId: number;
}

interface AttachmentWaiter {
  context: OperationContext;
  isFresh: () => boolean;
  resolve: (attached: boolean) => void;
}

type AttachedActionResult<Result> = { ran: true; value: Result } | { ran: false; value?: never };

const NO_CALENDAR_ERROR = 'No calendar selected. Pick one in the Rates tab.';
const EMPTY_CLASSES: ParsedClass[] = [];
const EMPTY_WARNINGS: ParseWarning[] = [];

function failureMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [loadedCache, setLoadedCache] = useState<LoadedCache | null>(null);
  const [calendarError, setCalendarError] = useState<CalendarError | null>(null);
  const [loadingRefresh, setLoadingRefresh] = useState<ActiveRefresh | null>(null);
  const mountedRef = useRef(false);
  const lifetimeRef = useRef(0);
  const committedIncarnationRef = useRef<CalendarIncarnation | null>(null);
  const layoutAttachedRef = useRef<CalendarIncarnation | null>(null);
  const attachmentWaitersRef = useRef<AttachmentWaiter[]>([]);
  const committedCacheRef = useRef<LoadedCache | null>(null);
  const refreshSequenceRef = useRef(0);
  const activeRefreshRef = useRef<ActiveRefresh | null>(null);
  const cacheReadSequenceRef = useRef(0);
  const latestCacheReadRef = useRef(0);

  const calendarIncarnation = useMemo<CalendarIncarnation>(
    () => Object.freeze({ calendarId: config.calendarId }),
    [config.calendarId]
  );
  const studioKeys = JSON.stringify(Object.keys(config.studios).sort());

  const isCurrentContext = useCallback((context: OperationContext) => {
    return (
      mountedRef.current &&
      lifetimeRef.current === context.lifetime &&
      committedIncarnationRef.current === context.incarnation
    );
  }, []);

  const isAttachedContext = useCallback(
    (context: OperationContext) =>
      isCurrentContext(context) && layoutAttachedRef.current === context.incarnation,
    [isCurrentContext]
  );

  const runWhenAttached = useCallback(
    async <Result>(
      context: OperationContext,
      isFresh: () => boolean,
      action: () => Result
    ): Promise<AttachedActionResult<Result>> => {
      while (true) {
        if (!isCurrentContext(context) || !isFresh()) return { ran: false };
        if (layoutAttachedRef.current === context.incarnation) {
          return { ran: true, value: action() };
        }

        const attached = await new Promise<boolean>((resolve) => {
          attachmentWaitersRef.current.push({ context, isFresh, resolve });
        });
        if (!attached) return { ran: false };
      }
    },
    [isCurrentContext]
  );

  const cancelStaleAttachmentWaiters = useCallback(() => {
    const retained: AttachmentWaiter[] = [];
    const cancelled: AttachmentWaiter[] = [];
    for (const waiter of attachmentWaitersRef.current) {
      if (isCurrentContext(waiter.context) && waiter.isFresh()) {
        retained.push(waiter);
      } else {
        cancelled.push(waiter);
      }
    }
    attachmentWaitersRef.current = retained;
    cancelled.forEach((waiter) => waiter.resolve(false));
  }, [isCurrentContext]);

  const settleAttachmentWaiters = useCallback((attachedIncarnation: CalendarIncarnation | null) => {
    const waiters = attachmentWaitersRef.current;
    attachmentWaitersRef.current = [];
    for (const waiter of waiters) {
      waiter.resolve(
        attachedIncarnation !== null &&
          mountedRef.current &&
          lifetimeRef.current === waiter.context.lifetime &&
          waiter.context.incarnation === attachedIncarnation &&
          waiter.isFresh()
      );
    }
  }, []);

  const isCurrentRefresh = useCallback(
    (refresh: ActiveRefresh) => {
      const active = activeRefreshRef.current;
      return (
        isCurrentContext(refresh) &&
        active?.refreshId === refresh.refreshId &&
        active.calendarId === refresh.calendarId &&
        active.incarnation === refresh.incarnation &&
        active.lifetime === refresh.lifetime
      );
    },
    [isCurrentContext]
  );

  const currentContext = useCallback(
    (calendarId: string, incarnation: CalendarIncarnation): OperationContext | null => {
      const context = {
        calendarId,
        incarnation,
        lifetime: lifetimeRef.current,
      };
      return isAttachedContext(context) ? context : null;
    },
    [isAttachedContext]
  );

  const beginCacheRead = useCallback(
    (context: OperationContext): number | null => {
      if (!isAttachedContext(context)) return null;
      const cacheReadId = ++cacheReadSequenceRef.current;
      latestCacheReadRef.current = cacheReadId;
      cancelStaleAttachmentWaiters();
      return cacheReadId;
    },
    [cancelStaleAttachmentWaiters, isAttachedContext]
  );

  const commitCache = useCallback(
    (context: OperationContext, cacheReadId: number, events: CalendarEvent[]): boolean => {
      if (!isAttachedContext(context) || latestCacheReadRef.current !== cacheReadId) return false;
      const cache = { ...context, cacheReadId, events };
      committedCacheRef.current = cache;
      setLoadedCache(cache);
      setCalendarError((current) =>
        current?.calendarId === context.calendarId &&
        current.incarnation === context.incarnation &&
        current.lifetime === context.lifetime &&
        current.kind === 'cache'
          ? null
          : current
      );
      return true;
    },
    [isAttachedContext]
  );

  const reportCacheError = useCallback(
    (context: OperationContext, cacheReadId: number, error: unknown) => {
      if (!isAttachedContext(context) || latestCacheReadRef.current !== cacheReadId) return;
      const message = failureMessage('Failed to load calendar cache', error);
      logError(message);
      setCalendarError({ ...context, kind: 'cache', message });
    },
    [isAttachedContext]
  );

  const reloadCache = useCallback(async () => {
    const calendarId = config.calendarId;
    if (!calendarId) return;
    const context = currentContext(calendarId, calendarIncarnation);
    if (!context) return;
    const cacheReadId = beginCacheRead(context);
    if (cacheReadId === null) return;
    const isFresh = () => latestCacheReadRef.current === cacheReadId;

    try {
      const events = await listCachedCalendarEvents(calendarId);
      await runWhenAttached(context, isFresh, () => commitCache(context, cacheReadId, events));
    } catch (error) {
      await runWhenAttached(context, isFresh, () => reportCacheError(context, cacheReadId, error));
    }
  }, [
    beginCacheRead,
    calendarIncarnation,
    commitCache,
    config.calendarId,
    currentContext,
    reportCacheError,
    runWhenAttached,
  ]);

  const refresh = useCallback(async () => {
    const calendarId = config.calendarId;
    if (!calendarId) return;
    const context = currentContext(calendarId, calendarIncarnation);
    if (!context) return;

    const refreshOperation: ActiveRefresh = {
      ...context,
      refreshId: ++refreshSequenceRef.current,
    };
    activeRefreshRef.current = refreshOperation;
    cancelStaleAttachmentWaiters();
    setLoadingRefresh(refreshOperation);
    setCalendarError(null);
    const isFresh = () => isCurrentRefresh(refreshOperation);

    try {
      const initialCacheReadId = beginCacheRead(context);
      if (initialCacheReadId === null) return;

      try {
        const initialEvents = await listCachedCalendarEvents(calendarId);
        const initialCache = await runWhenAttached(context, isFresh, () =>
          commitCache(context, initialCacheReadId, initialEvents)
        );
        if (!initialCache.ran) return;
      } catch (error) {
        const initialFailure = await runWhenAttached(context, isFresh, () => {
          const usableCache = committedCacheRef.current;
          const initialReadIsUnsatisfied =
            latestCacheReadRef.current === initialCacheReadId ||
            usableCache?.incarnation !== context.incarnation;
          if (initialReadIsUnsatisfied) {
            reportCacheError(context, initialCacheReadId, error);
            return false;
          }
          return true;
        });
        if (!initialFailure.ran || !initialFailure.value) return;
      }

      let result: Awaited<ReturnType<typeof syncCalendar>>;
      try {
        const syncStart = await runWhenAttached(context, isFresh, () => {
          logInfo('Syncing calendar events…');
          return syncCalendar(calendarId);
        });
        if (!syncStart.ran) return;
        result = await syncStart.value;
      } catch (error) {
        await runWhenAttached(context, isFresh, () => {
          const message = failureMessage('Failed to sync calendar', error);
          logError(message);
          setCalendarError({ ...context, kind: 'sync', message });
        });
        return;
      }

      let postSyncCacheReadId: number | null = null;
      try {
        const postSyncStart = await runWhenAttached(context, isFresh, () => {
          logInfo(
            `Calendar sync complete: ${result.fetched} fetched, ${result.upserted} upserted, ${result.deleted} deleted`
          );
          const cacheReadId = beginCacheRead(context);
          if (cacheReadId === null) return null;
          postSyncCacheReadId = cacheReadId;
          return {
            cacheReadId,
            events: listCachedCalendarEvents(calendarId),
          };
        });
        if (!postSyncStart.ran || postSyncStart.value === null) return;
        const postSyncRead = postSyncStart.value;
        const events = await postSyncRead.events;
        await runWhenAttached(context, isFresh, () =>
          commitCache(context, postSyncRead.cacheReadId, events)
        );
      } catch (error) {
        const failedCacheReadId = postSyncCacheReadId;
        if (failedCacheReadId !== null) {
          await runWhenAttached(context, isFresh, () =>
            reportCacheError(context, failedCacheReadId, error)
          );
        }
      }
    } finally {
      await runWhenAttached(context, isFresh, () => {
        activeRefreshRef.current = null;
        cancelStaleAttachmentWaiters();
        setLoadingRefresh((current) =>
          current?.refreshId === refreshOperation.refreshId &&
          current.calendarId === refreshOperation.calendarId &&
          current.incarnation === refreshOperation.incarnation &&
          current.lifetime === refreshOperation.lifetime
            ? null
            : current
        );
      });
    }
  }, [
    beginCacheRead,
    calendarIncarnation,
    cancelStaleAttachmentWaiters,
    commitCache,
    config.calendarId,
    currentContext,
    isCurrentRefresh,
    reportCacheError,
    runWhenAttached,
    studioKeys,
  ]);

  useLayoutEffect(() => {
    committedIncarnationRef.current = calendarIncarnation;
    layoutAttachedRef.current = calendarIncarnation;
    settleAttachmentWaiters(calendarIncarnation);
    return () => {
      if (layoutAttachedRef.current === calendarIncarnation) {
        layoutAttachedRef.current = null;
      }
    };
  }, [calendarIncarnation, settleAttachmentWaiters]);

  useEffect(() => {
    mountedRef.current = true;
    const lifetime = ++lifetimeRef.current;
    return () => {
      if (lifetimeRef.current !== lifetime) return;
      mountedRef.current = false;
      lifetimeRef.current += 1;
      activeRefreshRef.current = null;
      committedIncarnationRef.current = null;
      layoutAttachedRef.current = null;
      committedCacheRef.current = null;
      latestCacheReadRef.current = ++cacheReadSequenceRef.current;
      settleAttachmentWaiters(null);
    };
  }, [settleAttachmentWaiters]);

  const visibleCache =
    loadedCache !== null && loadedCache.incarnation === calendarIncarnation ? loadedCache : null;

  const parsedCache = useMemo(() => {
    if (!visibleCache) return null;
    const knownStudios = new Map(
      Object.keys(config.studios).map((name) => [name.toLowerCase(), name])
    );
    return {
      ...extractClasses(visibleCache.events, knownStudios),
      context: visibleCache,
    };
  }, [studioKeys, visibleCache]);

  useEffect(() => {
    if (!parsedCache || !isAttachedContext(parsedCache.context)) return;
    const unconfiguredCount = parsedCache.classes.filter((lesson) => lesson.unconfigured).length;
    logInfo(
      `Calendar loaded: ${parsedCache.classes.length - unconfiguredCount} classes, ${unconfiguredCount} unconfigured, ${parsedCache.warnings.length} warnings`
    );
    const now = new Date().toISOString().slice(0, 10);
    parsedCache.warnings
      .filter((warning) => !warning.date || warning.date <= now)
      .forEach((warning) =>
        logWarn(`${warning.code}: ${warning.event}${warning.date ? ` (${warning.date})` : ''}`)
      );
  }, [isAttachedContext, parsedCache]);

  const visibleError =
    calendarError !== null && calendarError.incarnation === calendarIncarnation
      ? calendarError.message
      : null;
  const isLoading = loadingRefresh !== null && loadingRefresh.incarnation === calendarIncarnation;

  return {
    classes: parsedCache?.classes ?? EMPTY_CLASSES,
    warnings: parsedCache?.warnings ?? EMPTY_WARNINGS,
    isLoading,
    error: config.calendarId ? visibleError : NO_CALENDAR_ERROR,
    reloadCache,
    refresh,
  };
}
