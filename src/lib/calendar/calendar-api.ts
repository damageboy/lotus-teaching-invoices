import { fetch } from '@tauri-apps/plugin-http';
import { CALENDAR_API_BASE } from '../gmail/constants';
import { getAccessToken } from '../gmail/auth';
import { logInfo, logError } from '../logger';
import { CalendarEvent } from '../types';

export interface CalendarListEntry {
  id: string;
  summary: string;
}

/** Pure mapper: extracts id and summary from a calendarList API response. */
export function mapCalendarListResponse(data: any): CalendarListEntry[] {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item: any) => ({
    id: item.id,
    summary: item.summary,
  }));
}

/** Fetches the list of calendars visible to the authenticated user. */
export async function listCalendars(): Promise<CalendarListEntry[]> {
  const token = await getAccessToken();
  const url = `${CALENDAR_API_BASE}/users/me/calendarList`;

  logInfo('Fetching calendar list from Google Calendar API...');
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    const msg = `Failed to fetch calendar list (${resp.status}): ${text}`;
    logError(msg);
    throw new Error(msg);
  }

  const data = await resp.json();
  const calendars = mapCalendarListResponse(data);
  logInfo(`Found ${calendars.length} calendars`);
  return calendars;
}

/** Pure mapper: converts a Calendar Events API response to CalendarEvent[]. */
export function mapEventsResponse(data: any): CalendarEvent[] {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  const result: CalendarEvent[] = [];
  for (const item of items) {
    // Skip cancelled events
    if (item.status === 'cancelled') continue;
    // Skip all-day events (no dateTime on start or end)
    if (!item.start?.dateTime || !item.end?.dateTime) continue;
    result.push({
      uid: item.id,
      summary: item.summary,
      description: item.description ?? '',
      start: new Date(item.start.dateTime),
      end: new Date(item.end.dateTime),
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
    allEvents.push(...mapEventsResponse(data));
    pageToken = data.nextPageToken;
  } while (pageToken);

  logInfo(`Fetched ${allEvents.length} events`);
  return allEvents;
}
