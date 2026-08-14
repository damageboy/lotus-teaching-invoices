import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
  studioHex?: string;
  today?: string; // YYYY-MM-DD, for testing; defaults to current date
  onSelect?: (lesson: ParsedClass, anchor: HTMLButtonElement) => void;
}

export function EventChip({ cls, studioHex, today, onSelect }: Props) {
  const chipLabel = cls.location ? `${cls.location} / ${cls.classType}` : cls.classType;
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const c = studioColor(cls.studioName, studioHex);
  const label = `${cls.studioName}, ${chipLabel}, ${cls.startTime}`;

  // Past class with missing student count
  if (!cls.unconfigured && cls.studentCount === 0 && cls.date < todayStr) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={(event) => onSelect?.(cls, event.currentTarget)}
        title={`${cls.studioName} — missing student count`}
        className="block w-full text-left text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed border-amber-400 bg-amber-50 text-amber-700 opacity-90 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        ⚠ {cls.startTime} {chipLabel}
      </button>
    );
  }

  if (cls.unconfigured) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={(event) => onSelect?.(cls, event.currentTarget)}
        title={`${cls.studioName} — no rates configured`}
        style={{ ...c, opacity: 0.7, borderStyle: 'dashed' }}
        className="block w-full text-left text-xs rounded px-1 py-0.5 mb-0.5 truncate border hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        ⚠ {cls.startTime} {chipLabel}
      </button>
    );
  }
  if (cls.ambiguousStudentCount) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={(event) => onSelect?.(cls, event.currentTarget)}
        title={`${cls.studioName} — ambiguous student count`}
        className="block w-full text-left text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed border-red-400 bg-red-50 text-red-700 opacity-90 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        ❓ {cls.startTime} {chipLabel}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => onSelect?.(cls, event.currentTarget)}
      title={`${cls.studioName} — ${cls.studentCount} students`}
      style={c}
      className="block w-full text-left text-xs rounded px-1 py-0.5 mb-0.5 truncate border hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      {cls.startTime} {chipLabel}
    </button>
  );
}
