import { useState } from 'react';
import { ParsedClass } from '../../lib/types';
import { CalendarGrid } from './CalendarGrid';
import { studioColor } from '../../lib/studioColors';

interface Props {
  classes: ParsedClass[];
}

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

export function CalendarTab({ classes }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const monthClasses = classes.filter(cls => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return cls.date.startsWith(prefix);
  });

  // Unique studios for legend — split configured vs unconfigured
  const configuredStudios = [...new Set(classes.filter(c => !c.unconfigured).map(c => c.studioName))].sort();
  const unconfiguredStudios = [...new Set(classes.filter(c => c.unconfigured).map(c => c.studioName))].sort();

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Month switcher */}
      <div className="flex items-center gap-4">
        <button onClick={prevMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">‹</button>
        <h2 className="text-lg font-semibold w-44 text-center">{MONTH_NAMES[month]} {year}</h2>
        <button onClick={nextMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">›</button>
        <span className="ml-4 text-sm text-gray-400">
          {monthClasses.filter(c => !c.unconfigured).length} classes
          {monthClasses.some(c => c.unconfigured) && (
            <span className="ml-1 text-gray-300">
              + {monthClasses.filter(c => c.unconfigured).length} unconfigured
            </span>
          )}
        </span>
      </div>

      {/* Legend */}
      {(configuredStudios.length > 0 || unconfiguredStudios.length > 0) && (
        <div className="flex gap-2 flex-wrap items-center">
          {configuredStudios.map(s => {
            const c = studioColor(s);
            return (
              <span key={s} className={`text-xs px-2 py-0.5 rounded border ${c.bg} ${c.text} ${c.border}`}>
                {s}
              </span>
            );
          })}
          {unconfiguredStudios.length > 0 && configuredStudios.length > 0 && (
            <span className="text-gray-200">|</span>
          )}
          {unconfiguredStudios.map(s => (
            <span key={s} className="text-xs px-2 py-0.5 rounded border bg-gray-100 text-gray-400 border-gray-200" title="No rates configured">
              ⚠ {s}
            </span>
          ))}
        </div>
      )}

      <CalendarGrid year={year} month={month} classes={monthClasses} />
    </div>
  );
}
