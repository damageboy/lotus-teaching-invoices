import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
}

export function EventChip({ cls }: Props) {
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
