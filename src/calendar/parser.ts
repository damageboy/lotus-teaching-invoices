import ical from "node-ical";
import { CalendarEvent, ParsedClass } from "../types.js";

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(d: Date): string {
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function parseStudentCount(description: string | undefined): number | null {
  if (!description) return null;
  // Look for a standalone number in the description
  const match = description.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function parseCalendarEvents(icsData: string): CalendarEvent[] {
  const parsed = ical.sync.parseICS(icsData);
  const events: CalendarEvent[] = [];

  for (const [uid, component] of Object.entries(parsed)) {
    if (component.type !== "VEVENT") continue;

    const event = component as ical.VEvent;
    if (!event.summary || !event.start || !event.end) continue;

    events.push({
      uid,
      summary: event.summary,
      description: (event.description as string) ?? "",
      start: new Date(event.start as unknown as string),
      end: new Date(event.end as unknown as string),
    });
  }

  return events;
}

export function extractClasses(
  events: CalendarEvent[],
  knownStudios: Map<string, string>,  // lowercase -> canonical name
): { classes: ParsedClass[]; warnings: string[] } {
  const classes: ParsedClass[] = [];
  const warnings: string[] = [];

  for (const event of events) {
    // Expected format: "Studio Name / Class Type"
    const slashIndex = event.summary.indexOf("/");
    if (slashIndex === -1) {
      warnings.push(`Skipping event "${event.summary}": no "/" separator found`);
      continue;
    }

    const rawStudioName = event.summary.slice(0, slashIndex).trim();
    const classType = event.summary.slice(slashIndex + 1).trim();

    if (!rawStudioName || !classType) {
      warnings.push(`Skipping event "${event.summary}": empty studio or class type`);
      continue;
    }

    const studioName = knownStudios.get(rawStudioName.toLowerCase());
    if (!studioName) {
      warnings.push(`Unknown studio "${rawStudioName}" in event "${event.summary}"`);
      continue;
    }

    const studentCount = parseStudentCount(event.description);
    if (studentCount === null) {
      warnings.push(`Missing student count for "${event.summary}" on ${formatDate(event.start)}, defaulting to 0`);
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
