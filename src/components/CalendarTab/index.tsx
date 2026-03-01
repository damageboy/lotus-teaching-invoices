import { ParsedClass } from '../../lib/types';
interface Props { classes: ParsedClass[]; }
export function CalendarTab({ classes }: Props) {
  return <div className="p-4">Calendar — {classes.length} classes loaded</div>;
}
