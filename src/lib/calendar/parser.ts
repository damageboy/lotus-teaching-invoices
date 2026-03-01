import ICAL from 'ical.js';
import { CalendarEvent, ParsedClass, ParseWarning } from '../types.js';

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseStudentCount(description: string | undefined): number | null {
  if (!description) return null;
  const match = description.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function parseCalendarEvents(icsData: string): CalendarEvent[] {
  const jcal = ICAL.parse(icsData);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  const events: CalendarEvent[] = [];

  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    if (!event.summary || !event.startDate || !event.endDate) continue;

    events.push({
      uid: (vevent.getFirstPropertyValue('uid') as string) ?? event.uid,
      summary: event.summary,
      description: (vevent.getFirstPropertyValue('description') as string) ?? '',
      start: event.startDate.toJSDate(),
      end: event.endDate.toJSDate(),
    });
  }

  return events;
}

export function extractClasses(
  events: CalendarEvent[],
  knownStudios: Map<string, string>,
): { classes: ParsedClass[]; warnings: ParseWarning[] } {
  const classes: ParsedClass[] = [];
  const warnings: ParseWarning[] = [];

  for (const event of events) {
    const slashIndex = event.summary.indexOf('/');
    if (slashIndex === -1) {
      warnings.push({ code: 'NO_SEPARATOR', event: event.summary });
      continue;
    }

    const rawStudioName = event.summary.slice(0, slashIndex).trim();
    const classType = event.summary.slice(slashIndex + 1).trim();

    if (!rawStudioName || !classType) {
      warnings.push({ code: 'MISSING_CLASS_TYPE', event: event.summary });
      continue;
    }

    const studioName = knownStudios.get(rawStudioName.toLowerCase());
    if (!studioName) {
      warnings.push({ code: 'UNKNOWN_STUDIO', event: event.summary, studio: rawStudioName });
      continue;
    }

    const studentCount = parseStudentCount(event.description);
    if (studentCount === null) {
      warnings.push({ code: 'MISSING_STUDENT_COUNT', event: event.summary, date: formatDate(event.start) });
    }

    classes.push({
      studioName,
      classType,
      date: formatDate(event.start),
      startTime: formatTime(event.start),
      endTime: formatTime(event.end),
      studentCount: studentCount ?? 0,
    });
  }

  return { classes, warnings };
}
