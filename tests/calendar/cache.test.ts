import { describe, it, expect } from 'vitest';
import { mapCachedCalendarEvents } from '../../src/lib/calendar/cache.js';

describe('mapCachedCalendarEvents', () => {
  it('converts cached Tauri DTO timestamps into CalendarEvent dates', () => {
    const events = mapCachedCalendarEvents([
      {
        uid: 'evt-1',
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
        uid: 'evt-1',
        summary: 'Studio A / Flow',
        description: '8',
        start: new Date('2026-01-10T09:00:00+01:00'),
        end: new Date('2026-01-10T10:00:00+01:00'),
        status: 'confirmed',
        updated: '2026-01-09T12:00:00.000Z',
      },
    ]);
  });
});
