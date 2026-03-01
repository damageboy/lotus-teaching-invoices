import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
}

export function EventChip({ cls }: Props) {
  const color = studioColor(cls.studioName);
  if (cls.unconfigured) {
    return (
      <div
        title={`${cls.studioName} — no rates configured`}
        className={`text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed ${color.bg} ${color.text} ${color.border} opacity-70 cursor-default`}
      >
        ⚠ {cls.startTime} {cls.classType}
      </div>
    );
  }
  return (
    <div
      title={`${cls.studioName} — ${cls.studentCount} students`}
      className={`text-xs rounded px-1 py-0.5 mb-0.5 truncate border ${color.bg} ${color.text} ${color.border} cursor-default`}
    >
      {cls.startTime} {cls.classType}
    </div>
  );
}
