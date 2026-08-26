import { describe, it, expect, vi } from 'vitest';
import { AuthorizationRequiredError } from '../../src/lib/google/mobile-authorization.js';
import { mapCachedCalendarEvents, syncCalendar } from '../../src/lib/calendar/cache.js';

describe('syncCalendar', () => {
  it('surfaces authorizationRequired without invoking sync during passive startup', async () => {
    const authorizationRequired = new AuthorizationRequiredError();
    const getAccessToken = vi.fn().mockRejectedValueOnce(authorizationRequired);
    const invoke = vi.fn();

    await expect(syncCalendar('calendar-1', { getAccessToken, invoke })).rejects.toBe(
      authorizationRequired
    );

    expect(getAccessToken).toHaveBeenCalledWith({ interactive: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('mapCachedCalendarEvents', () => {
  it('converts cached Tauri DTO timestamps into CalendarEvent dates', () => {
    const events = mapCachedCalendarEvents([
      {
        identity: {
          calendarId: 'calendar-1',
          eventId: 'evt-1',
          recurringEventId: 'series-1',
          originalStartTime: '2026-01-10T09:00:00+01:00',
          etag: '"etag-1"',
        },
        summary: 'Studio A / Flow',
        description: '8',
        start: '2026-01-10T09:00:00+01:00',
        end: '2026-01-10T10:00:00+01:00',
        status: 'confirmed',
        updated: '2026-01-09T12:00:00.000Z',
      },
    ]);

    expect(events).toEqual([
      {
        identity: {
          calendarId: 'calendar-1',
          eventId: 'evt-1',
          recurringEventId: 'series-1',
          originalStartTime: '2026-01-10T09:00:00+01:00',
          etag: '"etag-1"',
        },
        summary: 'Studio A / Flow',
        description: '8',
        start: new Date('2026-01-10T09:00:00+01:00'),
        end: new Date('2026-01-10T10:00:00+01:00'),
        status: 'confirmed',
        updated: '2026-01-09T12:00:00.000Z',
      },
    ]);
  });

  it('keeps legacy nullable identity fields visible without inventing an ETag', () => {
    const [event] = mapCachedCalendarEvents([
      {
        identity: {
          calendarId: 'legacy-calendar',
          eventId: 'legacy-event',
          recurringEventId: null,
          originalStartTime: null,
          etag: null,
        },
        summary: 'Legacy Studio / Flow',
        description: '6',
        start: '2026-01-12T09:00:00+01:00',
        end: '2026-01-12T10:00:00+01:00',
        status: 'confirmed',
      },
    ]);

    expect(event.identity).toEqual({
      calendarId: 'legacy-calendar',
      eventId: 'legacy-event',
      recurringEventId: null,
      originalStartTime: null,
      etag: null,
    });
    expect(event.summary).toBe('Legacy Studio / Flow');
  });
});
