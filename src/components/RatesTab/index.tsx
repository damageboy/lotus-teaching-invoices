import { useState, useEffect } from 'react';
import { AppConfig, RateTier, StudioConfig } from '../../lib/types';

interface Props {
  config: AppConfig;
  isDirty: boolean;
  onUpdate: (c: AppConfig) => void;
  onSave: () => Promise<void>;
}

// Isolated card so studio name edits don't unmount the card on each keystroke
interface StudioCardProps {
  studioName: string;
  studio: StudioConfig;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onUpdateTier: (studioName: string, index: number, field: keyof RateTier, raw: string) => void;
  onAddTier: (studioName: string) => void;
  onRemoveTier: (studioName: string, index: number) => void;
}

function StudioCard({ studioName, studio, onRename, onDelete, onUpdateTier, onAddTier, onRemoveTier }: StudioCardProps) {
  const [draftName, setDraftName] = useState(studioName);
  useEffect(() => { setDraftName(studioName); }, [studioName]);

  return (
    <div className="p-4 rounded border border-gray-200 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-medium"
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          onBlur={() => { if (draftName !== studioName) onRename(studioName, draftName); }}
        />
        <button onClick={() => onDelete(studioName)} className="text-xs text-red-400 hover:text-red-600">
          Delete
        </button>
      </div>

      {/* Rate tiers table */}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 text-left">
            <th className="pb-1 font-normal">Min students</th>
            <th className="pb-1 font-normal">Max students</th>
            <th className="pb-1 font-normal">Rate (€)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {studio.rateTiers.map((tier, i) => (
            <tr key={i}>
              <td className="pr-2 py-0.5">
                <input
                  type="number" min={1}
                  className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                  value={tier.minStudents}
                  onChange={e => onUpdateTier(studioName, i, 'minStudents', e.target.value)}
                />
              </td>
              <td className="pr-2 py-0.5">
                <input
                  type="number"
                  placeholder="∞"
                  className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                  value={tier.maxStudents ?? ''}
                  onChange={e => onUpdateTier(studioName, i, 'maxStudents', e.target.value)}
                />
              </td>
              <td className="pr-2 py-0.5">
                <input
                  type="number" min={0}
                  className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                  value={tier.rate}
                  onChange={e => onUpdateTier(studioName, i, 'rate', e.target.value)}
                />
              </td>
              <td>
                <button onClick={() => onRemoveTier(studioName, i)} className="text-gray-300 hover:text-red-400">✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => onAddTier(studioName)} className="text-xs text-indigo-500 hover:text-indigo-700 self-start">
        + Add tier
      </button>
    </div>
  );
}

export function RatesTab({ config, isDirty, onUpdate, onSave }: Props) {
  function updateGlobal(key: 'teacherName' | 'calendarUrl', value: string) {
    onUpdate({ ...config, [key]: value });
  }

  function updateStudioName(oldName: string, newName: string) {
    const studios = Object.fromEntries(
      Object.entries(config.studios).map(([k, v]) => [k === oldName ? newName : k, v])
    );
    onUpdate({ ...config, studios });
  }

  function updateTier(studioName: string, index: number, field: keyof RateTier, raw: string) {
    const tiers = [...config.studios[studioName].rateTiers];
    tiers[index] = {
      ...tiers[index],
      [field]: field === 'maxStudents'
        ? (raw === '' ? null : Number(raw))
        : Number(raw),
    };
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { ...config.studios[studioName], rateTiers: tiers } } });
  }

  function addTier(studioName: string) {
    const tiers = [...config.studios[studioName].rateTiers, { minStudents: 1, maxStudents: null, rate: 50 }];
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { ...config.studios[studioName], rateTiers: tiers } } });
  }

  function removeTier(studioName: string, index: number) {
    const tiers = config.studios[studioName].rateTiers.filter((_, i) => i !== index);
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { ...config.studios[studioName], rateTiers: tiers } } });
  }

  function addStudio() {
    const name = `New Studio ${Object.keys(config.studios).length + 1}`;
    onUpdate({ ...config, studios: { ...config.studios, [name]: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }] } } });
  }

  function deleteStudio(name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    const { [name]: _, ...rest } = config.studios;
    onUpdate({ ...config, studios: rest });
  }

  return (
    <div className="p-4 flex flex-col gap-6 max-w-2xl">
      {/* Save bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Rates &amp; Config</h2>
        <div className="flex items-center gap-3">
          {isDirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
          <button
            onClick={onSave}
            disabled={!isDirty}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>

      {/* Global settings */}
      <div className="flex flex-col gap-3 p-4 rounded border border-gray-200">
        <h3 className="text-sm font-medium text-gray-700">Global</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Teacher name</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm"
            value={config.teacherName}
            onChange={e => updateGlobal('teacherName', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Calendar URL (ICS)</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
            value={config.calendarUrl}
            onChange={e => updateGlobal('calendarUrl', e.target.value)}
          />
        </label>
      </div>

      {/* Studio cards — use index key so renaming doesn't unmount the card */}
      {Object.entries(config.studios).map(([studioName, studio], idx) => (
        <StudioCard
          key={idx}
          studioName={studioName}
          studio={studio}
          onRename={updateStudioName}
          onDelete={deleteStudio}
          onUpdateTier={updateTier}
          onAddTier={addTier}
          onRemoveTier={removeTier}
        />
      ))}

      <button
        onClick={addStudio}
        className="self-start px-4 py-1.5 rounded border border-dashed border-gray-300 text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
      >
        + Add studio
      </button>
    </div>
  );
}
