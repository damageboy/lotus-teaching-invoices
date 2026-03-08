import { useState, useEffect } from 'react';
import { AppConfig, RateTier, StudioConfig, TeacherInfo, BankDetails } from '../../lib/types';
import { ColorPickerPopup } from '../ColorPickerPopup';
import { effectiveHex, nextUnusedColor } from '../../lib/studioColors';
import { APP_VERSION, APP_IS_OFFICIAL } from '../../lib/version';

interface Props {
  config: AppConfig;
  isDirty: boolean;
  saveError: string | null;
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
  onUpdateColor: (studioName: string, hex: string) => void;
  onUpdateField: (
    studioName: string,
    field: 'fullName' | 'address' | 'invoiceEmail',
    value: string
  ) => void;
}

function StudioCard({
  studioName,
  studio,
  onRename,
  onDelete,
  onUpdateTier,
  onAddTier,
  onRemoveTier,
  onUpdateField,
  onUpdateColor,
}: StudioCardProps) {
  const [draftName, setDraftName] = useState(studioName);
  const [isOpen, setIsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  useEffect(() => {
    setDraftName(studioName);
  }, [studioName]);

  // Effective color: stored hex or hash-derived palette hex for this studio name
  const effectiveColor = effectiveHex(studioName, studio.color);

  return (
    <div className="rounded border border-gray-200">
      {/* Header — always visible, click to toggle */}
      <div
        className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"
        onClick={() => setIsOpen((o) => !o)}
      >
        <span className="text-gray-400 text-xs w-3">{isOpen ? '▾' : '▸'}</span>

        {/* Color dot trigger */}
        <div className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            title="Change studio color"
            style={{ backgroundColor: effectiveColor }}
            className="w-4 h-4 rounded-full border border-white shadow-sm hover:scale-110 transition-transform"
          />
          {pickerOpen && (
            <ColorPickerPopup
              currentColor={effectiveColor}
              onColorChange={(hex) => onUpdateColor(studioName, hex)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        <span className="flex-1 text-sm font-medium truncate">{draftName}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(studioName);
          }}
          className="text-xs text-red-400 hover:text-red-600"
        >
          Delete
        </button>
      </div>

      {/* Body — only when open */}
      {isOpen && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-gray-100">
          <div className="flex items-center gap-2 pt-3">
            <input
              className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-medium"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                if (draftName !== studioName) onRename(studioName, draftName);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Full name (for invoice)</span>
            <input
              className="border border-gray-200 rounded px-2 py-1 text-sm"
              value={studio.fullName}
              onChange={(e) => onUpdateField(studioName, 'fullName', e.target.value)}
              placeholder="e.g. Yogibar Yoga Studio GmbH"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Address</span>
            <textarea
              className="border border-gray-200 rounded px-2 py-1 text-sm resize-none"
              rows={2}
              value={studio.address}
              onChange={(e) => onUpdateField(studioName, 'address', e.target.value)}
              placeholder="Street, City"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Invoice e-mail</span>
            <input
              type="email"
              className={`border rounded px-2 py-1 text-sm ${emailError ? 'border-red-400' : 'border-gray-200'}`}
              value={studio.invoiceEmail ?? ''}
              onChange={(e) => {
                setEmailError(null);
                onUpdateField(studioName, 'invoiceEmail', e.target.value);
              }}
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
                  setEmailError('Please enter a valid e-mail address');
                } else {
                  setEmailError(null);
                }
              }}
              placeholder="studio@example.com"
            />
            {emailError && <span className="text-xs text-red-500">{emailError}</span>}
          </label>

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
                      type="number"
                      min={1}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.minStudents}
                      onChange={(e) => onUpdateTier(studioName, i, 'minStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      placeholder="∞"
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.maxStudents ?? ''}
                      onChange={(e) => onUpdateTier(studioName, i, 'maxStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      min={0}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.rate}
                      onChange={(e) => onUpdateTier(studioName, i, 'rate', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => onRemoveTier(studioName, i)}
                      className="text-gray-300 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => onAddTier(studioName)}
            className="text-xs text-indigo-500 hover:text-indigo-700 self-start"
          >
            + Add tier
          </button>
        </div>
      )}
    </div>
  );
}

export function RatesTab({ config, isDirty, saveError, onUpdate, onSave }: Props) {
  function updateTeacher(key: keyof Omit<TeacherInfo, 'bankDetails'>, value: string) {
    onUpdate({ ...config, teacher: { ...config.teacher, [key]: value } });
  }
  function updateBank(key: keyof BankDetails, value: string) {
    onUpdate({
      ...config,
      teacher: { ...config.teacher, bankDetails: { ...config.teacher.bankDetails, [key]: value } },
    });
  }
  function updateCalendarUrl(value: string) {
    onUpdate({ ...config, calendarUrl: value });
  }
  function updateLastInvoice(value: string) {
    onUpdate({ ...config, lastInvoice: value });
  }

  function updateStudioName(oldName: string, newName: string) {
    const studios = Object.fromEntries(
      Object.entries(config.studios).map(([k, v]) => [k === oldName ? newName : k, v])
    );
    onUpdate({ ...config, studios });
  }

  function updateStudioField(
    studioName: string,
    field: 'fullName' | 'address' | 'invoiceEmail',
    value: string
  ) {
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], [field]: value },
      },
    });
  }

  function updateStudioColor(studioName: string, hex: string) {
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], color: hex },
      },
    });
  }

  function updateTier(studioName: string, index: number, field: keyof RateTier, raw: string) {
    const tiers = [...config.studios[studioName].rateTiers];
    tiers[index] = {
      ...tiers[index],
      [field]: field === 'maxStudents' ? (raw === '' ? null : Number(raw)) : Number(raw),
    };
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], rateTiers: tiers },
      },
    });
  }

  function addTier(studioName: string) {
    const tiers = [
      ...config.studios[studioName].rateTiers,
      { minStudents: 1, maxStudents: null, rate: 50 },
    ];
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], rateTiers: tiers },
      },
    });
  }

  function removeTier(studioName: string, index: number) {
    const tiers = config.studios[studioName].rateTiers.filter((_, i) => i !== index);
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], rateTiers: tiers },
      },
    });
  }

  function addStudio() {
    const name = `New Studio ${Object.keys(config.studios).length + 1}`;
    const usedHexes = Object.values(config.studios)
      .map((s) => s.color)
      .filter((c): c is string => c !== undefined);
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [name]: {
          fullName: '',
          address: '',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
          color: nextUnusedColor(usedHexes),
        },
      },
    });
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
          {saveError && (
            <span className="text-xs text-red-500" title={saveError}>
              Save failed
            </span>
          )}
          {!saveError && isDirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
          <button
            onClick={() => onSave()}
            disabled={!isDirty}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>

      {/* Global settings */}
      <div className="flex flex-col gap-3 p-4 rounded border border-gray-200">
        <h3 className="text-sm font-medium text-gray-700">Teacher</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Name</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm"
            value={config.teacher.name}
            onChange={(e) => updateTeacher('name', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Address</span>
          <textarea
            className="border border-gray-200 rounded px-2 py-1 text-sm resize-none"
            rows={3}
            value={config.teacher.address}
            onChange={(e) => updateTeacher('address', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Tax number</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm"
            value={config.teacher.taxNumber}
            onChange={(e) => updateTeacher('taxNumber', e.target.value)}
          />
        </label>

        <h3 className="text-sm font-medium text-gray-700 mt-2">Bank details</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Account owner</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm"
            value={config.teacher.bankDetails.accountOwner}
            onChange={(e) => updateBank('accountOwner', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">IBAN</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono tracking-wide"
            value={config.teacher.bankDetails.iban}
            onChange={(e) => updateBank('iban', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">BIC</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
            value={config.teacher.bankDetails.bic}
            onChange={(e) => updateBank('bic', e.target.value)}
          />
        </label>

        <h3 className="text-sm font-medium text-gray-700 mt-2">Calendar</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Calendar URL (ICS)</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
            value={config.calendarUrl}
            onChange={(e) => updateCalendarUrl(e.target.value)}
          />
        </label>

        <h3 className="text-sm font-medium text-gray-700 mt-2">Invoicing</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Last invoice number</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-32"
            value={config.lastInvoice}
            onChange={(e) => updateLastInvoice(e.target.value)}
            placeholder="e.g. 7/2026"
          />
          <span className="text-xs text-gray-400">
            The next finalized invoice will use the following number.
          </span>
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
          onUpdateField={updateStudioField}
          onUpdateColor={updateStudioColor}
        />
      ))}

      <button
        onClick={addStudio}
        className="self-start px-4 py-1.5 rounded border border-dashed border-gray-300 text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
      >
        + Add studio
      </button>

      {/* Version badge */}
      <div className="flex justify-end pt-2">
        <span data-testid="version-badge" className="text-xs text-gray-400 font-mono">
          v{APP_VERSION}
          {!APP_IS_OFFICIAL && (
            <span className="ml-1.5 px-1 py-0.5 rounded bg-gray-100 text-gray-400">dev</span>
          )}
          {!APP_IS_OFFICIAL && APP_VERSION.endsWith('-dirty') && (
            <span className="ml-1 px-1 py-0.5 rounded bg-amber-50 text-amber-500">dirty</span>
          )}
        </span>
      </div>
    </div>
  );
}
