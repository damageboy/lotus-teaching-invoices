import { useState } from 'react';
import { AppConfig, RateTier, TeacherInfo, BankDetails } from '../../lib/types';
import { nextUnusedColor } from '../../lib/studioColors';
import { APP_VERSION, APP_IS_OFFICIAL } from '../../lib/version';
import type { AppLayout } from '../../hooks/useCompactLayout';
import type { CalendarPickerController } from '../../hooks/useCalendarPicker';
import { MobileSettings, StudioCard } from './MobileSettings';

interface Props {
  layout?: AppLayout;
  config: AppConfig;
  calendarPicker: CalendarPickerController;
  isDirty: boolean;
  saveError: string | null;
  onUpdate: (c: AppConfig) => void;
  onSave: (next?: AppConfig) => Promise<void>;
}

export function RatesTab({
  layout = 'desktop',
  config,
  calendarPicker,
  isDirty,
  saveError,
  onUpdate,
  onSave,
}: Props) {
  const calendarBusy = calendarPicker.loading || calendarPicker.saving;

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
        selectedCalendarName={calendarPicker.selectedName}
        calendars={calendarPicker.calendars}
        calendarListOpen={calendarPicker.listOpen}
        calendarLoading={calendarBusy}
        calendarError={calendarPicker.error}
        onSave={() => onSave()}
        onUpdateTeacher={updateTeacher}
        onUpdateBank={updateBank}
        onPickCalendar={calendarPicker.openList}
        onSelectCalendar={(id, summary, accessRole) =>
          calendarPicker.select({ id, summary, ...(accessRole ? { accessRole } : {}) })
        }
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
        <div className="flex flex-col gap-2">
          {config.calendarId ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                {calendarPicker.selectedName}
              </span>
              <button
                onClick={() => void calendarPicker.openList()}
                disabled={calendarBusy}
                className="flex-shrink-0 text-xs text-indigo-500 hover:text-indigo-700"
              >
                {calendarBusy ? 'Loading…' : 'Change…'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => void calendarPicker.openList()}
              disabled={calendarBusy}
              className="self-start px-3 py-1.5 rounded border border-gray-300 text-sm text-gray-600 hover:border-indigo-400 hover:text-indigo-600"
            >
              {calendarBusy ? 'Loading…' : 'Pick Calendar…'}
            </button>
          )}
          {calendarPicker.error && (
            <span className="text-xs text-red-500">{calendarPicker.error}</span>
          )}
          {calendarPicker.listOpen && calendarPicker.calendars && (
            <div className="flex flex-col gap-1 p-2 rounded border border-gray-200 bg-gray-50 max-h-48 overflow-y-auto">
              {calendarPicker.calendars.map((cal) => (
                <button
                  key={cal.id}
                  onClick={() => void calendarPicker.select(cal)}
                  disabled={calendarPicker.saving}
                  className={`text-left text-sm px-2 py-1 rounded hover:bg-indigo-50 ${
                    config.calendarId === cal.id
                      ? 'bg-indigo-100 text-indigo-700 font-medium'
                      : 'text-gray-700'
                  }`}
                >
                  {cal.summary}
                </button>
              ))}
              {calendarPicker.calendars.length === 0 && (
                <span className="text-xs text-gray-400">No calendars found</span>
              )}
            </div>
          )}
        </div>
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
