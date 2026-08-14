import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listCalendars } from '../lib/calendar/calendar-api.js';
import {
  applySeriesStudioEdit as applySeriesStudioEditCommand,
  applyOccurrenceValueEdit as applyOccurrenceValueEditCommand,
  applyOccurrenceStudioEdit as applyOccurrenceStudioEditCommand,
  preflightOccurrenceValueEdit as preflightOccurrenceValueEditCommand,
  preflightOccurrenceStudioEdit as preflightOccurrenceStudioEditCommand,
  preflightSeriesStudioEdit as preflightSeriesStudioEditCommand,
  type OccurrenceValueEditOperation,
  type OccurrenceValueEditPreflight,
  type SeriesStudioEditPreflight,
} from '../lib/calendar/calendar-update.js';
import type { CalendarAccessRole, ParsedClass } from '../lib/types.js';

export type CalendarEditingStatus =
  | 'checking'
  | 'scopeMissing'
  | 'roleStale'
  | 'calendarReadOnly'
  | 'enabled'
  | 'retryable';

export interface CalendarEditingOptions {
  calendarId?: string;
  outputDir?: string;
  persistedAccessRole?: CalendarAccessRole;
  hasCalendarWrite: boolean;
  authorizationLoading: boolean;
  loadCalendars?: typeof listCalendars;
  preflightOccurrenceStudioEdit?: typeof preflightOccurrenceStudioEditCommand;
  applyOccurrenceStudioEdit?: typeof applyOccurrenceStudioEditCommand;
  preflightOccurrenceValueEdit?: typeof preflightOccurrenceValueEditCommand;
  applyOccurrenceValueEdit?: typeof applyOccurrenceValueEditCommand;
  preflightSeriesStudioEdit?: typeof preflightSeriesStudioEditCommand;
  applySeriesStudioEdit?: typeof applySeriesStudioEditCommand;
  reloadCache?: () => Promise<void>;
  reloadInvoiceFreshness?: () => Promise<void>;
}

interface RoleSnapshot {
  calendarId?: string;
  accessRole?: string;
  roleFresh: boolean;
  capabilityLost: boolean;
  error: string | null;
  refreshing: boolean;
}

export interface CalendarEditingState {
  status: CalendarEditingStatus;
  canEdit: boolean;
  accessRole?: string;
  roleFresh: boolean;
  refreshing: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  refresh: () => Promise<void>;
  reassignOccurrenceStudio: (lesson: ParsedClass, studioName: string) => Promise<void>;
  prepareOccurrenceValueEdit: (
    lesson: ParsedClass,
    operation: OccurrenceValueEditOperation
  ) => Promise<OccurrenceValueEditPreflight>;
  saveOccurrenceValueEdit: (
    preflight: OccurrenceValueEditPreflight,
    confirmUnsupportedReplacement: boolean
  ) => Promise<void>;
  prepareSeriesStudioEdit: (
    lesson: ParsedClass,
    studioName: string
  ) => Promise<SeriesStudioEditPreflight>;
  saveSeriesStudioEdit: (preflight: SeriesStudioEditPreflight) => Promise<boolean>;
}

function isWritableRole(role: string | undefined): boolean {
  return role === 'owner' || role === 'writer';
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isTransientCalendarError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'rateLimited' || error.code === 'network' || error.code === 'server';
}

export function useCalendarEditing({
  calendarId,
  outputDir,
  persistedAccessRole,
  hasCalendarWrite,
  authorizationLoading,
  loadCalendars = listCalendars,
  preflightOccurrenceStudioEdit = preflightOccurrenceStudioEditCommand,
  applyOccurrenceStudioEdit = applyOccurrenceStudioEditCommand,
  preflightOccurrenceValueEdit = preflightOccurrenceValueEditCommand,
  applyOccurrenceValueEdit = applyOccurrenceValueEditCommand,
  preflightSeriesStudioEdit = preflightSeriesStudioEditCommand,
  applySeriesStudioEdit = applySeriesStudioEditCommand,
  reloadCache = async () => {},
  reloadInvoiceFreshness = async () => {},
}: CalendarEditingOptions): CalendarEditingState {
  const requestSequenceRef = useRef(0);
  const currentCalendarIdRef = useRef(calendarId);
  const mountedRef = useRef(true);
  const [snapshot, setSnapshot] = useState<RoleSnapshot>({
    calendarId,
    accessRole: persistedAccessRole,
    roleFresh: false,
    capabilityLost: false,
    error: null,
    refreshing: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  currentCalendarIdRef.current = calendarId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  const current =
    snapshot.calendarId === calendarId
      ? snapshot
      : {
          calendarId,
          accessRole: persistedAccessRole,
          roleFresh: false,
          capabilityLost: false,
          error: null,
          refreshing: false,
        };

  const refresh = useCallback(async () => {
    if (currentCalendarIdRef.current !== calendarId) return;
    const requestSequence = ++requestSequenceRef.current;
    if (!calendarId || authorizationLoading || !hasCalendarWrite) {
      setSnapshot((previous) => {
        if (previous.calendarId !== calendarId) return previous;
        if (!hasCalendarWrite) {
          return {
            ...previous,
            roleFresh: false,
            capabilityLost: false,
            error: null,
            refreshing: false,
          };
        }
        return previous.refreshing ? { ...previous, refreshing: false } : previous;
      });
      return;
    }
    const isCurrentRequest = () =>
      mountedRef.current &&
      requestSequenceRef.current === requestSequence &&
      currentCalendarIdRef.current === calendarId;
    setSnapshot((previous) => ({
      ...(previous.calendarId === calendarId
        ? previous
        : {
            calendarId,
            accessRole: persistedAccessRole,
            roleFresh: false,
            capabilityLost: false,
            error: null,
          }),
      refreshing: true,
      error: null,
    }));
    try {
      const calendars = await loadCalendars();
      if (!isCurrentRequest()) return;
      const selected = calendars.find((calendar) => calendar.id === calendarId);
      setSnapshot({
        calendarId,
        accessRole: selected?.accessRole,
        roleFresh: true,
        capabilityLost: false,
        error: null,
        refreshing: false,
      });
    } catch (refreshError) {
      if (!isCurrentRequest()) return;
      if (!isTransientCalendarError(refreshError)) {
        setSnapshot({
          calendarId,
          accessRole: undefined,
          roleFresh: false,
          capabilityLost: true,
          refreshing: false,
          error: errorMessage(refreshError),
        });
        return;
      }
      setSnapshot((previous) => ({
        ...(previous.calendarId === calendarId
          ? previous
          : {
              calendarId,
              accessRole: persistedAccessRole,
              roleFresh: false,
              capabilityLost: false,
              error: null,
            }),
        refreshing: false,
        error: errorMessage(refreshError),
      }));
    }
  }, [authorizationLoading, calendarId, hasCalendarWrite, loadCalendars, persistedAccessRole]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentCanEdit =
    !authorizationLoading &&
    hasCalendarWrite &&
    current.roleFresh &&
    isWritableRole(current.accessRole);

  const reassignOccurrenceStudio = useCallback(
    async (lesson: ParsedClass, studioName: string) => {
      if (!currentCanEdit) throw new Error('Calendar editing is not available');
      setSaving(true);
      setSaveError(null);
      try {
        const preflight = await preflightOccurrenceStudioEdit({
          identity: lesson.eventIdentity,
          studioName,
        });
        await applyOccurrenceStudioEdit(preflight, outputDir);
        await Promise.all([reloadCache(), reloadInvoiceFreshness()]);
      } catch (error) {
        await Promise.allSettled([reloadCache(), reloadInvoiceFreshness()]);
        const message = errorMessage(error);
        if (mountedRef.current) setSaveError(message);
        throw error;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [
      applyOccurrenceStudioEdit,
      currentCanEdit,
      outputDir,
      preflightOccurrenceStudioEdit,
      reloadCache,
      reloadInvoiceFreshness,
    ]
  );

  const prepareOccurrenceValueEdit = useCallback(
    async (lesson: ParsedClass, operation: OccurrenceValueEditOperation) => {
      if (!currentCanEdit) throw new Error('Calendar editing is not available');
      setSaveError(null);
      try {
        return await preflightOccurrenceValueEdit({ identity: lesson.eventIdentity, ...operation });
      } catch (error) {
        const message = errorMessage(error);
        if (mountedRef.current) setSaveError(message);
        throw error;
      }
    },
    [currentCanEdit, preflightOccurrenceValueEdit]
  );

  const saveOccurrenceValueEdit = useCallback(
    async (preflight: OccurrenceValueEditPreflight, confirmUnsupportedReplacement: boolean) => {
      if (!currentCanEdit) throw new Error('Calendar editing is not available');
      setSaving(true);
      setSaveError(null);
      try {
        await applyOccurrenceValueEdit(preflight, confirmUnsupportedReplacement, outputDir);
        await Promise.all([reloadCache(), reloadInvoiceFreshness()]);
      } catch (error) {
        await Promise.allSettled([reloadCache(), reloadInvoiceFreshness()]);
        const message = errorMessage(error);
        if (mountedRef.current) setSaveError(message);
        throw error;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [applyOccurrenceValueEdit, currentCanEdit, outputDir, reloadCache, reloadInvoiceFreshness]
  );

  const prepareSeriesStudioEdit = useCallback(
    async (lesson: ParsedClass, studioName: string) => {
      if (!currentCanEdit) throw new Error('Calendar editing is not available');
      setSaveError(null);
      try {
        return await preflightSeriesStudioEdit({
          selectedIdentity: lesson.eventIdentity,
          studioName,
        });
      } catch (error) {
        const message = errorMessage(error);
        if (mountedRef.current) setSaveError(message);
        throw error;
      }
    },
    [currentCanEdit, preflightSeriesStudioEdit]
  );

  const saveSeriesStudioEdit = useCallback(
    async (preflight: SeriesStudioEditPreflight) => {
      if (!currentCanEdit) throw new Error('Calendar editing is not available');
      setSaving(true);
      setSaveError(null);
      try {
        const result = await applySeriesStudioEdit(preflight, outputDir);
        await Promise.all([reloadCache(), reloadInvoiceFreshness()]);
        return result.reconciliationPending;
      } catch (error) {
        await Promise.allSettled([reloadCache(), reloadInvoiceFreshness()]);
        const message = errorMessage(error);
        if (mountedRef.current) setSaveError(message);
        throw error;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [applySeriesStudioEdit, currentCanEdit, outputDir, reloadCache, reloadInvoiceFreshness]
  );

  return useMemo(() => {
    const canEdit = currentCanEdit;
    let status: CalendarEditingStatus;
    if (authorizationLoading) status = 'checking';
    else if (!hasCalendarWrite) status = 'scopeMissing';
    else if (current.capabilityLost) status = 'scopeMissing';
    else if (current.error) status = 'retryable';
    else if (!current.roleFresh) status = 'roleStale';
    else if (!isWritableRole(current.accessRole)) status = 'calendarReadOnly';
    else status = 'enabled';

    return {
      status,
      canEdit,
      accessRole: current.accessRole,
      roleFresh: current.roleFresh,
      refreshing: current.refreshing,
      error: current.error,
      saving,
      saveError,
      refresh,
      reassignOccurrenceStudio,
      prepareOccurrenceValueEdit,
      saveOccurrenceValueEdit,
      prepareSeriesStudioEdit,
      saveSeriesStudioEdit,
    };
  }, [
    authorizationLoading,
    current,
    currentCanEdit,
    hasCalendarWrite,
    refresh,
    reassignOccurrenceStudio,
    prepareOccurrenceValueEdit,
    saveOccurrenceValueEdit,
    prepareSeriesStudioEdit,
    saveSeriesStudioEdit,
    saveError,
    saving,
  ]);
}
