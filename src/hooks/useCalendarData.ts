import { useState, useCallback } from 'react';
import { extractClasses } from '../lib/calendar/parser';
import { fetchEvents } from '../lib/calendar/calendar-api';
import { ParsedClass, ParseWarning, AppConfig } from '../lib/types';
import { logInfo, logWarn, logError } from '../lib/logger';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Time range: 6 months back, 3 months forward from today. */
function defaultTimeRange(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const min = new Date(now);
  min.setMonth(min.getMonth() - 6);
  const max = new Date(now);
  max.setMonth(max.getMonth() + 3);
  return {
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
  };
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studioKeys = Object.keys(config.studios).sort().join(',');

  const refresh = useCallback(async () => {
    if (!config.calendarId) {
      setError('No calendar selected. Pick one in the Rates tab.');
      return;
    }
    setIsLoading(true);
    setError(null);
    logInfo('Fetching calendar events…');
    try {
      const { timeMin, timeMax } = defaultTimeRange();
      const events = await fetchEvents(config.calendarId, timeMin, timeMax);
      const knownStudios = new Map(
        Object.keys(config.studios).map((name) => [name.toLowerCase(), name])
      );
      const { classes: parsed, warnings: warns } = extractClasses(events, knownStudios);
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
    } catch (e) {
      const msg = `Failed to fetch calendar: ${e instanceof Error ? e.message : String(e)}`;
      logError(msg);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [config.calendarId, studioKeys]);

  return { classes, warnings, isLoading, error, refresh };
}
