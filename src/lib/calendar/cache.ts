import { invoke } from '@tauri-apps/api/core';
import { getAccessToken } from '../gmail/auth.js';
import { CalendarEvent, CalendarEventIdentity } from '../types.js';

export interface CachedCalendarEventDto {
  identity: CalendarEventIdentity;
  summary: string;
  description: string;
  start: string;
  end: string;
  status?: string;
  updated?: string;
}

export interface SyncResult {
  fullSync: boolean;
  fetched: number;
  upserted: number;
  deleted: number;
  syncToken?: string;
}

export function mapCachedCalendarEvents(events: CachedCalendarEventDto[]): CalendarEvent[] {
  return events.map((event) => ({
    identity: event.identity,
    summary: event.summary,
    description: event.description,
    start: new Date(event.start),
    end: new Date(event.end),
    ...(event.status ? { status: event.status } : {}),
    ...(event.updated ? { updated: event.updated } : {}),
  }));
}

export async function syncCalendar(calendarId: string): Promise<SyncResult> {
  const accessToken = await getAccessToken();
  return invoke<SyncResult>('sync_calendar', { calendarId, accessToken });
}

export async function listCachedCalendarEvents(calendarId: string): Promise<CalendarEvent[]> {
  const events = await invoke<CachedCalendarEventDto[]>('list_calendar_events', { calendarId });
  return mapCachedCalendarEvents(events);
}
