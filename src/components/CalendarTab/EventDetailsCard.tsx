import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParsedClass, StudioConfig } from '../../lib/types';
import type {
  OccurrenceValueEditOperation,
  OccurrenceValueEditPreflight,
  SeriesStudioEditPreflight,
} from '../../lib/calendar/calendar-update';
import { CalendarEditConfirmationDialog } from './CalendarEditConfirmationDialog';
import { EuroOverrideDialog } from './EuroOverrideDialog';
import { ModalDialog } from './ModalDialog';
import { RecurrenceScopeDialog } from './RecurrenceScopeDialog';
import { StudentCountDialog } from './StudentCountDialog';

interface Props {
  lesson: ParsedClass;
  anchor: HTMLElement;
  presentation?: 'popover' | 'sheet';
  studios: Record<string, StudioConfig>;
  canEdit: boolean;
  onClose: () => void;
  onReassignStudio?: (lesson: ParsedClass, studioName: string) => Promise<void>;
  onPrepareValueEdit?: (
    lesson: ParsedClass,
    operation: OccurrenceValueEditOperation
  ) => Promise<OccurrenceValueEditPreflight>;
  onSaveValueEdit?: (
    preflight: OccurrenceValueEditPreflight,
    confirmUnsupportedReplacement: boolean
  ) => Promise<void>;
  onPrepareSeriesStudioEdit?: (
    lesson: ParsedClass,
    studioName: string
  ) => Promise<SeriesStudioEditPreflight>;
  onSaveSeriesStudioEdit?: (preflight: SeriesStudioEditPreflight) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

export function EventDetailsCard({
  lesson,
  anchor,
  presentation = 'popover',
  studios,
  canEdit,
  onClose,
  onReassignStudio,
  onPrepareValueEdit,
  onSaveValueEdit,
  onPrepareSeriesStudioEdit,
  onSaveSeriesStudioEdit,
}: Props) {
  const [studioMenuOpen, setStudioMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valueDialog, setValueDialog] = useState<'students' | 'euros' | null>(null);
  const [valueDialogReturnFocus, setValueDialogReturnFocus] = useState<HTMLElement | null>(null);
  const [pendingValueEdit, setPendingValueEdit] = useState<OccurrenceValueEditPreflight | null>(
    null
  );
  const [pendingSeriesStudio, setPendingSeriesStudio] = useState<string | null>(null);
  const [seriesPreflight, setSeriesPreflight] = useState<SeriesStudioEditPreflight | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const studioNames = useMemo(
    () =>
      Object.keys(studios)
        .filter((name) => name !== lesson.studioName)
        .sort(),
    [lesson.studioName, studios]
  );
  const placement =
    presentation === 'sheet'
      ? 'fixed inset-x-0 bottom-[var(--mobile-navigation-height)] z-40 max-h-[82dvh] overflow-y-auto rounded-t-3xl border-t border-gray-200 bg-white p-5 shadow-2xl'
      : 'fixed z-50 w-72 rounded-lg border border-gray-200 bg-white p-4 shadow-xl';
  const sheetControlClass = presentation === 'sheet' ? 'min-h-12 text-base' : '';
  const rect = presentation === 'popover' ? anchor.getBoundingClientRect() : null;
  const left = rect ? Math.max(12, Math.min(rect.right + 8, window.innerWidth - 308)) : undefined;
  const top = rect ? Math.max(12, Math.min(rect.top, window.innerHeight - 340)) : undefined;

  useEffect(() => {
    if (presentation === 'sheet') dialogRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (valueDialog || pendingValueEdit || pendingSeriesStudio || seriesPreflight) return;
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pendingSeriesStudio, pendingValueEdit, presentation, seriesPreflight, valueDialog]);

  async function selectStudio(studioName: string) {
    if (!canEdit || !onReassignStudio || saving) return;
    if (lesson.eventIdentity.recurringEventId) {
      setStudioMenuOpen(false);
      setPendingSeriesStudio(studioName);
      return;
    }
    await reassignOccurrence(studioName);
  }

  async function reassignOccurrence(studioName: string) {
    if (!canEdit || !onReassignStudio || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onReassignStudio(lesson, studioName);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
      setStudioMenuOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function prepareSeriesEdit() {
    if (!pendingSeriesStudio || !onPrepareSeriesStudioEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const preflight = await onPrepareSeriesStudioEdit(lesson, pendingSeriesStudio);
      setPendingSeriesStudio(null);
      setSeriesPreflight(preflight);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setPendingSeriesStudio(null);
    } finally {
      setSaving(false);
    }
  }

  async function confirmSeriesEdit() {
    if (!seriesPreflight || !onSaveSeriesStudioEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const reconciliationPending = await onSaveSeriesStudioEdit(seriesPreflight);
      if (reconciliationPending) {
        setError('Google Calendar was updated. Refresh the calendar to finish loading the series.');
        setSeriesPreflight(null);
      } else {
        onClose();
      }
    } catch (saveError) {
      setError(errorMessage(saveError));
      setSeriesPreflight(null);
    } finally {
      setSaving(false);
    }
  }

  async function prepareValueEdit(operation: OccurrenceValueEditOperation) {
    if (!canEdit || !onPrepareValueEdit || !onSaveValueEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const preflight = await onPrepareValueEdit(lesson, operation);
      if (preflight.requiresConfirmation) {
        setPendingValueEdit(preflight);
        setValueDialog(null);
        return;
      }
      await onSaveValueEdit(preflight, false);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
      setValueDialog(null);
    } finally {
      setSaving(false);
    }
  }

  async function confirmValueEdit() {
    if (!pendingValueEdit || !onSaveValueEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSaveValueEdit(pendingValueEdit, true);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
      setPendingValueEdit(null);
    } finally {
      setSaving(false);
    }
  }

  const validStudents =
    Number.isSafeInteger(lesson.studentCount) &&
    lesson.studentCount > 0 &&
    !lesson.ambiguousStudentCount;

  return createPortal(
    <>
      {presentation === 'sheet' && (
        <button
          type="button"
          aria-label="Dismiss lesson details"
          onClick={onClose}
          className="fixed inset-x-0 top-0 bottom-[var(--mobile-navigation-height)] z-30 bg-black/30"
        />
      )}
      <section
        ref={dialogRef}
        role="dialog"
        aria-label="Lesson details"
        data-presentation={presentation === 'sheet' ? 'sheet' : undefined}
        tabIndex={presentation === 'sheet' ? -1 : undefined}
        className={`${placement} focus:outline-none`}
        style={presentation === 'popover' ? { left, top } : undefined}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">{lesson.classType}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {lesson.date} · {lesson.startTime}–{lesson.endTime}
            </p>
            <p className="mt-2 text-sm text-gray-700">{lesson.studioName}</p>
          </div>
          <button
            type="button"
            aria-label="Close lesson details"
            onClick={onClose}
            className={`rounded px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${sheetControlClass}`}
          >
            Close
          </button>
        </div>

        <div className="relative mt-4">
          <button
            type="button"
            disabled={!canEdit || saving}
            onClick={() => setStudioMenuOpen((open) => !open)}
            className={`w-full rounded-md border border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 ${sheetControlClass}`}
          >
            {saving ? 'Saving…' : 'Fix Studio'}
          </button>
          {studioMenuOpen && (
            <div
              role="menu"
              aria-label="Configured studios"
              className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            >
              {studioNames.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-500">No other studios configured</p>
              ) : (
                studioNames.map((studioName) => (
                  <button
                    key={studioName}
                    type="button"
                    role="menuitem"
                    onClick={() => void selectStudio(studioName)}
                    className={`block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 focus:bg-indigo-50 focus:outline-none ${sheetControlClass}`}
                  >
                    {studioName}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!canEdit || saving}
            onClick={(event) => {
              setValueDialogReturnFocus(event.currentTarget);
              setValueDialog('students');
            }}
            className={`rounded-md border border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 ${sheetControlClass}`}
          >
            Set Students
          </button>
          <button
            type="button"
            disabled={!canEdit || saving || !validStudents}
            onClick={(event) => {
              setValueDialogReturnFocus(event.currentTarget);
              setValueDialog('euros');
            }}
            className={`rounded-md border border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 ${sheetControlClass}`}
          >
            Set Euros…
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Students: {validStudents ? lesson.studentCount : 'not set'} · Rate:{' '}
          {lesson.rateOverride === undefined ? 'configured' : `€${lesson.rateOverride}`}
        </p>

        {!canEdit && (
          <p className="mt-3 text-xs text-gray-500">Calendar editing is not available.</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        )}

        {valueDialog === 'students' && (
          <StudentCountDialog
            initialValue={validStudents ? lesson.studentCount : undefined}
            saving={saving}
            returnFocus={valueDialogReturnFocus}
            onClose={() => setValueDialog(null)}
            onSubmit={(students) =>
              prepareValueEdit({ operation: 'setStudents', studentCount: students })
            }
          />
        )}
        {valueDialog === 'euros' && validStudents && (
          <EuroOverrideDialog
            initialValue={lesson.rateOverride}
            saving={saving}
            returnFocus={valueDialogReturnFocus}
            onClose={() => setValueDialog(null)}
            onSubmit={(euros) =>
              prepareValueEdit({
                operation: 'setEuroOverride',
                studentCount: lesson.studentCount,
                euroOverride: euros,
              })
            }
            onUseConfiguredRate={() =>
              prepareValueEdit({
                operation: 'useConfiguredRate',
                studentCount: lesson.studentCount,
              })
            }
          />
        )}
        {pendingValueEdit && (
          <ModalDialog
            title="Replace calendar description?"
            onClose={() => setPendingValueEdit(null)}
          >
            <p className="mt-3 text-sm text-gray-700">
              The existing description is not in a supported lesson format. Replace it only for this
              lesson?
            </p>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="font-medium text-gray-500">Existing</dt>
                <dd className="break-words text-gray-800">
                  {pendingValueEdit.currentDescription || '(empty)'}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-gray-500">Replacement</dt>
                <dd className="break-words text-gray-800">
                  {pendingValueEdit.proposedDescription}
                </dd>
              </div>
            </dl>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingValueEdit(null)}
                className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 max-md:min-h-12 max-md:text-base"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void confirmValueEdit()}
                className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-45 max-md:min-h-12 max-md:text-base"
              >
                {saving ? 'Saving…' : 'Replace description'}
              </button>
            </div>
          </ModalDialog>
        )}
        {pendingSeriesStudio && (
          <RecurrenceScopeDialog
            onClose={() => setPendingSeriesStudio(null)}
            onThisEvent={() => {
              const studioName = pendingSeriesStudio;
              setPendingSeriesStudio(null);
              void reassignOccurrence(studioName);
            }}
            onEntireSeries={() => void prepareSeriesEdit()}
          />
        )}
        {seriesPreflight && (
          <CalendarEditConfirmationDialog
            preflight={seriesPreflight}
            saving={saving}
            onClose={() => setSeriesPreflight(null)}
            onConfirm={() => void confirmSeriesEdit()}
          />
        )}
      </section>
    </>,
    document.body
  );
}
