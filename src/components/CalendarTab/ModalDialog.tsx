import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}

export function ModalDialog({ title, children, onClose, returnFocus }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = returnFocus ?? (document.activeElement as HTMLElement | null);
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(
      'input:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex="-1"])'
    );
    first?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'input:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex="-1"])'
        ),
      ];
      if (focusable.length === 0) return;
      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
}
