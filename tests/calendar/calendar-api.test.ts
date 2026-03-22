import { describe, it, expect } from 'vitest';
import { mapCalendarListResponse } from '../../src/lib/calendar/calendar-api';

describe('mapCalendarListResponse', () => {
  it('extracts id and summary from items array', () => {
    const data = {
      kind: 'calendar#calendarList',
      items: [
        { id: 'cal-1@group.calendar.google.com', summary: 'Yoga Studio A', other: 'ignored' },
        { id: 'cal-2@group.calendar.google.com', summary: 'Yoga Studio B', extra: 123 },
      ],
    };
    expect(mapCalendarListResponse(data)).toEqual([
      { id: 'cal-1@group.calendar.google.com', summary: 'Yoga Studio A' },
      { id: 'cal-2@group.calendar.google.com', summary: 'Yoga Studio B' },
    ]);
  });

  it('returns empty array for empty items', () => {
    expect(mapCalendarListResponse({ items: [] })).toEqual([]);
  });

  it('returns empty array for missing items', () => {
    expect(mapCalendarListResponse({})).toEqual([]);
  });
});
