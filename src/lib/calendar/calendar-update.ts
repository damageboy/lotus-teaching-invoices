import { invoke } from '@tauri-apps/api/core';
import { getAccessToken } from '../gmail/auth.js';
import type { CalendarEventIdentity } from '../types.js';

export interface OccurrenceStudioEditRequest {
  identity: CalendarEventIdentity;
  studioName: string;
}

export interface OccurrenceStudioEditPreflight {
  identity: CalendarEventIdentity;
  currentSummary: string;
  proposedSummary: string;
}

export interface SeriesStudioEditRequest {
  selectedIdentity: CalendarEventIdentity;
  studioName: string;
}

export interface SeriesStudioEditPreflight {
  calendarId: string;
  selectedEventId: string;
  masterEventId: string;
  masterEtag: string;
  currentSummary: string;
  proposedSummary: string;
  instanceCount: number;
  titleExceptionCount: number;
}

export interface SeriesStudioEditResult {
  applied: {
    calendarId: string;
    masterEventId: string;
    proposedSummary: string;
  };
  reconciliationPending: boolean;
}

export interface CalendarEditedEvent {
  identity: CalendarEventIdentity;
  summary: string;
  description: string;
  start: string;
  end: string;
  status: string;
  updated?: string;
}

export type OccurrenceValueEditOperation =
  | { operation: 'setStudents'; studentCount: number }
  | { operation: 'setEuroOverride'; studentCount: number; euroOverride: string }
  | { operation: 'useConfiguredRate'; studentCount: number };

export type OccurrenceValueEditRequest = OccurrenceValueEditOperation & {
  identity: CalendarEventIdentity;
};

export interface OccurrenceValueEditPreflight {
  identity: CalendarEventIdentity;
  currentDescription: string;
  proposedDescription: string;
  requiresConfirmation: boolean;
}

export async function preflightOccurrenceStudioEdit(
  request: OccurrenceStudioEditRequest
): Promise<OccurrenceStudioEditPreflight> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<OccurrenceStudioEditPreflight>('preflight_calendar_occurrence_studio_edit', {
    accessToken,
    request,
  });
}

export async function applyOccurrenceStudioEdit(
  preflight: OccurrenceStudioEditPreflight,
  outputDir?: string
): Promise<CalendarEditedEvent> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<CalendarEditedEvent>('apply_calendar_occurrence_studio_edit', {
    accessToken,
    preflight,
    outputDir,
  });
}

export async function preflightSeriesStudioEdit(
  request: SeriesStudioEditRequest
): Promise<SeriesStudioEditPreflight> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<SeriesStudioEditPreflight>('preflight_calendar_series_studio_edit', {
    accessToken,
    request,
  });
}

export async function applySeriesStudioEdit(
  preflight: SeriesStudioEditPreflight,
  outputDir?: string
): Promise<SeriesStudioEditResult> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<SeriesStudioEditResult>('apply_calendar_series_studio_edit', {
    accessToken,
    preflight,
    outputDir,
  });
}

export async function preflightOccurrenceValueEdit(
  request: OccurrenceValueEditRequest
): Promise<OccurrenceValueEditPreflight> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<OccurrenceValueEditPreflight>('preflight_calendar_occurrence_value_edit', {
    accessToken,
    request,
  });
}

export async function applyOccurrenceValueEdit(
  preflight: OccurrenceValueEditPreflight,
  confirmUnsupportedReplacement: boolean,
  outputDir?: string
): Promise<CalendarEditedEvent> {
  const accessToken = await getAccessToken({ requireCalendarWrite: true });
  return invoke<CalendarEditedEvent>('apply_calendar_occurrence_value_edit', {
    accessToken,
    preflight,
    confirmUnsupportedReplacement,
    outputDir,
  });
}
