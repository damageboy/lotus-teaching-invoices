import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  calendarErrorMessage,
  listCalendars,
  type CalendarListEntry,
} from '../lib/calendar/calendar-api.js';
import type { AppConfig } from '../lib/types.js';

export interface CalendarPickerController {
  calendars: readonly CalendarListEntry[] | null;
  listOpen: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  selectedName: string;
  openList(): Promise<void>;
  select(calendar: CalendarListEntry): Promise<void>;
  closeList(): void;
}

export interface UseCalendarPickerOptions {
  config: AppConfig;
  saveConfig(next: AppConfig): Promise<void>;
}

export interface CalendarPickerDependencies {
  listCalendars: typeof listCalendars;
}

function calendarIdentity(config: AppConfig): string {
  return JSON.stringify([
    config.calendarId ?? null,
    config.calendarName?.trim() ?? null,
    config.calendarAccessRole ?? null,
  ]);
}

export function useCalendarPicker(
  options: UseCalendarPickerOptions,
  dependencies: CalendarPickerDependencies = { listCalendars }
): CalendarPickerController {
  const [calendars, setCalendars] = useState<readonly CalendarListEntry[] | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const semanticIncarnationRef = useRef(0);
  const committedIdentityRef = useRef(calendarIdentity(options.config));
  const committedOptionsRef = useRef(options);

  useLayoutEffect(() => {
    const identity = calendarIdentity(options.config);
    if (identity !== committedIdentityRef.current) {
      committedIdentityRef.current = identity;
      semanticIncarnationRef.current += 1;
      requestRef.current += 1;
      setCalendars(null);
      setListOpen(false);
      setLoading(false);
      setSaving(false);
      setError(null);
    }
    committedOptionsRef.current = options;
  }, [options]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const isCurrent = useCallback((request: number, incarnation: number): boolean => {
    return (
      mountedRef.current &&
      request === requestRef.current &&
      incarnation === semanticIncarnationRef.current
    );
  }, []);

  const loadList = useCallback(
    async (interactive: boolean): Promise<void> => {
      const request = ++requestRef.current;
      const incarnation = semanticIncarnationRef.current;
      setLoading(true);
      setError(null);
      if (interactive) setListOpen(false);
      try {
        const nextCalendars = interactive
          ? await dependencies.listCalendars(undefined, { interactive: true })
          : await dependencies.listCalendars();
        if (!isCurrent(request, incarnation)) return;
        setCalendars(nextCalendars);
        if (interactive) setListOpen(true);
      } catch (cause) {
        if (isCurrent(request, incarnation)) setError(calendarErrorMessage(cause));
      } finally {
        if (isCurrent(request, incarnation)) setLoading(false);
      }
    },
    [dependencies.listCalendars, isCurrent]
  );

  useEffect(() => {
    if (!options.config.calendarId || options.config.calendarName?.trim()) return;
    void loadList(false);
  }, [loadList, options.config.calendarId, options.config.calendarName]);

  const openList = useCallback((): Promise<void> => loadList(true), [loadList]);

  const select = useCallback(
    async (calendar: CalendarListEntry): Promise<void> => {
      const current = committedOptionsRef.current;
      const { calendarAccessRole: _previousAccessRole, ...configWithoutAccessRole } =
        current.config;
      const next: AppConfig = {
        ...configWithoutAccessRole,
        calendarId: calendar.id,
        calendarName: calendar.summary,
        ...(calendar.accessRole ? { calendarAccessRole: calendar.accessRole } : {}),
      };
      const request = ++requestRef.current;
      const incarnation = semanticIncarnationRef.current;
      setLoading(false);
      setSaving(true);
      setError(null);
      try {
        await current.saveConfig(next);
        if (!isCurrent(request, incarnation)) return;
        setListOpen(false);
      } catch (cause) {
        if (isCurrent(request, incarnation)) setError(calendarErrorMessage(cause));
      } finally {
        if (isCurrent(request, incarnation)) setSaving(false);
      }
    },
    [isCurrent]
  );

  const closeList = useCallback((): void => {
    requestRef.current += 1;
    setListOpen(false);
    setLoading(false);
    setSaving(false);
    setError(null);
  }, []);

  const selectedName =
    options.config.calendarName?.trim() ||
    calendars?.find((calendar) => calendar.id === options.config.calendarId)?.summary.trim() ||
    (loading ? 'Loading calendar…' : 'Selected calendar');

  return {
    calendars,
    listOpen,
    loading,
    saving,
    error,
    selectedName,
    openList,
    select,
    closeList,
  };
}
