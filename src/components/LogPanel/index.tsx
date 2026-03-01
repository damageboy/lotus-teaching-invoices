import { useState, useEffect, useRef } from 'react';
import { subscribeLog, clearLog, LogEntry, LogLevel } from '../../lib/logger';

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

export function LogPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLog(setEntries), []);

  // Auto-scroll when new entries arrive and panel is open
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [open, entries.length]);

  const errorCount = entries.filter((e) => e.level === 'error').length;
  const warnCount = entries.filter((e) => e.level === 'warn').length;
  const last = entries[entries.length - 1];

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
