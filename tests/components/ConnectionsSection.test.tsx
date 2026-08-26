import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { CalendarPickerController } from '../../src/hooks/useCalendarPicker.js';
import type { DriveFolderController } from '../../src/hooks/useDriveFolderController.js';
import type { DriveInvoicesState } from '../../src/hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import type { ConnectionsSectionProps } from '../../src/components/setup/ConnectionsSection.js';

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { ConnectionsSection } = await import('../../src/components/setup/ConnectionsSection.js');

afterEach(() => cleanup());

function calendarController(
  overrides: Partial<CalendarPickerController> = {}
): CalendarPickerController {
  return {
    calendars: null,
    listOpen: false,
    loading: false,
    saving: false,
    error: null,
    selectedName: 'Not configured',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
    ...overrides,
  };
}

function driveController(overrides: Partial<DriveFolderController> = {}): DriveFolderController {
  return {
    dialogOpen: false,
    opening: false,
    cleanupPending: false,
    error: null,
    openDialog: vi.fn(async () => undefined),
    closeDialog: vi.fn(),
    scanCandidate: vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    })),
    confirmRoot: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    ...overrides,
  };
}

function configuredSnapshot(folderName: string): DriveStoreSnapshot {
  return {
    stagedRoot: { root: { folderId: 'root-a', driveId: null, folderName } },
  } as DriveStoreSnapshot;
}

function driveState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'unconfigured' as const,
    snapshot: null,
    error: null,
    operationKey: null,
    ...overrides,
  };
}

function props(overrides: Partial<ConnectionsSectionProps> = {}): ConnectionsSectionProps {
  return {
    layout: 'desktop',
    calendarConfigured: false,
    calendarPicker: calendarController(),
    drive: driveState(),
    driveFolder: driveController(),
    ...overrides,
  };
}

describe('ConnectionsSection', () => {
  it.each(['desktop', 'mobile'] as const)('renders both Connections rows on %s', (layout) => {
    render(<ConnectionsSection {...props({ layout })} />);
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Connections')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('Google Calendar');
    expect(text).toContain('Google Drive');
    expect(text).toContain('Not configured');
    expect(screen.getByRole('button', { name: 'Pick calendar…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick Drive folder…' })).toBeTruthy();
  });

  it('shows configured names, Change actions, a Drive error, and Retry', () => {
    const onRetry = vi.fn();
    render(
      <ConnectionsSection
        {...props({
          calendarConfigured: true,
          calendarPicker: calendarController({ selectedName: 'Teaching' }),
          drive: driveState({ status: 'offline', snapshot: configuredSnapshot('Lotus invoices') }),
          driveFolder: driveController({
            error: 'Google Drive is temporarily unavailable',
            retry: onRetry,
          }),
        })}
      />
    );
    expect(document.body.textContent).toContain('Teaching');
    expect(document.body.textContent).toContain('Lotus invoices');
    expect(document.body.textContent).toContain('Google Drive is temporarily unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Google Drive' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
