import { useEffect, useRef } from 'react';
import type { ParsedClass, StudioConfig } from '../../lib/types.js';
import { studioColor } from '../../lib/studioColors.js';
import { buildMonthGrid, localDateString, WEEKDAYS } from './mobile-calendar.js';
import { UnconfiguredMarker } from './UnconfiguredMarker.js';

interface Props {
  year: number;
  month: number;
  classes: ParsedClass[];
  studios: Record<string, StudioConfig>;
  colorMap: Record<string, string | undefined>;
  selectedDate: string;
  onSelectDate: (date: string, anchor: HTMLButtonElement) => void;
  focusRequest: number;
}

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
  studios,
  colorMap,
  selectedDate,
  onSelectDate,
  focusRequest,
}: Props) {
  const selectedDayRef = useRef<HTMLButtonElement>(null);
  const previousFocusRequest = useRef(0);
  const cells = buildMonthGrid(year, month, classes, studios);
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
        {cells.map((cell, index) => {
          if (cell === null) {
            return (
              <span
                key={`empty-${index}`}
                className="min-h-12 border-b border-r border-slate-200"
              />
            );
          }
          const accessibleLabel =
            cell.incompleteCount === 0
              ? dateLabel(year, month, cell.day)
              : `${dateLabel(year, month, cell.day)}, ${cell.incompleteCount} incomplete ${
                  cell.incompleteCount === 1 ? 'class' : 'classes'
                }`;
          const isToday = cell.date === todayDate;
          const isSelected = selectedDate === cell.date;
          let stateClasses = 'bg-white text-slate-800';
          if (isToday) stateClasses = 'bg-indigo-50 text-indigo-800';
          if (isSelected) {
            stateClasses = 'bg-indigo-600 text-white ring-2 ring-inset ring-slate-900';
          }
          return (
            <button
              key={cell.date}
              ref={isSelected ? selectedDayRef : undefined}
              type="button"
              aria-label={accessibleLabel}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
              onClick={(event) => onSelectDate(cell.date, event.currentTarget)}
              className={`relative min-h-12 min-w-12 border-b border-r border-slate-200 p-1 text-center text-sm font-medium focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-600 ${stateClasses} ${isToday ? 'font-extrabold underline decoration-2 underline-offset-4' : ''}`}
            >
              {cell.incompleteCount > 0 && cell.date < todayDate && (
                <UnconfiguredMarker dateMarker className="absolute right-[3px] top-[3px] h-3 w-3" />
              )}
              <span>{cell.day}</span>
              <span className="mt-1 flex min-h-1 justify-center gap-0.5" aria-hidden="true">
                {cell.configuredLessons.slice(0, 3).map((lesson) => {
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
