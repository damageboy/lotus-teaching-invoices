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

interface SyncCalendarDependencies {
  getAccessToken(options: { interactive: boolean }): Promise<string>;
  invoke(
    command: 'sync_calendar',
    args: { calendarId: string; accessToken: string }
  ): Promise<SyncResult>;
}

const syncCalendarDependencies: SyncCalendarDependencies = {
  getAccessToken,
  invoke: (command, args) => invoke<SyncResult>(command, args),
};

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

export async function syncCalendar(
  calendarId: string,
  dependencies: SyncCalendarDependencies = syncCalendarDependencies
): Promise<SyncResult> {
  const accessToken = await dependencies.getAccessToken({ interactive: false });
  return dependencies.invoke('sync_calendar', { calendarId, accessToken });
}

export async function listCachedCalendarEvents(calendarId: string): Promise<CalendarEvent[]> {
  const events = await invoke<CachedCalendarEventDto[]>('list_calendar_events', { calendarId });
  return mapCachedCalendarEvents(events);
}
