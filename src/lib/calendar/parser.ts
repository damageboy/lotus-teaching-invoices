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

function parseStudentCount(description: string | undefined): {
  count: number | null;
  rateOverride: number | undefined;
  ambiguous: boolean;
} {
  if (!description) return { count: null, rateOverride: undefined, ambiguous: false };

  // Check for rate override pattern: "N/PEUR" (e.g. "9/30EUR")
  const overrideMatch = description.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*EUR$/i);
  if (overrideMatch) {
    return {
      count: parseInt(overrideMatch[1], 10),
      rateOverride: parseFloat(overrideMatch[2]),
      ambiguous: false,
    };
  }

  const matches = [...description.matchAll(/(\d+)/g)];
  if (matches.length === 0) return { count: null, rateOverride: undefined, ambiguous: false };
  if (matches.length === 1)
    return { count: parseInt(matches[0][1], 10), rateOverride: undefined, ambiguous: false };
  return { count: null, rateOverride: undefined, ambiguous: true };
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
    const studentCountResult = parseStudentCount(event.description);
    const studentCount = studentCountResult.count;

    if (!studioName) {
      // Unknown studio: include on calendar as unconfigured so user can see it
      classes.push({
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
