import type { ParsedClass, StudioConfig } from '../../lib/types.js';
import { lessonNeedsConfiguration } from './lesson-value.js';
export { lessonExpectedAmount } from './lesson-value.js';

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface MonthGridDay {
  day: number;
  date: string;
  lessons: ParsedClass[];
  configuredLessons: ParsedClass[];
  incompleteCount: number;
}

function localDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function buildMonthGrid(
  year: number,
  month: number,
  classes: ParsedClass[],
  studios: Record<string, StudioConfig>
): Array<MonthGridDay | null> {
  const byDate = new Map<string, ParsedClass[]>();
  for (const lesson of classes) {
    const lessons = byDate.get(lesson.date) ?? [];
    lessons.push(lesson);
    byDate.set(lesson.date, lessons);
  }

  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<MonthGridDay | null> = [
    ...Array<null>(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const date = localDate(year, month, day);
      const lessons = byDate.get(date) ?? [];
      return {
        day,
        date,
        lessons,
        configuredLessons: lessons.filter((lesson) => !lesson.unconfigured),
        incompleteCount: lessons.filter((lesson) =>
          lessonNeedsConfiguration(lesson, studios[lesson.studioName])
        ).length,
      };
    }),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
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
