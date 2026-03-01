import { AppConfig } from '../../lib/types';
interface Props { config: AppConfig; isDirty: boolean; onUpdate: (c: AppConfig) => void; onSave: () => Promise<void>; }
export function RatesTab({ config }: Props) {
  return <div className="p-4">Rates — {Object.keys(config.studios).length} studios</div>;
}
