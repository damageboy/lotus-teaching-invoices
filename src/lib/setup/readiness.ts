import type { DriveInvoicesStatus } from '../../hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../drive/invoiceStore.js';

export type SetupStep = 'calendar' | 'drive';
export type SetupReadinessStatus = 'checking' | 'incomplete' | 'ready' | 'unavailable';

export interface SetupReadinessInput {
  configLoading: boolean;
  calendarId?: string;
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
  const calendarConfigured = Boolean(input.calendarId?.trim());
  const driveConfigured = input.hasDrive && input.driveSnapshot !== null;
  const firstIncompleteStep = !calendarConfigured ? 'calendar' : !driveConfigured ? 'drive' : null;

  if (
    input.configLoading ||
    input.authorizationLoading ||
    (input.hasDrive && input.driveSnapshot === null && input.driveStatus === 'loading')
  ) {
    return { status: 'checking', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  if (calendarConfigured && driveConfigured) {
    return { status: 'ready', calendarConfigured, driveConfigured, firstIncompleteStep: null };
  }
  if (
    input.hasDrive &&
    input.driveSnapshot === null &&
    (input.driveStatus === 'offline' || input.driveStatus === 'blocked')
  ) {
    return { status: 'unavailable', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  return { status: 'incomplete', calendarConfigured, driveConfigured, firstIncompleteStep };
}
