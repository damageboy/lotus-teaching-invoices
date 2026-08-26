export type MobileCalendarHistoryLevel = 'agenda' | 'details';

export interface MobileCalendarHistoryEntry {
  ownerId: string;
  level: MobileCalendarHistoryLevel;
}

function createRuntimeNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const runtimeNonce = createRuntimeNonce();
let ownerCounter = 0;

export function createMobileCalendarOwnerId(): string {
  ownerCounter += 1;
  return `${runtimeNonce}-${ownerCounter}`;
}

export function calendarHistoryState(
  currentState: unknown,
  ownerId: string,
  level: MobileCalendarHistoryLevel
): Record<string, unknown> {
  const foreignState =
    typeof currentState === 'object' && currentState !== null && !Array.isArray(currentState)
      ? currentState
      : {};

  return {
    ...foreignState,
    lotusCalendar: { ownerId, level },
  };
}

export function calendarHistoryLevel(
  state: unknown,
  ownerId: string
): MobileCalendarHistoryLevel | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;

  const entry = (state as Record<string, unknown>).lotusCalendar;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;

  const { ownerId: entryOwnerId, level } = entry as Partial<MobileCalendarHistoryEntry>;
  if (entryOwnerId !== ownerId) return null;

  return level === 'agenda' || level === 'details' ? level : null;
}
