import { ParsedClass, AppConfig } from '../../lib/types';
interface Props { classes: ParsedClass[]; config: AppConfig; onSaveConfig: (c: AppConfig) => Promise<void>; }
export function InvoicesTab({ classes }: Props) {
  return <div className="p-4">Invoices — {classes.length} classes</div>;
}
