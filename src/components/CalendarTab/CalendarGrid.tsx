import { ParsedClass } from '../../lib/types';
import { EventChip } from './EventChip';

interface Props {
  year: number;
  month: number; // 0-indexed (0 = January)
  classes: ParsedClass[];
  colorMap?: Record<string, string | undefined>;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  // Returns 0=Mon … 6=Sun
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7;
}

export function CalendarGrid({ year, month, classes, colorMap = {} }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = getFirstDayOfWeek(year, month);

  // Build a map: "YYYY-MM-DD" -> ParsedClass[]
  const byDate = new Map<string, ParsedClass[]>();
  for (const cls of classes) {
    const list = byDate.get(cls.date) ?? [];
    list.push(cls);
    byDate.set(cls.date, list);
  }

  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded">
      {DAY_LABELS.map((d) => (
        <div key={d} className="bg-gray-50 text-center text-xs font-medium text-gray-500 py-1">
          {d}
        </div>
      ))}
      {cells.map((day, i) => {
        if (day === null) {
          return <div key={`empty-${i}`} className="bg-gray-50 min-h-[240px]" />;
        }
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayClasses = (byDate.get(dateStr) ?? []).sort((a, b) =>
          a.startTime.localeCompare(b.startTime)
        );
        const isToday =
          today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

        return (
          <div key={dateStr} className="bg-white min-h-[240px] p-1">
            <div
              className={`text-xs font-medium mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : 'text-gray-700'
              }`}
            >
              {day}
            </div>
            {dayClasses.map((cls) => (
              <EventChip
                key={`${cls.date}-${cls.startTime}-${cls.studioName}`}
                cls={cls}
                studioHex={colorMap[cls.studioName]}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
