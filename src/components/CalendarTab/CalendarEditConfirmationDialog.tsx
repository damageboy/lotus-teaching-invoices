import type { SeriesStudioEditPreflight } from '../../lib/calendar/calendar-update';
import { ModalDialog } from './ModalDialog';

interface Props {
  preflight: SeriesStudioEditPreflight;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function CalendarEditConfirmationDialog({ preflight, saving, onClose, onConfirm }: Props) {
  const changing = preflight.instanceCount - preflight.titleExceptionCount;
  return (
    <ModalDialog title="Update entire series?" onClose={onClose}>
      <p className="mt-3 text-sm text-gray-700">
        Google Calendar will update {changing} of {preflight.instanceCount} loaded lessons.
      </p>
      {preflight.titleExceptionCount > 0 && (
        <p className="mt-2 text-sm text-amber-700">
          {preflight.titleExceptionCount} custom title{' '}
          {preflight.titleExceptionCount === 1 ? 'exception keeps' : 'exceptions keep'} its current
          studio.
        </p>
      )}
      <p className="mt-3 text-xs text-gray-500">
        {preflight.currentSummary} → {preflight.proposedSummary}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 max-md:min-h-12 max-md:text-base"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onConfirm}
          className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-45 max-md:min-h-12 max-md:text-base"
        >
          {saving ? 'Updating…' : 'Update entire series'}
        </button>
      </div>
    </ModalDialog>
  );
}
