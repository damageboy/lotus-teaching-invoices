import { useState } from 'react';
import { ModalDialog } from './ModalDialog';

interface Props {
  initialValue?: number;
  saving: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onSubmit: (students: number) => Promise<void>;
}

export function StudentCountDialog({
  initialValue,
  saving,
  returnFocus,
  onClose,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initialValue ? String(initialValue) : '');
  const students = Number(value);
  const valid = Number.isSafeInteger(students) && students > 0;

  return (
    <ModalDialog title="Set students" onClose={onClose} returnFocus={returnFocus}>
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !saving) void onSubmit(students);
        }}
      >
        <label className="block text-sm font-medium text-gray-700" htmlFor="lesson-students">
          Students
        </label>
        <input
          id="lesson-students"
          autoFocus
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {!valid && value !== '' && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            Enter a positive whole number.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || saving}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? 'Saving…' : 'Save students'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
