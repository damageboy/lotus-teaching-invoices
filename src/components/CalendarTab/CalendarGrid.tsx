import type { ParsedClass, StudioConfig } from '../../lib/types';
import { EventChip } from './EventChip';
import { buildMonthGrid, localDateString, WEEKDAYS } from './mobile-calendar.js';
import { UnconfiguredMarker } from './UnconfiguredMarker.js';

interface Props {
  year: number;
  month: number; // 0-indexed (0 = January)
  classes: ParsedClass[];
  studios?: Record<string, StudioConfig>;
  colorMap?: Record<string, string | undefined>;
  onSelectLesson?: (lesson: ParsedClass, anchor: HTMLButtonElement) => void;
}

export function CalendarGrid({
  year,
  month,
  classes,
  studios = {},
  colorMap = {},
  onSelectLesson,
}: Props) {
  const cells = buildMonthGrid(year, month, classes, studios);
  const today = new Date();
  const todayDate = localDateString(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded">
      {WEEKDAYS.map((d) => (
        <div key={d} className="bg-gray-50 text-center text-xs font-medium text-gray-500 py-1">
          {d}
        </div>
      ))}
      {cells.map((cell, i) => {
        if (cell === null) {
          return <div key={`empty-${i}`} className="bg-gray-50 min-h-[240px]" />;
        }
        const dayClasses = [...cell.lessons].sort((a, b) => a.startTime.localeCompare(b.startTime));
        const isToday = cell.date === todayDate;

        return (
          <div key={cell.date} className="relative bg-white min-h-[240px] p-1">
            <div
              className={`text-xs font-medium mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : 'text-gray-700'
              }`}
            >
              {cell.day}
            </div>
            {cell.incompleteCount > 0 && cell.date < todayDate && (
              <UnconfiguredMarker dateMarker className="absolute right-1 top-1 h-3 w-3" />
            )}
            {dayClasses.map((cls) => (
              <EventChip
                key={cls.eventIdentity.eventId}
                cls={cls}
                studioHex={colorMap[cls.studioName]}
                onSelect={onSelectLesson}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
