import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
  studioHex?: string;
}

export function EventChip({ cls, studioHex }: Props) {
  const c = studioColor(cls.studioName, studioHex);
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
