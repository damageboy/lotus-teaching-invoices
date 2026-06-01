import { useState, useCallback, useEffect } from 'react';
import { extractClasses } from '../lib/calendar/parser';
import { listCachedCalendarEvents, syncCalendar } from '../lib/calendar/cache';
import { CalendarEvent, ParsedClass, ParseWarning, AppConfig } from '../lib/types';
import { logInfo, logWarn, logError } from '../lib/logger';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studioKeys = Object.keys(config.studios).sort().join(',');

  const parseEvents = useCallback(
    (nextEvents: CalendarEvent[]) => {
      const knownStudios = new Map(
        Object.keys(config.studios).map((name) => [name.toLowerCase(), name])
      );
      const { classes: parsed, warnings: warns } = extractClasses(nextEvents, knownStudios);
      setClasses(parsed);
      setWarnings(warns);
      const unconfiguredCount = parsed.filter((c) => c.unconfigured).length;
      logInfo(
        `Calendar loaded: ${parsed.length - unconfiguredCount} classes, ${unconfiguredCount} unconfigured, ${warns.length} warnings`
      );
      const now = new Date().toISOString().slice(0, 10);
      warns
        .filter((w) => !w.date || w.date <= now)
        .forEach((w) => logWarn(`${w.code}: ${w.event}${w.date ? ` (${w.date})` : ''}`));
    },
    [studioKeys]
  );

  const refresh = useCallback(async () => {
    if (!config.calendarId) {
      setError('No calendar selected. Pick one in the Rates tab.');
      return;
    }
    setIsLoading(true);
    setError(null);
    logInfo('Syncing calendar events…');
    try {
      const result = await syncCalendar(config.calendarId);
      logInfo(
        `Calendar sync complete: ${result.fetched} fetched, ${result.upserted} upserted, ${result.deleted} deleted`
      );
      const cachedEvents = await listCachedCalendarEvents(config.calendarId);
      setEvents(cachedEvents);
      parseEvents(cachedEvents);
    } catch (e) {
      const msg = `Failed to sync calendar: ${e instanceof Error ? e.message : String(e)}`;
      logError(msg);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [config.calendarId, parseEvents]);

  useEffect(() => {
    parseEvents(events);
  }, [events, parseEvents]);

  return { classes, warnings, isLoading, error, refresh };
}
