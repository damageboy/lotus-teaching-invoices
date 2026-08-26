import { useState } from 'react';
import { AppConfig, RateTier, TeacherInfo, BankDetails } from '../../lib/types';
import { nextUnusedColor } from '../../lib/studioColors';
import { APP_VERSION, APP_IS_OFFICIAL } from '../../lib/version';
import type { AppLayout } from '../../hooks/useCompactLayout';
import type { CalendarPickerController } from '../../hooks/useCalendarPicker';
import type { DriveFolderController } from '../../hooks/useDriveFolderController';
import type { DriveInvoicesState } from '../../hooks/useDriveInvoices';
import { ConnectionsSection } from '../setup/ConnectionsSection';
import { MobileSettings, StudioCard } from './MobileSettings';

interface Props {
  layout?: AppLayout;
  config: AppConfig;
  calendarPicker: CalendarPickerController;
  drive: Pick<DriveInvoicesState, 'status' | 'snapshot' | 'error' | 'operationKey'>;
  driveFolder: DriveFolderController;
  isDirty: boolean;
  saveError: string | null;
  onUpdate: (c: AppConfig) => void;
  onSave: () => Promise<void>;
}

export function RatesTab({
  layout = 'desktop',
  config,
  calendarPicker,
  drive,
  driveFolder,
  isDirty,
  saveError,
  onUpdate,
  onSave,
}: Props) {
  function updateTeacher(key: keyof Omit<TeacherInfo, 'bankDetails'>, value: string) {
    onUpdate({ ...config, teacher: { ...config.teacher, [key]: value } });
  }
  function updateBank(key: keyof BankDetails, value: string) {
    onUpdate({
      ...config,
      teacher: { ...config.teacher, bankDetails: { ...config.teacher.bankDetails, [key]: value } },
    });
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
      [field]:
        field === 'maxStudents'
          ? raw === ''
            ? null
            : Number(raw)
          : raw === ''
            ? Number.NaN
            : Number(raw),
    };
    if (index === 0) tiers[index].minStudents = 1;
    if (index === tiers.length - 1) tiers[index].maxStudents = null;
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [studioName]: { ...config.studios[studioName], rateTiers: tiers },
      },
    });
  }

  function addTier(studioName: string) {
    const existing = config.studios[studioName].rateTiers;
    const tiers =
      existing.length === 0
        ? [{ minStudents: 1, maxStudents: null, rate: 50 }]
        : existing.map((tier, i) =>
            i === existing.length - 1
              ? {
                  ...tier,
                  maxStudents: Math.max(tier.minStudents, tier.maxStudents ?? tier.minStudents),
                }
              : tier
          );
    const previous = tiers[tiers.length - 1];
    tiers.push({
      minStudents:
        previous.maxStudents === null || Number.isNaN(previous.maxStudents)
          ? previous.minStudents + 1
          : previous.maxStudents + 1,
      maxStudents: null,
      rate: previous.rate,
    });
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
    if (tiers[0]) tiers[0].minStudents = 1;
    if (tiers[tiers.length - 1]) tiers[tiers.length - 1].maxStudents = null;
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

  if (layout === 'mobile') {
    return (
      <MobileSettings
        config={config}
        isDirty={isDirty}
        saveError={saveError}
        connections={
          <ConnectionsSection
            layout="mobile"
            calendarConfigured={Boolean(config.calendarId?.trim())}
            calendarPicker={calendarPicker}
            drive={drive}
            driveFolder={driveFolder}
          />
        }
        onSave={() => onSave()}
        onUpdateTeacher={updateTeacher}
        onUpdateBank={updateBank}
        onRenameStudio={updateStudioName}
        onDeleteStudio={deleteStudio}
        onUpdateTier={updateTier}
        onAddTier={addTier}
        onRemoveTier={removeTier}
        onUpdateStudioField={updateStudioField}
        onUpdateStudioColor={updateStudioColor}
        onAddStudio={addStudio}
      />
    );
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

      <ConnectionsSection
        layout="desktop"
        calendarConfigured={Boolean(config.calendarId?.trim())}
        calendarPicker={calendarPicker}
        drive={drive}
        driveFolder={driveFolder}
      />

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
