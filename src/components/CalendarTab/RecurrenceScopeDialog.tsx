import { ModalDialog } from './ModalDialog';

interface Props {
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onThisEvent: () => void;
  onEntireSeries: () => void;
}

export function RecurrenceScopeDialog({
  returnFocus,
  onClose,
  onThisEvent,
  onEntireSeries,
}: Props) {
  return (
    <ModalDialog title="Reassign recurring lesson" onClose={onClose} returnFocus={returnFocus}>
      <p className="mt-3 text-sm text-gray-700">Which lessons should move to the new studio?</p>
      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={onThisEvent}
          className="rounded-md border border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 max-md:min-h-12 max-md:text-base"
        >
          This event
        </button>
        <button
          type="button"
          onClick={onEntireSeries}
          className="rounded-md bg-indigo-600 px-3 py-2 text-left text-sm font-medium text-white hover:bg-indigo-700 max-md:min-h-12 max-md:text-base"
        >
          Entire series
        </button>
      </div>
    </ModalDialog>
  );
}
