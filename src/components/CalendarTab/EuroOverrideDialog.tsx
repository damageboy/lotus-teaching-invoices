import { useState } from 'react';
import { ModalDialog } from './ModalDialog';

interface Props {
  initialValue?: number;
  saving: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onSubmit: (euros: string) => Promise<void>;
  onUseConfiguredRate: () => Promise<void>;
}

const validEuros = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export function EuroOverrideDialog({
  initialValue,
  saving,
  returnFocus,
  onClose,
  onSubmit,
  onUseConfiguredRate,
}: Props) {
  const [value, setValue] = useState(initialValue === undefined ? '' : String(initialValue));
  const valid = validEuros.test(value);

  return (
    <ModalDialog title="Set euros" onClose={onClose} returnFocus={returnFocus}>
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !saving) void onSubmit(value);
        }}
      >
        <label className="block text-sm font-medium text-gray-700" htmlFor="lesson-euros">
          Euros per lesson
        </label>
        <input
          id="lesson-euros"
          autoFocus
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {!valid && value !== '' && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            Enter euros with at most two decimals.
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void onUseConfiguredRate()}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-45"
          >
            Use configured rate
          </button>
          <button
            type="submit"
            disabled={!valid || saving}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? 'Saving…' : 'Save euros'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
