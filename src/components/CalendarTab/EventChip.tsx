import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
}

export function EventChip({ cls }: Props) {
  if (cls.unconfigured) {
    return (
      <div
        title={`${cls.studioName} — no rates configured`}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border bg-gray-100 text-gray-400 border-gray-200 cursor-default"
      >
        ⚠ {cls.startTime} {cls.classType}
      </div>
    );
  }
  const color = studioColor(cls.studioName);
  return (
    <div
      title={`${cls.studioName} — ${cls.studentCount} students`}
      className={`text-xs rounded px-1 py-0.5 mb-0.5 truncate border ${color.bg} ${color.text} ${color.border} cursor-default`}
    >
      {cls.startTime} {cls.classType}
    </div>
  );
}
