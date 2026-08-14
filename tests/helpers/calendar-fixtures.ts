import { CalendarEvent, CalendarEventIdentity, ParsedClass } from '../../src/lib/types.js';

export function calendarIdentity(
  overrides: Partial<CalendarEventIdentity> = {}
): CalendarEventIdentity {
  return {
    calendarId: 'fixture-calendar',
    eventId: 'fixture-event',
    ...overrides,
  };
}

export function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    identity: calendarIdentity(overrides.identity),
    summary: 'Studio / Flow',
    description: '5',
    start: new Date('2026-01-03T09:00:00'),
    end: new Date('2026-01-03T10:00:00'),
    ...overrides,
  };
}

export function parsedClass(overrides: Partial<ParsedClass> = {}): ParsedClass {
  const studioName = overrides.studioName ?? 'Studio';
  const classType = overrides.classType ?? 'Flow';
  const studentCount = overrides.studentCount ?? 5;
  const sourceSummary =
    overrides.sourceSummary ??
    [studioName, overrides.location, classType].filter((part) => part !== undefined).join(' / ');
  return {
    eventIdentity: calendarIdentity(overrides.eventIdentity),
    sourceSummary,
    sourceDescription: overrides.sourceDescription ?? String(studentCount),
    studioName,
    classType,
    date: '2026-01-03',
    startTime: '09:00',
    endTime: '10:00',
    studentCount,
    ...overrides,
  };
}
