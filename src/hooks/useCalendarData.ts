import { useState, useCallback } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import { parseCalendarEvents, extractClasses } from '../lib/calendar/parser';
import { ParsedClass, ParseWarning, AppConfig } from '../lib/types';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studioKeys = Object.keys(config.studios).sort().join(',');

  const refresh = useCallback(async () => {
    if (!config.calendarUrl) {
      setError('No calendar URL configured. Set it in the Rates tab.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(config.calendarUrl);
      const icsData = await response.text();
      const events = parseCalendarEvents(icsData);
      const knownStudios = new Map(
        Object.keys(config.studios).map(name => [name.toLowerCase(), name])
      );
      const { classes: parsed, warnings: warns } = extractClasses(events, knownStudios);
      setClasses(parsed);
      setWarnings(warns);
    } catch (e) {
      setError(`Failed to fetch calendar: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsLoading(false);
    }
  }, [config.calendarUrl, studioKeys]);

  return { classes, warnings, isLoading, error, refresh };
}
