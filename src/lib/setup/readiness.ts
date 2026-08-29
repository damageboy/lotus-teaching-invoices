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
}

export interface SetupReadiness {
  status: SetupReadinessStatus;
  calendarConfigured: boolean;
  driveConfigured: boolean;
  firstIncompleteStep: SetupStep | null;
}

export function deriveSetupReadiness(input: SetupReadinessInput): SetupReadiness {
  const driveConfigured = input.hasDrive && input.driveSnapshot !== null;
  const calendarStatus =
    input.calendarStatus ?? (input.calendarId?.trim() ? 'accessible' : 'missing');
  const calendarConfigured = driveConfigured && calendarStatus === 'accessible';
  const firstIncompleteStep = !driveConfigured ? 'drive' : !calendarConfigured ? 'calendar' : null;

  if (
    input.configLoading ||
    input.authorizationLoading ||
    (input.hasDrive && input.driveSnapshot === null && input.driveStatus === 'loading') ||
    (driveConfigured && (calendarStatus === 'unchecked' || calendarStatus === 'checking'))
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
