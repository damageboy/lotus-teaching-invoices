import { CalendarBlank, GoogleDriveLogo } from '@phosphor-icons/react';
import type { AppLayout } from '../../hooks/useCompactLayout.js';
import type { CalendarPickerController } from '../../hooks/useCalendarPicker.js';
import type { DriveFolderController } from '../../hooks/useDriveFolderController.js';
import type { DriveInvoicesState } from '../../hooks/useDriveInvoices.js';

export interface ConnectionsSectionProps {
  layout: AppLayout;
  calendarConfigured: boolean;
  calendarPicker: CalendarPickerController;
  drive: Pick<DriveInvoicesState, 'status' | 'snapshot' | 'error' | 'operationKey'>;
  driveFolder: DriveFolderController;
}

export function ConnectionsSection({
  layout,
  calendarConfigured,
  calendarPicker,
  drive,
  driveFolder,
}: ConnectionsSectionProps) {
  const calendarBusy = calendarPicker.loading || calendarPicker.saving;
  const driveBusy =
    driveFolder.opening || drive.operationKey !== null || drive.status === 'loading';
  const calendarAction = calendarConfigured ? 'Change…' : 'Pick calendar…';
  const driveAction = drive.snapshot === null ? 'Pick Drive folder…' : 'Change…';
  const driveError = driveFolder.error ?? drive.error?.message ?? null;
  const rootName = drive.snapshot?.stagedRoot.root.folderName ?? 'Not configured';
  const touchClass = layout === 'mobile' ? 'min-h-12 text-base' : 'text-sm';

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-gray-200 p-4">
      <h3 className="font-medium text-gray-800">Connections</h3>

      <div className="flex min-w-0 flex-col gap-2 border-b border-gray-100 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <CalendarBlank size={24} aria-hidden="true" className="shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-gray-800">Google Calendar</p>
            <p className="truncate text-sm text-gray-600">
              {calendarConfigured ? calendarPicker.selectedName : 'Not configured'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void calendarPicker.openList()}
            disabled={calendarBusy}
            className={`shrink-0 rounded border border-gray-300 px-3 text-indigo-600 disabled:opacity-40 ${touchClass}`}
          >
            {calendarAction}
          </button>
        </div>
        {calendarPicker.error && <p className="text-sm text-red-600">{calendarPicker.error}</p>}
        {calendarPicker.listOpen && calendarPicker.calendars && (
          <div className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2">
            {calendarPicker.calendars.map((calendar) => (
              <button
                type="button"
                key={calendar.id}
                onClick={() => void calendarPicker.select(calendar)}
                disabled={calendarPicker.saving}
                className={`rounded px-3 text-left text-gray-700 hover:bg-indigo-50 disabled:opacity-40 ${
                  layout === 'mobile' ? 'min-h-12 text-base' : 'py-2 text-sm'
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
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <GoogleDriveLogo size={24} aria-hidden="true" className="shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-gray-800">Google Drive</p>
            <p className="truncate text-sm text-gray-600">{rootName}</p>
          </div>
          <button
            type="button"
            onClick={() => void driveFolder.openDialog()}
            disabled={driveBusy}
            className={`shrink-0 rounded border border-gray-300 px-3 text-indigo-600 disabled:opacity-40 ${touchClass}`}
          >
            {driveAction}
          </button>
        </div>
        {driveError && <p className="text-sm text-red-600">{driveError}</p>}
        {driveError && (
          <button
            type="button"
            onClick={() => void driveFolder.retry()}
            disabled={driveBusy}
            className={`self-start px-1 font-medium text-indigo-600 disabled:opacity-40 ${touchClass}`}
          >
            Retry Google Drive
          </button>
        )}
      </div>
    </section>
  );
}
