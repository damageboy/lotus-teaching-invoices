import { AppError, ParsedClass, StudioConfig } from '../../lib/types.js';
import { findRate } from '../../lib/invoice/calculator.js';

function localDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function selectedDateForMonth(date: string, year: number, month: number): string {
  const day = Number(date.slice(-2));
  const lastDay = new Date(year, month + 1, 0).getDate();
  return localDate(year, month, Math.min(day, lastDay));
}

export function initialMobileDate(
  year: number,
  month: number,
  classes: ParsedClass[],
  now: Date
): string {
  if (now.getFullYear() === year && now.getMonth() === month) {
    return localDate(year, month, now.getDate());
  }

  const firstLesson = classes.map((lesson) => lesson.date).sort()[0];
  return firstLesson ?? localDate(year, month, 1);
}

export function lessonExpectedAmount(lesson: ParsedClass, studio?: StudioConfig): number | null {
  if (
    lesson.studentCount <= 0 ||
    lesson.ambiguousStudentCount ||
    !Number.isSafeInteger(lesson.studentCount)
  ) {
    return null;
  }

  if (lesson.rateOverride !== undefined) return lesson.rateOverride;
  if (!studio) return null;

  try {
    return findRate(studio.rateTiers, lesson.studentCount);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NO_MATCHING_TIER') return null;
    throw error;
  }
}

export function localDateString(year: number, month: number, day: number): string {
  return localDate(year, month, day);
}
