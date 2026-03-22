import { fetch } from '@tauri-apps/plugin-http';
import { CALENDAR_API_BASE } from '../gmail/constants';
import { getAccessToken } from '../gmail/auth';
import { logInfo, logError } from '../logger';

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
