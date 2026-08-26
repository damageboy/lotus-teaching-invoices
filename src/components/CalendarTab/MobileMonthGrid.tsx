import { useEffect, useRef } from 'react';
import type { ParsedClass } from '../../lib/types.js';
import { studioColor } from '../../lib/studioColors.js';
import { localDateString } from './mobile-calendar.js';
import { UnconfiguredMarker } from './UnconfiguredMarker.js';

interface Props {
  year: number;
  month: number;
  classes: ParsedClass[];
  colorMap: Record<string, string | undefined>;
  selectedDate: string;
  onSelectDate: (date: string, anchor: HTMLButtonElement) => void;
  focusRequest: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dateLabel(year: number, month: number, day: number): string {
  return new Date(year, month, day).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function MobileMonthGrid({
  year,
  month,
  classes,
  colorMap,
  selectedDate,
  onSelectDate,
  focusRequest,
}: Props) {
  const selectedDayRef = useRef<HTMLButtonElement>(null);
  const previousFocusRequest = useRef(0);
  const byDate = new Map<string, ParsedClass[]>();
  for (const lesson of classes) {
    const lessons = byDate.get(lesson.date) ?? [];
    lessons.push(lesson);
    byDate.set(lesson.date, lessons);
  }

  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [
    ...Array<number | null>(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const today = new Date();
  const todayDate = localDateString(today.getFullYear(), today.getMonth(), today.getDate());

  useEffect(() => {
    if (focusRequest === previousFocusRequest.current) return;
    previousFocusRequest.current = focusRequest;
    selectedDayRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  return (
    <section aria-label="Month calendar" className="mt-4">
      <div className="grid grid-cols-7 border-l border-t border-slate-200">
        {WEEKDAYS.map((weekday) => (
          <span
            key={weekday}
            className="py-2 text-center text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            {weekday}
          </span>
        ))}
        {cells.map((day, index) => {
          if (day === null) {
            return (
              <span
                key={`empty-${index}`}
                className="min-h-12 border-b border-r border-slate-200"
              />
            );
          }
          const date = localDateString(year, month, day);
          const lessons = byDate.get(date) ?? [];
          const configuredLessons = lessons.filter((lesson) => !lesson.unconfigured);
          const unconfiguredCount = lessons.length - configuredLessons.length;
          const accessibleLabel =
            unconfiguredCount === 0
              ? dateLabel(year, month, day)
              : `${dateLabel(year, month, day)}, ${unconfiguredCount} unconfigured ${
                  unconfiguredCount === 1 ? 'class' : 'classes'
                }`;
          const isToday =
            today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
          const isSelected = selectedDate === date;
          return (
            <button
              key={date}
              ref={isSelected ? selectedDayRef : undefined}
              type="button"
              aria-label={accessibleLabel}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
              onClick={(event) => onSelectDate(date, event.currentTarget)}
              className={`relative min-h-12 min-w-12 border-b border-r border-slate-200 p-1 text-center text-sm font-medium focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-600 ${
                isSelected
                  ? 'bg-indigo-600 text-white ring-2 ring-inset ring-slate-900'
                  : isToday
                    ? 'bg-indigo-50 text-indigo-800'
                    : 'bg-white text-slate-800'
              } ${isToday ? 'font-extrabold underline decoration-2 underline-offset-4' : ''}`}
            >
              {unconfiguredCount > 0 && date < todayDate && (
                <UnconfiguredMarker dateMarker className="absolute right-[3px] top-[3px] h-3 w-3" />
              )}
              <span>{day}</span>
              <span className="mt-1 flex min-h-1 justify-center gap-0.5" aria-hidden="true">
                {configuredLessons.slice(0, 3).map((lesson) => {
                  const color = studioColor(lesson.studioName, colorMap[lesson.studioName]);
                  return (
                    <span
                      key={lesson.eventIdentity.eventId}
                      className="h-1.5 w-3 rounded-full"
                      style={{ backgroundColor: isSelected ? 'white' : color.borderColor }}
                    />
                  );
                })}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
