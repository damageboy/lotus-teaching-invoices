import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
  studioHex?: string;
  today?: string; // YYYY-MM-DD, for testing; defaults to current date
}

export function EventChip({ cls, studioHex, today }: Props) {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const c = studioColor(cls.studioName, studioHex);

  // Past class with missing student count
  if (!cls.unconfigured && cls.studentCount === 0 && cls.date < todayStr) {
    return (
      <div
        title={`${cls.studioName} — missing student count`}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed border-amber-400 bg-amber-50 text-amber-700 opacity-90 cursor-default"
      >
        ⚠ {cls.startTime} {cls.classType}
      </div>
    );
  }

  if (cls.unconfigured) {
    return (
      <div
        title={`${cls.studioName} — no rates configured`}
        style={{ ...c, opacity: 0.7, borderStyle: 'dashed' }}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border cursor-default"
      >
        ⚠ {cls.startTime} {cls.classType}
      </div>
    );
  }
  if (cls.ambiguousStudentCount) {
    return (
      <div
        title={`${cls.studioName} — ambiguous student count`}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed border-red-400 bg-red-50 text-red-700 opacity-90 cursor-default"
      >
        ❓ {cls.startTime} {cls.classType}
      </div>
    );
  }
  return (
    <div
      title={`${cls.studioName} — ${cls.studentCount} students`}
      style={c}
      className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border cursor-default"
    >
      {cls.startTime} {cls.classType}
    </div>
  );
}
