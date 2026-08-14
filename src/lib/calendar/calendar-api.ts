import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { CALENDAR_API_BASE } from '../gmail/constants';
import { getAccessToken } from '../gmail/auth';
import { logInfo, logError } from '../logger';
import { CalendarAccessRole, CalendarEvent } from '../types';

export interface CalendarListEntry {
  id: string;
  summary: string;
  accessRole?: CalendarAccessRole;
}

interface CalendarListDependencies {
  getAccessToken: typeof getAccessToken;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

const calendarListDependencies: CalendarListDependencies = {
  getAccessToken,
  invoke,
};

function calendarAccessRole(value: unknown): CalendarAccessRole | undefined {
  return value === 'owner' || value === 'writer' || value === 'reader' || value === 'freeBusyReader'
    ? value
    : undefined;
}

function mapCalendarListEntries(items: unknown): CalendarListEntry[] {
  if (!Array.isArray(items)) return [];
  return items.map((item: any) => {
    const accessRole = calendarAccessRole(item.accessRole);
    return {
      id: item.id,
      summary: item.summary,
      ...(accessRole ? { accessRole } : {}),
    };
  });
}

/** Pure mapper: extracts id, summary, and a validated role from a calendarList API response. */
export function mapCalendarListResponse(data: any): CalendarListEntry[] {
  return mapCalendarListEntries(data?.items);
}

/** Fetches the list of calendars visible to the authenticated user. */
export async function listCalendars(
  dependencies: CalendarListDependencies = calendarListDependencies
): Promise<CalendarListEntry[]> {
  const token = await dependencies.getAccessToken();
  logInfo('Fetching calendar list from Google Calendar API...');
  try {
    const response = await dependencies.invoke<unknown>('list_calendars', {
      accessToken: token,
    });
    const calendars = mapCalendarListEntries(response);
    logInfo(`Found ${calendars.length} calendars`);
    return calendars;
  } catch (error) {
    logError(`Failed to fetch calendar list: ${calendarErrorMessage(error)}`);
    throw error;
  }
}

export function calendarErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message =
      'message' in error && typeof error.message === 'string' ? error.message : undefined;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return `Google Calendar request failed (${code})`;
  }
  return String(error);
}

/** Pure mapper: converts a Calendar Events API response to CalendarEvent[]. */
export function mapEventsResponse(data: any, calendarId: string): CalendarEvent[] {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  const result: CalendarEvent[] = [];
  for (const item of items) {
    // Skip all-day events (no dateTime on start or end)
    if (!item.start?.dateTime || !item.end?.dateTime) continue;
    const originalStartTime = item.originalStartTime?.dateTime ?? item.originalStartTime?.date;
    result.push({
      identity: {
        calendarId,
        eventId: item.id,
        ...(item.recurringEventId ? { recurringEventId: item.recurringEventId } : {}),
        ...(originalStartTime ? { originalStartTime } : {}),
        ...(item.etag ? { etag: item.etag } : {}),
      },
      summary: item.summary,
      description: item.description ?? '',
      start: new Date(item.start.dateTime),
      end: new Date(item.end.dateTime),
      ...(item.status ? { status: item.status } : {}),
      ...(item.updated ? { updated: item.updated } : {}),
    });
  }
  return result;
}

/**
 * Fetches events from a specific calendar within a time range.
 * Handles pagination automatically via nextPageToken.
 * Recurring events are expanded into individual instances (singleEvents=true).
 */
export async function fetchEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  const allEvents: CalendarEvent[] = [];
  let pageToken: string | undefined;

  logInfo(`Fetching events from calendar ${calendarId} (${timeMin} to ${timeMax})...`);

  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      const msg = `Failed to fetch events (${resp.status}): ${text}`;
      logError(msg);
      throw new Error(msg);
    }

    const data = await resp.json();
    allEvents.push(...mapEventsResponse(data, calendarId));
    pageToken = data.nextPageToken;
  } while (pageToken);

  logInfo(`Fetched ${allEvents.length} events`);
  return allEvents;
}
