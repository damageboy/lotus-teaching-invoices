import { CalendarBlank, Check, GoogleDriveLogo } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef } from 'react';
import type { AppLayout } from '../../hooks/useCompactLayout.js';
import type { CalendarPickerController } from '../../hooks/useCalendarPicker.js';
import type { DriveFolderController } from '../../hooks/useDriveFolderController.js';
import type { DriveInvoicesState } from '../../hooks/useDriveInvoices.js';
import type { SetupStep } from '../../lib/setup/readiness.js';

export interface SetupWizardProps {
  open: boolean;
  layout: AppLayout;
  step: SetupStep;
  calendarPicker: CalendarPickerController;
  drive: Pick<DriveInvoicesState, 'status' | 'error'>;
  driveFolder: DriveFolderController;
  onDismiss(): void;
}

interface MobileHistoryEntry {
  id: number;
  closing: boolean;
  consumed: boolean;
}

const TITLE_ID = 'setup-wizard-title';
const DESCRIPTION_ID = 'setup-wizard-description';
let mobileHistorySequence = 0;

function mobileHistoryState(currentState: unknown, id: number): Record<string, unknown> {
  const foreignState =
    typeof currentState === 'object' && currentState !== null && !Array.isArray(currentState)
      ? currentState
      : {};
  return { ...foreignState, lotusSetupWizard: id };
}

function ownsCurrentHistoryEntry(entry: MobileHistoryEntry): boolean {
  return window.history.state?.lotusSetupWizard === entry.id;
}

interface ProgressStepProps {
  id: SetupStep;
  activeStep: SetupStep;
  label: string;
}

function ProgressStep({ id, activeStep, label }: ProgressStepProps) {
  const active = id === activeStep;
  const complete = id === 'calendar' && activeStep === 'drive';
  const pending = id === 'drive' && activeStep === 'calendar';
  const Icon = id === 'calendar' ? CalendarBlank : GoogleDriveLogo;

  return (
    <div
      data-testid={`setup-step-${id}`}
      className={`relative flex w-28 flex-col items-center gap-2 rounded-lg border-2 px-2 py-3 transition motion-reduce:transition-none ${
        active
          ? 'border-transparent ring-2 ring-indigo-600'
          : pending
            ? 'border-dashed border-gray-400'
            : 'border-solid border-emerald-500'
      }`}
    >
      <span className="relative flex h-9 w-9 items-center justify-center">
        <Icon size={32} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
        {complete && (
          <span
            aria-label="Calendar complete"
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white"
          >
            <Check size={14} weight="bold" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className={`text-sm font-medium ${active ? 'text-indigo-700' : 'text-gray-600'}`}>
        {label}
      </span>
    </div>
  );
}

export function SetupWizard({
  open,
  layout,
  step,
  calendarPicker,
  drive,
  driveFolder,
  onDismiss,
}: SetupWizardProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const focusSessionActiveRef = useRef(false);
  const mobileHistoryRef = useRef<MobileHistoryEntry | null>(null);
  const currentRef = useRef({ calendarPicker, driveFolder, layout, onDismiss });
  currentRef.current = { calendarPicker, driveFolder, layout, onDismiss };

  const calendarBusy = calendarPicker.loading || calendarPicker.saving;
  const driveBusy = driveFolder.opening || driveFolder.cleanupPending || drive.status === 'loading';
  const driveError = driveFolder.error ?? drive.error?.message ?? null;
  const activeError = step === 'calendar' ? calendarPicker.error : driveError;
  const mobile = layout === 'mobile';

  const dismiss = useCallback((): void => {
    const current = currentRef.current;
    const historyEntry = mobileHistoryRef.current;
    if (
      current.layout === 'mobile' &&
      historyEntry !== null &&
      !historyEntry.consumed &&
      ownsCurrentHistoryEntry(historyEntry)
    ) {
      if (historyEntry.closing) return;
      historyEntry.closing = true;
      window.history.back();
      return;
    }
    if (historyEntry !== null) historyEntry.consumed = true;
    mobileHistoryRef.current = null;
    current.onDismiss();
  }, []);

  const focusFirstEnabledAction = useCallback((): void => {
    dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, []);

  const restorePreviousFocus = useCallback((): void => {
    if (!focusSessionActiveRef.current) return;
    const previousFocus = previousFocusRef.current;
    focusSessionActiveRef.current = false;
    previousFocusRef.current = null;
    previousFocus?.focus();
  }, []);

  useEffect(() => {
    if (open && !focusSessionActiveRef.current) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      focusSessionActiveRef.current = true;
      focusFirstEnabledAction();
      return;
    }
    if (!open && !driveFolder.dialogOpen) restorePreviousFocus();
  }, [driveFolder.dialogOpen, focusFirstEnabledAction, open, restorePreviousFocus]);

  useEffect(
    () => () => {
      if (!currentRef.current.driveFolder.dialogOpen) restorePreviousFocus();
    },
    [restorePreviousFocus]
  );

  useEffect(() => {
    if (!open || driveFolder.dialogOpen || calendarPicker.listOpen) return;
    focusFirstEnabledAction();
  }, [calendarPicker.listOpen, driveFolder.dialogOpen, focusFirstEnabledAction, open, step]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      const current = currentRef.current;
      if (current.driveFolder.dialogOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (current.calendarPicker.listOpen) {
          current.calendarPicker.closeList();
        } else {
          dismiss();
        }
        return;
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const controls = [
        ...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'),
      ];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dismiss, open]);

  useEffect(() => {
    if (!open || layout !== 'mobile') {
      const historyEntry = mobileHistoryRef.current;
      if (historyEntry !== null && driveFolder.dialogOpen) return;
      if (
        historyEntry !== null &&
        !historyEntry.consumed &&
        ownsCurrentHistoryEntry(historyEntry)
      ) {
        historyEntry.consumed = true;
        window.history.back();
      }
      mobileHistoryRef.current = null;
      return;
    }

    let historyEntry = mobileHistoryRef.current;
    if (historyEntry === null) {
      historyEntry = { id: ++mobileHistorySequence, closing: false, consumed: false };
      mobileHistoryRef.current = historyEntry;
      window.history.pushState(mobileHistoryState(window.history.state, historyEntry.id), '');
    }
    const activeHistoryEntry = historyEntry;

    function handlePopState(event: PopStateEvent): void {
      if (mobileHistoryRef.current !== activeHistoryEntry || activeHistoryEntry.consumed) return;
      const current = currentRef.current;
      if (current.driveFolder.dialogOpen) return;
      event.stopImmediatePropagation();

      if (current.calendarPicker.listOpen && !activeHistoryEntry.closing) {
        current.calendarPicker.closeList();
        window.history.pushState(
          mobileHistoryState(window.history.state, activeHistoryEntry.id),
          ''
        );
        return;
      }

      activeHistoryEntry.consumed = true;
      mobileHistoryRef.current = null;
      current.onDismiss();
    }

    window.addEventListener('popstate', handlePopState, true);
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [driveFolder.dialogOpen, layout, open]);

  if (!open) return null;

  const primaryAction = step === 'calendar' ? calendarPicker.openList : driveFolder.openDialog;
  const primaryBusy = step === 'calendar' ? calendarBusy : driveBusy;

  return (
    <div
      className={`fixed inset-0 z-40 flex bg-black/40 transition motion-reduce:transition-none ${
        mobile ? 'items-stretch p-0' : 'items-center justify-center p-6'
      }`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        className={`flex w-full flex-col overflow-y-auto bg-white shadow-2xl transition motion-reduce:transition-none ${
          mobile
            ? 'max-h-[100dvh] min-h-[100dvh] px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-[max(env(safe-area-inset-top),1rem)]'
            : 'max-h-[calc(100dvh-3rem)] max-w-2xl rounded-xl border border-gray-200 px-10 py-8'
        }`}
      >
        <div className="mx-auto w-full max-w-lg">
          <p className="text-center text-sm font-medium text-indigo-700">
            Step {step === 'calendar' ? '1' : '2'} of 2
          </p>
          <div className="mt-3 flex items-center justify-center" aria-label="Setup progress">
            <ProgressStep id="calendar" activeStep={step} label="Calendar" />
            <div aria-hidden="true" className="h-px w-16 bg-gray-300 sm:w-28" />
            <ProgressStep id="drive" activeStep={step} label="Drive" />
          </div>
        </div>

        <div className="mx-auto mt-7 flex w-full max-w-xl flex-1 flex-col border-t border-gray-200 pt-8 text-center">
          <h2 id={TITLE_ID} className="text-3xl font-bold tracking-tight text-gray-950">
            Welcome to Lotus
          </h2>
          <h3 className="mt-8 text-xl font-semibold text-gray-950">
            {step === 'calendar' ? 'Choose your teaching calendar' : 'Choose your invoice folder'}
          </h3>
          <p id={DESCRIPTION_ID} className="mt-4 text-base leading-7 text-gray-600">
            {step === 'calendar'
              ? 'Lotus uses this calendar to find lessons and prepare invoices.'
              : 'Lotus stores finalized invoices in this Google Drive folder.'}
          </p>

          <div className={`${mobile ? 'mt-auto pt-10' : 'mt-8'} flex flex-col gap-3`}>
            <button
              type="button"
              onClick={() => void primaryAction()}
              disabled={primaryBusy}
              className="min-h-12 min-w-12 w-full rounded-lg bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
            >
              {step === 'calendar' ? 'Pick calendar…' : 'Pick Drive folder…'}
            </button>

            {activeError && (
              <p role="alert" className="text-left text-sm text-red-600">
                {activeError}
              </p>
            )}

            {step === 'calendar' && calendarPicker.listOpen && calendarPicker.calendars && (
              <div className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2">
                {calendarPicker.calendars.map((calendar) => (
                  <button
                    type="button"
                    key={calendar.id}
                    onClick={() => void calendarPicker.select(calendar)}
                    disabled={calendarPicker.saving}
                    className={`rounded px-3 text-left text-gray-700 hover:bg-indigo-50 disabled:opacity-40 ${
                      mobile ? 'min-h-12 min-w-12 text-base' : 'py-2 text-sm'
                    }`}
                  >
                    {calendar.summary}
                  </button>
                ))}
                {calendarPicker.calendars.length === 0 && (
                  <span className="text-sm text-gray-500">No calendars found</span>
                )}
              </div>
            )}

            {step === 'drive' && driveError && (
              <button
                type="button"
                onClick={() => void driveFolder.retry().catch(() => undefined)}
                disabled={driveBusy}
                className="min-h-12 min-w-12 self-center px-3 text-base font-medium text-indigo-600 disabled:opacity-40"
              >
                Retry Google Drive
              </button>
            )}

            <button
              type="button"
              onClick={dismiss}
              className="min-h-12 min-w-12 self-center px-4 text-base font-medium text-indigo-700 hover:underline focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              Set up later
            </button>
          </div>

          <p className="mt-8 text-base text-gray-600">
            {step === 'calendar'
              ? 'Next: choose where finalized invoices are stored.'
              : 'You can change this later in Rates & Config.'}
          </p>
        </div>
      </div>
    </div>
  );
}
