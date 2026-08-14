import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  reason: 'scopeMissing' | 'calendarReadOnly';
  isAuthorizing?: boolean;
  error?: string | null;
  onAllow: () => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
}

const TITLE_ID = 'calendar-permission-title';
const DESCRIPTION_ID = 'calendar-permission-description';

export function CalendarPermissionPrompt({
  open,
  reason,
  isAuthorizing = false,
  error = null,
  onAllow,
  onDismiss,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial =
      reason === 'scopeMissing' && !isAuthorizing ? primaryRef.current : closeRef.current;
    initial?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void onDismiss();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!dialog.contains(document.activeElement)) {
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
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isAuthorizing, onDismiss, open, reason]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl"
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 id={TITLE_ID} className="text-base font-semibold text-gray-900">
              Calendar editing
            </h2>
            <p id={DESCRIPTION_ID} className="mt-2 text-sm text-gray-600">
              {reason === 'scopeMissing'
                ? 'Lotus needs additional Google Calendar permission before it can change lessons.'
                : 'You only have read access to this calendar'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={() => void onDismiss()}
            className="rounded px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            ×
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          {reason === 'scopeMissing' && (
            <>
              <button
                type="button"
                onClick={() => void onDismiss()}
                disabled={isAuthorizing}
                className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40"
              >
                Not now
              </button>
              <button
                ref={primaryRef}
                type="button"
                onClick={() => void onAllow()}
                disabled={isAuthorizing}
                className="rounded bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {isAuthorizing ? 'Waiting for Google…' : 'Allow calendar editing to make changes'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
