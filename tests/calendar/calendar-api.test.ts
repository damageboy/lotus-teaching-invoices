import { describe, it, expect } from 'vitest';
import { mapCalendarListResponse, mapEventsResponse } from '../../src/lib/calendar/calendar-api';

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

describe('mapEventsResponse', () => {
  it('maps API events to CalendarEvent[] with correct fields', () => {
    const data = {
      items: [
        {
          id: 'evt-1',
          summary: 'Studio A / Vinyasa',
          description: '12',
          start: { dateTime: '2026-03-10T09:00:00+01:00' },
          end: { dateTime: '2026-03-10T10:30:00+01:00' },
          status: 'confirmed',
        },
        {
          id: 'evt-2',
          summary: 'Studio B / Yin',
          description: '8',
          start: { dateTime: '2026-03-11T18:00:00+01:00' },
          end: { dateTime: '2026-03-11T19:00:00+01:00' },
          status: 'confirmed',
        },
      ],
    };
    const result = mapEventsResponse(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      uid: 'evt-1',
      summary: 'Studio A / Vinyasa',
      description: '12',
      start: new Date('2026-03-10T09:00:00+01:00'),
      end: new Date('2026-03-10T10:30:00+01:00'),
    });
    expect(result[1]).toEqual({
      uid: 'evt-2',
      summary: 'Studio B / Yin',
      description: '8',
      start: new Date('2026-03-11T18:00:00+01:00'),
      end: new Date('2026-03-11T19:00:00+01:00'),
    });
  });

  it('skips all-day events (no dateTime, only date)', () => {
    const data = {
      items: [
        {
          id: 'allday-1',
          summary: 'Holiday',
          description: '',
          start: { date: '2026-03-15' },
          end: { date: '2026-03-16' },
          status: 'confirmed',
        },
        {
          id: 'timed-1',
          summary: 'Studio A / Flow',
          description: '5',
          start: { dateTime: '2026-03-15T10:00:00+01:00' },
          end: { dateTime: '2026-03-15T11:00:00+01:00' },
          status: 'confirmed',
        },
      ],
    };
    const result = mapEventsResponse(data);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe('timed-1');
  });

  it('handles missing description (defaults to empty string)', () => {
    const data = {
      items: [
        {
          id: 'evt-nodesc',
          summary: 'Studio A / Basics',
          start: { dateTime: '2026-03-12T14:00:00+01:00' },
          end: { dateTime: '2026-03-12T15:00:00+01:00' },
          status: 'confirmed',
        },
      ],
    };
    const result = mapEventsResponse(data);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('');
  });

  it('returns empty array for empty/missing items', () => {
    expect(mapEventsResponse({ items: [] })).toEqual([]);
    expect(mapEventsResponse({})).toEqual([]);
  });

  it('skips cancelled events', () => {
    const data = {
      items: [
        {
          id: 'cancelled-1',
          summary: 'Studio A / Cancelled Class',
          description: '10',
          start: { dateTime: '2026-03-10T09:00:00+01:00' },
          end: { dateTime: '2026-03-10T10:00:00+01:00' },
          status: 'cancelled',
        },
        {
          id: 'active-1',
          summary: 'Studio A / Vinyasa',
          description: '12',
          start: { dateTime: '2026-03-10T11:00:00+01:00' },
          end: { dateTime: '2026-03-10T12:00:00+01:00' },
          status: 'confirmed',
        },
      ],
    };
    const result = mapEventsResponse(data);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe('active-1');
  });
});
