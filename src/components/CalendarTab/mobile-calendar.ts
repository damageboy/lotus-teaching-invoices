import type { ParsedClass } from '../../lib/types.js';
export { lessonExpectedAmount } from './lesson-value.js';

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

export function localDateString(year: number, month: number, day: number): string {
  return localDate(year, month, day);
}
