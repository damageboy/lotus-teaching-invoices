import { ParsedClass } from "../types.js";

export function groupByStudio(classes: ParsedClass[]): Map<string, ParsedClass[]> {
  const groups = new Map<string, ParsedClass[]>();

  for (const cls of classes) {
    const existing = groups.get(cls.studioName);
    if (existing) {
      existing.push(cls);
    } else {
      groups.set(cls.studioName, [cls]);
    }
  }

  // Sort classes within each studio by date, then start time
  for (const [, studioClasses] of groups) {
    studioClasses.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.startTime.localeCompare(b.startTime);
    });
  }

  return groups;
}

export function filterByDateRange(
  classes: ParsedClass[],
  from: string,
  to: string,
): ParsedClass[] {
  return classes.filter((cls) => cls.date >= from && cls.date <= to);
}

export function filterByStudio(
  classes: ParsedClass[],
  studioName: string,
): ParsedClass[] {
  return classes.filter((cls) => cls.studioName === studioName);
}
