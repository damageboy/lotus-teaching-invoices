import { useEffect, useState, type ReactNode } from 'react';
import type { AppConfig, BankDetails, RateTier, StudioConfig, TeacherInfo } from '../../lib/types';
import type { AppLayout } from '../../hooks/useCompactLayout';
import { ColorPickerPopup } from '../ColorPickerPopup';
import { effectiveHex } from '../../lib/studioColors';
import { getRateTierValidation } from '../../lib/config/rateTiers';
import { VersionBadge } from '../VersionBadge';

export interface StudioCardProps {
  layout?: AppLayout;
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

interface MobileRateTiersProps {
  studioName: string;
  tiers: RateTier[];
  onUpdateTier: (studioName: string, index: number, field: keyof RateTier, raw: string) => void;
  onRemoveTier: (studioName: string, index: number) => void;
}

function mobileTierInputClass(hasError: boolean, isLocked = false): string {
  return `min-h-12 w-full min-w-0 rounded border px-2 py-2 text-base ${
    hasError ? 'border-red-400 bg-red-50' : 'border-gray-200'
  } ${isLocked ? 'cursor-not-allowed bg-gray-100 text-gray-500' : ''}`;
}

export function MobileRateTiers({
  studioName,
  tiers,
  onUpdateTier,
  onRemoveTier,
}: MobileRateTiersProps) {
  const validation = getRateTierValidation(tiers);

  return (
    <div data-testid="mobile-rate-tiers" className="flex min-w-0 flex-col gap-3">
      {tiers.map((tier, index) => {
        const errors = validation.tierErrors[index] ?? {};
        const isFirst = index === 0;
        const isLast = index === tiers.length - 1;
        return (
          <div
            key={index}
            className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 rounded-md bg-gray-50 p-3"
          >
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-gray-500">Min students</span>
              <input
                aria-label={`Tier ${index + 1} minimum students`}
                type="number"
                min={1}
                className={mobileTierInputClass(Boolean(errors.minStudents), isFirst)}
                title={errors.minStudents}
                value={isFirst ? 1 : Number.isNaN(tier.minStudents) ? '' : tier.minStudents}
                disabled={isFirst}
                onChange={(event) =>
                  onUpdateTier(studioName, index, 'minStudents', event.target.value)
                }
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-gray-500">Max students</span>
              <input
                aria-label={`Tier ${index + 1} maximum students`}
                type="number"
                placeholder="∞"
                className={mobileTierInputClass(Boolean(errors.maxStudents), isLast)}
                title={errors.maxStudents}
                value={
                  isLast
                    ? ''
                    : tier.maxStudents === null || Number.isNaN(tier.maxStudents)
                      ? ''
                      : tier.maxStudents
                }
                disabled={isLast}
                onChange={(event) =>
                  onUpdateTier(studioName, index, 'maxStudents', event.target.value)
                }
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-gray-500">Rate (€)</span>
              <input
                aria-label={`Tier ${index + 1} rate`}
                type="number"
                min={0}
                className={mobileTierInputClass(Boolean(errors.rate))}
                title={errors.rate}
                value={Number.isNaN(tier.rate) ? '' : tier.rate}
                onChange={(event) => onUpdateTier(studioName, index, 'rate', event.target.value)}
              />
            </label>
            <button
              type="button"
              aria-label={`Remove tier ${index + 1}`}
              onClick={() => onRemoveTier(studioName, index)}
              disabled={tiers.length === 1}
              className="min-h-12 min-w-12 self-end justify-self-end rounded px-3 text-base text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400"
            >
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Shared card content; only sizing and overflow differ between presenters.
export function StudioCard({
  layout = 'desktop',
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
  const mobile = layout === 'mobile';
  const [draftName, setDraftName] = useState(studioName);
  const [isOpen, setIsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const tierValidation = getRateTierValidation(studio.rateTiers);

  function inputClass(hasError: boolean, isLocked = false): string {
    return `w-full border rounded px-1.5 ${mobile ? 'min-h-12 py-2 text-base' : 'py-0.5'} ${
      hasError ? 'border-red-400 bg-red-50' : 'border-gray-200'
    } ${isLocked ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`;
  }

  useEffect(() => {
    setDraftName(studioName);
  }, [studioName]);

  const effectiveColor = effectiveHex(studioName, studio.color);
  const panelId = `studio-settings-${studioName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;

  return (
    <div
      className={
        mobile ? 'min-w-0 rounded border border-gray-200' : 'rounded border border-gray-200'
      }
    >
      <div className={`flex items-center gap-2 px-4 ${mobile ? 'py-2' : 'py-3'}`}>
        <div className="relative flex-shrink-0">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            title="Change studio color"
            style={mobile ? undefined : { backgroundColor: effectiveColor }}
            className={
              mobile
                ? 'relative h-12 w-12 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500'
                : 'w-4 h-4 rounded-full border border-white shadow-sm hover:scale-110 transition-transform'
            }
          >
            {mobile && (
              <span
                aria-hidden="true"
                className="absolute inset-4 rounded-full border border-white shadow-sm"
                style={{ backgroundColor: effectiveColor }}
              />
            )}
          </button>
          {pickerOpen && (
            <ColorPickerPopup
              currentColor={effectiveColor}
              onColorChange={(hex) => onUpdateColor(studioName, hex)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => setIsOpen((open) => !open)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
            mobile ? 'min-h-12 text-base' : 'text-sm'
          }`}
        >
          <span aria-hidden="true" className="w-3 text-xs text-gray-400">
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{draftName}</span>
        </button>
        <button
          type="button"
          aria-label={`Delete ${studioName}`}
          onClick={(event) => {
            onDelete(studioName);
          }}
          className={
            mobile
              ? 'min-h-12 px-2 text-sm text-red-500'
              : 'text-xs text-red-400 hover:text-red-600'
          }
        >
          Delete
        </button>
      </div>

      {isOpen && (
        <div
          id={panelId}
          className="px-4 pb-4 flex min-w-0 flex-col gap-3 border-t border-gray-100"
        >
          <div className="flex items-center gap-2 pt-3">
            <input
              aria-label="Studio name"
              className={`flex-1 border border-gray-200 rounded px-2 font-medium ${
                mobile ? 'min-h-12 py-2 text-base' : 'py-1 text-sm'
              }`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => {
                if (draftName !== studioName) onRename(studioName, draftName);
              }}
              onClick={(event) => event.stopPropagation()}
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Full name (for invoice)</span>
            <input
              className={`border border-gray-200 rounded px-2 ${mobile ? 'min-h-12 py-2 text-base' : 'py-1 text-sm'}`}
              value={studio.fullName}
              onChange={(event) => onUpdateField(studioName, 'fullName', event.target.value)}
              placeholder="e.g. Yogibar Yoga Studio GmbH"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Address</span>
            <textarea
              className={`border border-gray-200 rounded px-2 resize-none ${mobile ? 'py-2 text-base' : 'py-1 text-sm'}`}
              rows={2}
              value={studio.address}
              onChange={(event) => onUpdateField(studioName, 'address', event.target.value)}
              placeholder="Street, City"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Invoice e-mail</span>
            <input
              type="email"
              className={`border rounded px-2 ${mobile ? 'min-h-12 py-2 text-base' : 'py-1 text-sm'} ${
                emailError ? 'border-red-400' : 'border-gray-200'
              }`}
              value={studio.invoiceEmail ?? ''}
              onChange={(event) => {
                setEmailError(null);
                onUpdateField(studioName, 'invoiceEmail', event.target.value);
              }}
              onBlur={(event) => {
                const value = event.target.value;
                setEmailError(
                  value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                    ? 'Please enter a valid e-mail address'
                    : null
                );
              }}
              placeholder="studio@example.com"
            />
            {emailError && <span className="text-xs text-red-500">{emailError}</span>}
          </label>

          {mobile ? (
            <MobileRateTiers
              studioName={studioName}
              tiers={studio.rateTiers}
              onUpdateTier={onUpdateTier}
              onRemoveTier={onRemoveTier}
            />
          ) : (
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
                {studio.rateTiers.map((tier, index) => {
                  const errors = tierValidation.tierErrors[index] ?? {};
                  const isFirst = index === 0;
                  const isLast = index === studio.rateTiers.length - 1;
                  return (
                    <tr key={index}>
                      <td className="pr-2 py-0.5">
                        <input
                          aria-label={`Tier ${index + 1} minimum students`}
                          type="number"
                          min={1}
                          className={inputClass(Boolean(errors.minStudents), isFirst)}
                          title={errors.minStudents}
                          value={
                            isFirst ? 1 : Number.isNaN(tier.minStudents) ? '' : tier.minStudents
                          }
                          disabled={isFirst}
                          onChange={(event) =>
                            onUpdateTier(studioName, index, 'minStudents', event.target.value)
                          }
                        />
                      </td>
                      <td className="pr-2 py-0.5">
                        <input
                          aria-label={`Tier ${index + 1} maximum students`}
                          type="number"
                          placeholder="∞"
                          className={inputClass(Boolean(errors.maxStudents), isLast)}
                          title={errors.maxStudents}
                          value={
                            isLast
                              ? ''
                              : tier.maxStudents === null || Number.isNaN(tier.maxStudents)
                                ? ''
                                : tier.maxStudents
                          }
                          disabled={isLast}
                          onChange={(event) =>
                            onUpdateTier(studioName, index, 'maxStudents', event.target.value)
                          }
                        />
                      </td>
                      <td className="pr-2 py-0.5">
                        <input
                          aria-label={`Tier ${index + 1} rate`}
                          type="number"
                          min={0}
                          className={inputClass(Boolean(errors.rate))}
                          title={errors.rate}
                          value={Number.isNaN(tier.rate) ? '' : tier.rate}
                          onChange={(event) =>
                            onUpdateTier(studioName, index, 'rate', event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Remove tier ${index + 1}`}
                          onClick={() => onRemoveTier(studioName, index)}
                          disabled={studio.rateTiers.length === 1}
                          className="text-gray-300 hover:text-red-400 disabled:opacity-30 disabled:hover:text-gray-300"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!tierValidation.isValid && (
            <div className="text-xs text-red-500">
              Rate tiers must start at 1, touch without gaps, and end with no maximum.
            </div>
          )}
          <button
            type="button"
            onClick={() => onAddTier(studioName)}
            className={
              mobile
                ? 'min-h-12 self-start px-2 text-sm text-indigo-600'
                : 'text-xs text-indigo-500 hover:text-indigo-700 self-start'
            }
          >
            + Add tier
          </button>
        </div>
      )}
    </div>
  );
}

export interface MobileSettingsProps {
  config: AppConfig;
  isDirty: boolean;
  saveError: string | null;
  connections: ReactNode;
  onSave: () => void | Promise<void>;
  onUpdateTeacher: (field: keyof Omit<TeacherInfo, 'bankDetails'>, value: string) => void;
  onUpdateBank: (field: keyof BankDetails, value: string) => void;
  onRenameStudio: (oldName: string, newName: string) => void;
  onDeleteStudio: (name: string) => void;
  onUpdateTier: (studioName: string, index: number, field: keyof RateTier, raw: string) => void;
  onAddTier: (studioName: string) => void;
  onRemoveTier: (studioName: string, index: number) => void;
  onUpdateStudioField: (
    studioName: string,
    field: 'fullName' | 'address' | 'invoiceEmail',
    value: string
  ) => void;
  onUpdateStudioColor: (studioName: string, hex: string) => void;
  onAddStudio: () => void;
}

const fieldClass = 'min-h-12 rounded border border-gray-200 px-3 py-2 text-base';

export function MobileSettings({
  config,
  isDirty,
  saveError,
  connections,
  onSave,
  onUpdateTeacher,
  onUpdateBank,
  onRenameStudio,
  onDeleteStudio,
  onUpdateTier,
  onAddTier,
  onRemoveTier,
  onUpdateStudioField,
  onUpdateStudioColor,
  onAddStudio,
}: MobileSettingsProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 pb-6">
      <div
        data-testid="mobile-settings-save-bar"
        className="sticky top-0 z-20 -mx-4 flex min-h-16 items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur"
      >
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
          {saveError ? (
            <p className="truncate text-sm text-red-600" title={saveError}>
              Save failed
            </p>
          ) : isDirty ? (
            <p className="text-sm text-amber-600">Unsaved changes</p>
          ) : (
            <p className="text-sm text-gray-500">Saved</p>
          )}
        </div>
        <button
          type="button"
          aria-label="Save settings"
          onClick={() => void onSave()}
          disabled={!isDirty}
          className="min-h-12 flex-shrink-0 rounded bg-indigo-600 px-5 text-base font-medium text-white disabled:opacity-40"
        >
          Save
        </button>
      </div>

      {connections}

      <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-gray-200 p-4">
        <h3 className="font-medium text-gray-800">Teacher</h3>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          Name
          <input
            className={fieldClass}
            value={config.teacher.name}
            onChange={(event) => onUpdateTeacher('name', event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          Address
          <textarea
            className={`${fieldClass} resize-none`}
            rows={3}
            value={config.teacher.address}
            onChange={(event) => onUpdateTeacher('address', event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          Tax number
          <input
            className={fieldClass}
            value={config.teacher.taxNumber}
            onChange={(event) => onUpdateTeacher('taxNumber', event.target.value)}
          />
        </label>
      </section>

      <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-gray-200 p-4">
        <h3 className="font-medium text-gray-800">Bank details</h3>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          Account owner
          <input
            className={fieldClass}
            value={config.teacher.bankDetails.accountOwner}
            onChange={(event) => onUpdateBank('accountOwner', event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          IBAN
          <input
            className={`${fieldClass} font-mono tracking-wide`}
            value={config.teacher.bankDetails.iban}
            onChange={(event) => onUpdateBank('iban', event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-600">
          BIC
          <input
            className={`${fieldClass} font-mono`}
            value={config.teacher.bankDetails.bic}
            onChange={(event) => onUpdateBank('bic', event.target.value)}
          />
        </label>
      </section>

      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="font-medium text-gray-800">Studios and rates</h3>
        {Object.entries(config.studios).map(([studioName, studio], index) => (
          <StudioCard
            layout="mobile"
            key={index}
            studioName={studioName}
            studio={studio}
            onRename={onRenameStudio}
            onDelete={onDeleteStudio}
            onUpdateTier={onUpdateTier}
            onAddTier={onAddTier}
            onRemoveTier={onRemoveTier}
            onUpdateField={onUpdateStudioField}
            onUpdateColor={onUpdateStudioColor}
          />
        ))}
        <button
          type="button"
          onClick={onAddStudio}
          className="min-h-12 rounded border border-dashed border-gray-300 px-4 text-base text-gray-600"
        >
          + Add studio
        </button>
      </section>

      <div className="flex justify-end pt-2">
        <VersionBadge />
      </div>
    </div>
  );
}
