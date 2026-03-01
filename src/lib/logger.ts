import {
  error as tauriError,
  warn as tauriWarn,
  info as tauriInfo,
  debug as tauriDebug,
} from '@tauri-apps/plugin-log';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  id: number;
  ts: Date;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;
let nextId = 0;
const entries: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

function push(level: LogLevel, msg: string) {
  entries.push({ id: nextId++, ts: new Date(), level, msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
  const snap = [...entries];
  listeners.forEach(fn => fn(snap));
}

/** Subscribe to log updates. Returns an unsubscribe function. */
export function subscribeLog(fn: (entries: LogEntry[]) => void): () => void {
  fn([...entries]);
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearLog() {
  entries.length = 0;
  nextId = 0;
  listeners.forEach(fn => fn([]));
}

async function forward(fn: (msg: string) => Promise<void>, msg: string) {
  try { await fn(msg); } catch { /* not in Tauri context */ }
}

export function logError(msg: string): void { push('error', msg); forward(tauriError, msg); }
export function logWarn(msg: string): void  { push('warn',  msg); forward(tauriWarn,  msg); }
export function logInfo(msg: string): void  { push('info',  msg); forward(tauriInfo,  msg); }
export function logDebug(msg: string): void { push('debug', msg); forward(tauriDebug, msg); }

/** Call once on startup to receive Rust-side logs (emitted via Webview target). */
export async function initRustLogListener(): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    // level numbers from the log crate: 1=Error 2=Warn 3=Info 4=Debug 5=Trace
    const levelMap: Record<number, LogLevel> = { 1: 'error', 2: 'warn', 3: 'info', 4: 'debug', 5: 'debug' };
    const unlisten = await listen<{ level: number; message: string }>('log://log', event => {
      const { level, message } = event.payload;
      push(levelMap[level] ?? 'info', `[rust] ${message}`);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}
