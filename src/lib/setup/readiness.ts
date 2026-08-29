import type { DriveInvoicesStatus } from '../../hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../drive/invoiceStore.js';

export type CalendarConnectionStatus =
  | 'unchecked'
  | 'checking'
  | 'accessible'
  | 'missing'
  | 'unavailable';

export type SetupStep = 'calendar' | 'drive';
export type SetupReadinessStatus = 'checking' | 'incomplete' | 'ready' | 'unavailable';

export interface SetupReadinessInput {
  configLoading: boolean;
  calendarId?: string;
  calendarStatus?: CalendarConnectionStatus;
  authorizationLoading: boolean;
  hasDrive: boolean;
  driveStatus: DriveInvoicesStatus;
  driveSnapshot: DriveStoreSnapshot | null;
  driveStaged?: boolean;
}

export interface SetupReadiness {
  status: SetupReadinessStatus;
  calendarConfigured: boolean;
  driveConfigured: boolean;
  firstIncompleteStep: SetupStep | null;
}

export function deriveSetupReadiness(input: SetupReadinessInput): SetupReadiness {
  const driveConfigured = input.hasDrive && input.driveSnapshot !== null;
  const driveResolvedForSetup = driveConfigured || input.driveStaged === true;
  const calendarStatus =
    input.calendarStatus ?? (input.calendarId?.trim() ? 'accessible' : 'missing');
  const calendarConfigured = driveConfigured && calendarStatus === 'accessible';
  const firstIncompleteStep = !driveResolvedForSetup
    ? 'drive'
    : !calendarConfigured
      ? 'calendar'
      : null;

  if (
    input.configLoading ||
    input.authorizationLoading ||
    (input.hasDrive && input.driveSnapshot === null && input.driveStatus === 'loading') ||
    (driveResolvedForSetup &&
      (calendarStatus === 'unchecked' ||
        calendarStatus === 'checking' ||
        (input.driveStaged === true && calendarStatus === 'accessible')))
  ) {
    return { status: 'checking', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  if (calendarConfigured && driveConfigured) {
    return { status: 'ready', calendarConfigured, driveConfigured, firstIncompleteStep: null };
  }
  if (
    (input.hasDrive &&
      input.driveSnapshot === null &&
      (input.driveStatus === 'offline' || input.driveStatus === 'blocked')) ||
    (driveConfigured && calendarStatus === 'unavailable')
  ) {
    return { status: 'unavailable', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  return { status: 'incomplete', calendarConfigured, driveConfigured, firstIncompleteStep };
}
