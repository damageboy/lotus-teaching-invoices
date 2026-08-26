import { useCallback, useState, useEffect, useRef, type Ref } from 'react';
import { subscribeLog, clearLog, LogEntry, LogLevel } from '../../lib/logger';
import type { AppLayout } from '../../hooks/useCompactLayout';

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-400',
  warn: 'text-amber-300',
  info: 'text-gray-400',
  debug: 'text-gray-600',
};

const LEVEL_ROW: Record<LogLevel, string> = {
  error: 'text-red-300',
  warn: 'text-amber-200',
  info: 'text-gray-300',
  debug: 'text-gray-500',
};

interface Props {
  layout?: AppLayout;
}

interface MobileLogPanelProps {
  open: boolean;
  entries: LogEntry[];
  errorCount: number;
  warnCount: number;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  dialogRef?: Ref<HTMLDivElement>;
  bottomRef?: Ref<HTMLDivElement>;
}

function MobileLogPanel({
  open,
  entries,
  errorCount,
  warnCount,
  onOpen,
  onClose,
  onClear,
  buttonRef,
  dialogRef,
  bottomRef,
}: MobileLogPanelProps) {
  return (
    <div className="h-14 flex-shrink-0" aria-live="polite">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Open logs"
        onClick={onOpen}
        className="fixed right-3 bottom-[calc(3.25rem+max(env(safe-area-inset-bottom),1.5rem))] z-20 min-h-12 rounded-full border border-gray-200 bg-white px-4 text-sm text-gray-600 shadow-md"
      >
        Logs ({entries.length}){errorCount > 0 ? ` · ${errorCount} errors` : ''}
        {!errorCount && warnCount > 0 ? ` · ${warnCount} warnings` : ''}
      </button>

      {open && (
        <>
          <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-60 bg-black/40" />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Application logs"
            className="fixed inset-x-0 bottom-[var(--mobile-navigation-height)] z-70 flex max-h-[calc(100dvh-5.75rem)] flex-col rounded-t-2xl bg-gray-950 shadow-2xl"
          >
            <div className="flex min-h-14 items-center gap-2 border-b border-gray-800 px-4">
              <h2 className="min-w-0 flex-1 text-base font-semibold text-white">
                Application logs
              </h2>
              <button
                type="button"
                aria-label="Clear logs"
                onClick={onClear}
                disabled={entries.length === 0}
                className="min-h-12 px-3 text-sm text-gray-300 disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                aria-label="Close logs"
                onClick={onClose}
                className="min-h-12 px-3 text-sm font-medium text-white"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-xs">
              {entries.length === 0 ? (
                <span className="italic text-gray-500">No entries yet.</span>
              ) : (
                entries.map((entry) => (
                  <div key={entry.id} className="flex gap-2 items-baseline leading-5">
                    <span className="shrink-0 tabular-nums text-gray-600">
                      {entry.ts.toLocaleTimeString('en-GB', { hour12: false })}
                    </span>
                    <span
                      className={`w-10 shrink-0 text-[10px] font-bold uppercase ${LEVEL_COLOR[entry.level]}`}
                    >
                      {entry.level}
                    </span>
                    <span className={`break-words ${LEVEL_ROW[entry.level]}`}>{entry.msg}</span>
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function LogPanel({ layout = 'desktop' }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mobileButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDialogRef = useRef<HTMLDivElement>(null);
  const mobileHistoryEntryRef = useRef(false);

  useEffect(() => subscribeLog(setEntries), []);

  // Auto-scroll when new entries arrive and panel is open
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [open, entries.length]);

  const errorCount = entries.filter((e) => e.level === 'error').length;
  const warnCount = entries.filter((e) => e.level === 'warn').length;
  const last = entries[entries.length - 1];

  const closeMobileLogs = useCallback((fromHistory = false) => {
    setOpen(false);
    if (mobileHistoryEntryRef.current) {
      mobileHistoryEntryRef.current = false;
      if (!fromHistory) window.history.back();
    }
    queueMicrotask(() => mobileButtonRef.current?.focus());
  }, []);

  function openMobileLogs() {
    window.history.pushState({ lotusLogPanel: true }, '');
    mobileHistoryEntryRef.current = true;
    setOpen(true);
  }

  useEffect(() => {
    if (layout !== 'mobile' || !open) return;
    const dialog = mobileDialogRef.current;
    const initialButton = dialog?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    initialButton?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileLogs();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (buttons.length === 0) return;
      const first = buttons[0];
      const lastButton = buttons[buttons.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastButton : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        lastButton.focus();
      } else if (!event.shiftKey && document.activeElement === lastButton) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleBack() {
      closeMobileLogs(true);
    }

    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('popstate', handleBack);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('popstate', handleBack);
    };
  }, [closeMobileLogs, layout, open]);

  if (layout === 'mobile') {
    return (
      <MobileLogPanel
        open={open}
        entries={entries}
        errorCount={errorCount}
        warnCount={warnCount}
        onOpen={openMobileLogs}
        onClose={() => closeMobileLogs()}
        onClear={clearLog}
        buttonRef={mobileButtonRef}
        dialogRef={mobileDialogRef}
        bottomRef={bottomRef}
      />
    );
  }

  return (
    <div className="border-t border-gray-200 flex flex-col">
      {/* Expanded log list */}
      {open && (
        <div className="h-48 overflow-y-auto font-mono text-xs bg-gray-950 p-2 flex flex-col gap-px">
          {entries.length === 0 ? (
            <span className="text-gray-600 italic">No entries yet.</span>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="flex gap-2 items-baseline leading-5">
                <span className="text-gray-600 shrink-0 tabular-nums">
                  {e.ts.toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <span
                  className={`uppercase text-[10px] font-bold w-10 shrink-0 ${LEVEL_COLOR[e.level]}`}
                >
                  {e.level}
                </span>
                <span className={LEVEL_ROW[e.level]}>{e.msg}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Footer toggle bar */}
      <div className="flex items-center bg-gray-50 text-xs text-gray-500 h-7">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 px-3 h-full flex-1 hover:bg-gray-100 transition-colors text-left"
        >
          {errorCount > 0 && (
            <span className="bg-red-100 text-red-600 px-1.5 rounded font-semibold">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {warnCount > 0 && (
            <span className="bg-amber-100 text-amber-600 px-1.5 rounded font-semibold">
              {warnCount} {warnCount === 1 ? 'warn' : 'warns'}
            </span>
          )}
          {!errorCount && !warnCount && <span className="text-gray-400">Logs</span>}
          {last && <span className="flex-1 truncate text-gray-400">{last.msg}</span>}
          <span className="ml-auto pl-2">{open ? '▼' : '▲'}</span>
        </button>
        {entries.length > 0 && (
          <button
            onClick={clearLog}
            className="px-2 h-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors border-l border-gray-200"
            title="Clear logs"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
