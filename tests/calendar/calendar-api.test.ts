import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = {
  invoke: vi.fn(),
};

const { listCalendars, mapCalendarListResponse, mapEventsResponse } =
  await import('../../src/lib/calendar/calendar-api.js');

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe('mapCalendarListResponse', () => {
  it('extracts id and summary from items array', () => {
    const data = {
      kind: 'calendar#calendarList',
      items: [
        {
          id: 'cal-1@group.calendar.google.com',
          summary: 'Yoga Studio A',
          accessRole: 'owner',
          other: 'ignored',
        },
        {
          id: 'cal-2@group.calendar.google.com',
          summary: 'Yoga Studio B',
          accessRole: 'freeBusyReader',
          extra: 123,
        },
      ],
    };
    expect(mapCalendarListResponse(data)).toEqual([
      {
        id: 'cal-1@group.calendar.google.com',
        summary: 'Yoga Studio A',
        accessRole: 'owner',
      },
      {
        id: 'cal-2@group.calendar.google.com',
        summary: 'Yoga Studio B',
        accessRole: 'freeBusyReader',
      },
    ]);
  });

  it.each(['owner', 'writer', 'reader', 'freeBusyReader'] as const)(
    'retains the exact %s access role',
    (accessRole) => {
      expect(
        mapCalendarListResponse({ items: [{ id: 'calendar-1', summary: 'Calendar', accessRole }] })
      ).toEqual([{ id: 'calendar-1', summary: 'Calendar', accessRole }]);
    }
  );

  it.each([['futureRole'], [undefined]])(
    'drops an unsupported or missing access role: %s',
    (accessRole) => {
      expect(
        mapCalendarListResponse({ items: [{ id: 'calendar-1', summary: 'Calendar', accessRole }] })
      ).toStrictEqual([{ id: 'calendar-1', summary: 'Calendar' }]);
    }
  );

  it('returns empty array for empty items', () => {
    expect(mapCalendarListResponse({ items: [] })).toEqual([]);
  });

  it('returns empty array for missing items', () => {
    expect(mapCalendarListResponse({})).toEqual([]);
  });
});

describe('listCalendars', () => {
  it('routes CalendarList reads through the registered Rust command', async () => {
    const calendars = [{ id: 'calendar-1', summary: 'Teaching Calendar', accessRole: 'writer' }];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_calendars') return calendars;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      listCalendars({
        getAccessToken: async () => 'access-token',
        invoke: mocks.invoke,
      })
    ).resolves.toEqual(calendars);
    expect(mocks.invoke).toHaveBeenCalledWith('list_calendars', {
      accessToken: 'access-token',
    });
  });

  it('runtime-validates roles returned by the Rust command', async () => {
    mocks.invoke.mockResolvedValue([
      { id: 'calendar-1', summary: 'Future Calendar', accessRole: 'futureRole' },
    ]);

    await expect(
      listCalendars({
        getAccessToken: async () => 'access-token',
        invoke: mocks.invoke,
      })
    ).resolves.toStrictEqual([{ id: 'calendar-1', summary: 'Future Calendar' }]);
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
    const result = mapEventsResponse(data, 'calendar-1');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      identity: { calendarId: 'calendar-1', eventId: 'evt-1' },
      summary: 'Studio A / Vinyasa',
      description: '12',
      start: new Date('2026-03-10T09:00:00+01:00'),
      end: new Date('2026-03-10T10:30:00+01:00'),
      status: 'confirmed',
    });
    expect(result[1]).toEqual({
      identity: { calendarId: 'calendar-1', eventId: 'evt-2' },
      summary: 'Studio B / Yin',
      description: '8',
      start: new Date('2026-03-11T18:00:00+01:00'),
      end: new Date('2026-03-11T19:00:00+01:00'),
      status: 'confirmed',
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
    const result = mapEventsResponse(data, 'calendar-1');
    expect(result).toHaveLength(1);
    expect(result[0].identity.eventId).toBe('timed-1');
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
    const result = mapEventsResponse(data, 'calendar-1');
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('');
  });

  it('returns empty array for empty/missing items', () => {
    expect(mapEventsResponse({ items: [] }, 'calendar-1')).toEqual([]);
    expect(mapEventsResponse({}, 'calendar-1')).toEqual([]);
  });

  it('keeps cancelled timed events for sync deletion handling', () => {
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
    const result = mapEventsResponse(data, 'calendar-1');
    expect(result.map((event) => event.identity.eventId)).toEqual(['cancelled-1', 'active-1']);
    expect(result[0].status).toBe('cancelled');
  });

  it('preserves status and updated timestamp for sync handling', () => {
    const data = {
      items: [
        {
          id: 'cancelled-with-time',
          summary: 'Studio A / Cancelled Class',
          description: '10',
          start: { dateTime: '2026-03-10T09:00:00+01:00' },
          end: { dateTime: '2026-03-10T10:00:00+01:00' },
          status: 'cancelled',
          updated: '2026-03-09T20:00:00.000Z',
        },
      ],
    };

    expect(mapEventsResponse(data, 'calendar-1')).toEqual([
      {
        identity: { calendarId: 'calendar-1', eventId: 'cancelled-with-time' },
        summary: 'Studio A / Cancelled Class',
        description: '10',
        start: new Date('2026-03-10T09:00:00+01:00'),
        end: new Date('2026-03-10T10:00:00+01:00'),
        status: 'cancelled',
        updated: '2026-03-09T20:00:00.000Z',
      },
    ]);
  });

  it('preserves recurring identity with dateTime or date original starts', () => {
    const result = mapEventsResponse(
      {
        items: [
          {
            id: 'instance-1',
            recurringEventId: 'series-1',
            originalStartTime: { dateTime: '2026-03-10T09:00:00+01:00' },
            etag: '"etag-1"',
            summary: 'Studio A / Flow',
            description: '8',
            start: { dateTime: '2026-03-10T09:00:00+01:00' },
            end: { dateTime: '2026-03-10T10:00:00+01:00' },
          },
          {
            id: 'instance-2',
            recurringEventId: 'series-2',
            originalStartTime: { date: '2026-03-11' },
            etag: '"etag-2"',
            summary: 'Studio A / Yin',
            description: '7',
            start: { dateTime: '2026-03-11T09:00:00+01:00' },
            end: { dateTime: '2026-03-11T10:00:00+01:00' },
          },
        ],
      },
      'calendar-1'
    );

    expect(result.map((event) => event.identity)).toEqual([
      {
        calendarId: 'calendar-1',
        eventId: 'instance-1',
        recurringEventId: 'series-1',
        originalStartTime: '2026-03-10T09:00:00+01:00',
        etag: '"etag-1"',
      },
      {
        calendarId: 'calendar-1',
        eventId: 'instance-2',
        recurringEventId: 'series-2',
        originalStartTime: '2026-03-11',
        etag: '"etag-2"',
      },
    ]);
  });
});
