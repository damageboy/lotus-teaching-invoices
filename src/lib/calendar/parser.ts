import { CalendarEvent, ParsedClass, ParseWarning } from '../types.js';
import { parseStudentDescription } from './edit-format.js';

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

export function extractClasses(
  events: CalendarEvent[],
  knownStudios: Map<string, string>
): { classes: ParsedClass[]; warnings: ParseWarning[] } {
  const classes: ParsedClass[] = [];
  const warnings: ParseWarning[] = [];

  for (const event of events) {
    const parts = event.summary.split('/');

    if (parts.length < 2 || parts.length > 3) {
      warnings.push({ code: 'NO_SEPARATOR', event: event.summary });
      continue;
    }

    let rawStudioName: string;
    let classType: string;
    let location: string | undefined;

    if (parts.length === 3) {
      rawStudioName = parts[0].trim();
      location = parts[1].trim();
      classType = parts[2].trim();
    } else {
      rawStudioName = parts[0].trim();
      classType = parts[1].trim();
    }

    if (!rawStudioName || !classType) {
      warnings.push({ code: 'MISSING_CLASS_TYPE', event: event.summary });
      continue;
    }

    const studioName = knownStudios.get(rawStudioName.toLowerCase());
    const studentCountResult = parseStudentDescription(event.description);
    const studentCount = studentCountResult.studentCount;
    const source = {
      eventIdentity: event.identity,
      sourceSummary: event.summary,
      sourceDescription: event.description,
    };

    if (!studioName) {
      // Unknown studio: include on calendar as unconfigured so user can see it
      classes.push({
        ...source,
        studioName: rawStudioName,
        classType,
        ...(location ? { location } : {}),
        date: formatDate(event.start),
        startTime: formatTime(event.start),
        endTime: formatTime(event.end),
        studentCount: studentCount ?? 0,
        ...(studentCountResult.rateOverride !== undefined
          ? { rateOverride: studentCountResult.rateOverride }
          : {}),
        unconfigured: true,
        ambiguousStudentCount: studentCountResult.ambiguous,
      });
      continue;
    }

    if (studentCountResult.ambiguous) {
      warnings.push({
        code: 'AMBIGUOUS_STUDENT_COUNT',
        event: event.summary,
        date: formatDate(event.start),
      });
    } else if (studentCount === null) {
      warnings.push({
        code: 'MISSING_STUDENT_COUNT',
        event: event.summary,
        date: formatDate(event.start),
      });
    }

    classes.push({
      ...source,
      studioName,
      classType,
      ...(location ? { location } : {}),
      date: formatDate(event.start),
      startTime: formatTime(event.start),
      endTime: formatTime(event.end),
      studentCount: studentCount ?? 0,
      ...(studentCountResult.rateOverride !== undefined
        ? { rateOverride: studentCountResult.rateOverride }
        : {}),
      ambiguousStudentCount: studentCountResult.ambiguous,
    });
  }

  return { classes, warnings };
}
