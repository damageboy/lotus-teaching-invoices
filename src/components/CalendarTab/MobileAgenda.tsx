import { CaretRight } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { ParsedClass, StudioConfig } from '../../lib/types.js';
import { studioColor } from '../../lib/studioColors.js';
import { lessonExpectedAmount } from './mobile-calendar.js';

interface Props {
  selectedDate: string;
  lessons: ParsedClass[];
  studios: Record<string, StudioConfig>;
  colorMap: Record<string, string | undefined>;
  onSelectLesson: (lesson: ParsedClass, anchor: HTMLButtonElement) => void;
  focusRequest: number;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function studentLabel(lesson: ParsedClass): string {
  if (lesson.ambiguousStudentCount) return 'students unavailable';
  return `${lesson.studentCount} ${lesson.studentCount === 1 ? 'student' : 'students'}`;
}

export function MobileAgenda({
  selectedDate,
  lessons,
  studios,
  colorMap,
  onSelectLesson,
  focusRequest,
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRequest = useRef(0);
  const selectedLessons = lessons
    .filter((lesson) => lesson.date === selectedDate)
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

  useEffect(() => {
    if (focusRequest === previousFocusRequest.current) return;
    previousFocusRequest.current = focusRequest;
    headingRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  return (
    <section aria-label="Agenda">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 text-xl font-semibold text-slate-900 focus:outline-none"
      >
        {formatDate(selectedDate)}
      </h2>
      {selectedLessons.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-600">
          No lessons on this day
        </p>
      ) : (
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100 bg-white">
          {selectedLessons.map((lesson) => {
            const amount = lessonExpectedAmount(lesson, studios[lesson.studioName]);
            const amountLabel =
              amount === null ? 'Amount unavailable' : `€${amount.toFixed(2)} expected`;
            const students = studentLabel(lesson);
            const color = studioColor(lesson.studioName, colorMap[lesson.studioName]);
            return (
              <button
                key={lesson.eventIdentity.eventId}
                type="button"
                aria-label={`Open lesson details: ${lesson.studioName}, ${lesson.classType}, ${lesson.startTime}, ${students}, ${amountLabel}`}
                className="min-h-24 w-full border-b border-slate-100 px-4 py-4 text-left last:border-b-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-600"
                onClick={(event) => onSelectLesson(lesson, event.currentTarget)}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-1 h-9 w-1 rounded-full"
                    style={{ backgroundColor: color.borderColor }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold text-slate-900">{lesson.startTime}</span>
                      <span className="text-sm font-medium text-slate-700">{amountLabel}</span>
                    </div>
                    <p className="mt-1 font-medium text-slate-800">{lesson.studioName}</p>
                    <p className="text-sm text-slate-600">{lesson.classType}</p>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="text-sm text-slate-600">{students}</p>
                      <span className="flex items-center gap-1 text-sm font-semibold text-indigo-600">
                        Open
                        <CaretRight size={16} weight="bold" aria-hidden="true" />
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
