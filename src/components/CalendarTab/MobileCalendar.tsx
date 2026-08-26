import type { ParsedClass, StudioConfig } from '../../lib/types.js';
import type { StudioMonthStats } from '../../lib/invoice/calculator.js';
import { studioColor } from '../../lib/studioColors.js';
import { MobileAgenda } from './MobileAgenda.js';
import { MobileMonthGrid } from './MobileMonthGrid.js';
import { localDateString } from './mobile-calendar.js';
import { UnconfiguredMarker } from './UnconfiguredMarker.js';

interface Props {
  mode: 'month' | 'agenda';
  year: number;
  month: number;
  classes: ParsedClass[];
  studios: Record<string, StudioConfig>;
  colorMap: Record<string, string | undefined>;
  studioStats: Array<{ key: string; stats: StudioMonthStats }>;
  selectedDate: string;
  agendaFocusRequest: number;
  monthFocusRequest: number;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onOpenAgenda: (date: string, anchor: HTMLButtonElement) => void;
  onSelectAgendaDate: (date: string) => void;
  onSelectLesson: (lesson: ParsedClass, anchor: HTMLButtonElement) => void;
}

const MONTH_NAMES = [
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
];

function dateStrip(year: number, month: number, selectedDate: string): Date[] {
  const selectedDay = Math.min(
    Number(selectedDate.slice(-2)),
    new Date(year, month + 1, 0).getDate()
  );
  const startDay = Math.min(
    Math.max(selectedDay - 3, 1),
    new Date(year, month + 1, 0).getDate() - 6
  );
  return Array.from({ length: 7 }, (_, index) => new Date(year, month, startDay + index));
}

function dateString(date: Date): string {
  return localDateString(date.getFullYear(), date.getMonth(), date.getDate());
}

export function MobileCalendar({
  mode,
  year,
  month,
  classes,
  studios,
  colorMap,
  studioStats,
  selectedDate,
  agendaFocusRequest,
  monthFocusRequest,
  onPreviousMonth,
  onNextMonth,
  onOpenAgenda,
  onSelectAgendaDate,
  onSelectLesson,
}: Props) {
  const totalClasses = classes.filter((lesson) => !lesson.unconfigured).length;
  const totalAmount = studioStats.reduce((sum, { stats }) => sum + stats.totalAmount, 0);
  const strip = dateStrip(year, month, selectedDate);
  const today = dateString(new Date());
  const legendStudios = [
    ...new Set(classes.filter((lesson) => !lesson.unconfigured).map((lesson) => lesson.studioName)),
  ].sort();
  const hasUnconfigured = classes.some((lesson) => lesson.unconfigured);

  return (
    <div className="px-4 pb-6 pt-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-label="Previous month"
          onClick={onPreviousMonth}
          className="min-h-12 min-w-12 rounded-lg text-2xl text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-600"
        >
          ‹
        </button>
        <h1 className="text-xl font-semibold text-slate-900">
          {MONTH_NAMES[month]} {year}
        </h1>
        <button
          type="button"
          aria-label="Next month"
          onClick={onNextMonth}
          className="min-h-12 min-w-12 rounded-lg text-2xl text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-600"
        >
          ›
        </button>
      </div>

      {mode === 'agenda' && (
        <div className="mt-2 grid grid-cols-7 gap-1" aria-label="Date selector">
          {strip.map((date) => {
            const dateValue = dateString(date);
            const selected = dateValue === selectedDate;
            const isToday = dateValue === today;
            return (
              <button
                key={dateValue}
                type="button"
                aria-label={date.toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
                aria-current={isToday ? 'date' : undefined}
                aria-pressed={selected}
                onClick={() => onSelectAgendaDate(dateValue)}
                className={`min-h-12 rounded-lg text-center text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-600 ${
                  selected
                    ? 'bg-indigo-600 text-white ring-2 ring-slate-900 ring-offset-1'
                    : isToday
                      ? 'bg-indigo-50 text-indigo-800'
                      : 'text-slate-700'
                } ${isToday ? 'font-extrabold underline decoration-2 underline-offset-4' : ''}`}
              >
                <span className="block text-[10px] uppercase">
                  {date.toLocaleDateString('en-US', { weekday: 'short' })}
                </span>
                <span>{date.getDate()}</span>
              </button>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-sm text-slate-600">
        {MONTH_NAMES[month]} {year} overview <span aria-hidden="true">·</span> {totalClasses}{' '}
        classes <span aria-hidden="true">·</span> €{totalAmount.toFixed(2)} expected
      </p>

      {mode === 'agenda' ? (
        <MobileAgenda
          selectedDate={selectedDate}
          lessons={classes}
          studios={studios}
          colorMap={colorMap}
          onSelectLesson={onSelectLesson}
          focusRequest={agendaFocusRequest}
        />
      ) : (
        <>
          <MobileMonthGrid
            year={year}
            month={month}
            classes={classes}
            studios={studios}
            colorMap={colorMap}
            selectedDate={selectedDate}
            onSelectDate={onOpenAgenda}
            focusRequest={monthFocusRequest}
          />
          {(legendStudios.length > 0 || hasUnconfigured) && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Studio legend">
              {legendStudios.map((studioName) => {
                const color = studioColor(studioName, colorMap[studioName]);
                return (
                  <span
                    key={studioName}
                    className="inline-flex items-center gap-2 text-sm text-slate-700"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-4 rounded-full"
                      style={{ backgroundColor: color.borderColor }}
                    />
                    {studioName}
                  </span>
                );
              })}
              {hasUnconfigured && (
                <span className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <UnconfiguredMarker className="h-3 w-3" />
                  Unconfigured
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
