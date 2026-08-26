import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { AppConfig } from '../../src/lib/types.js';
import type { CalendarPickerController } from '../../src/hooks/useCalendarPicker.js';
import type { DriveFolderController } from '../../src/hooks/useDriveFolderController.js';
import type { DriveInvoicesState } from '../../src/hooks/useDriveInvoices.js';

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;
(globalThis as unknown as { React: typeof React }).React = React;

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { RatesTab } = await import('../../src/components/RatesTab/index.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {},
};

const drive: Pick<DriveInvoicesState, 'status' | 'snapshot' | 'error' | 'operationKey'> = {
  status: 'unconfigured',
  snapshot: null,
  error: null,
  operationKey: null,
};

const driveFolder: DriveFolderController = {
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
};

afterEach(() => cleanup());

describe('RatesTab calendar picker controller', () => {
  it('opens the shared picker controller from an explicit Pick calendar tap', async () => {
    const openList = vi.fn(async () => undefined);
    const calendarPicker: CalendarPickerController = {
      calendars: null,
      listOpen: false,
      loading: false,
      saving: false,
      error: null,
      selectedName: 'Selected calendar',
      openList,
      select: vi.fn(async () => undefined),
      closeList: vi.fn(),
    };
    const view = render(
      <RatesTab
        layout="mobile"
        config={config}
        calendarPicker={calendarPicker}
        drive={drive}
        driveFolder={driveFolder}
        isDirty={false}
        saveError={null}
        onUpdate={vi.fn()}
        onSave={vi.fn(async () => undefined)}
      />
    );

    expect(view.container.innerHTML.indexOf('Connections')).toBeLessThan(
      view.container.innerHTML.indexOf('Teacher')
    );

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Pick calendar…' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(openList).toHaveBeenCalledOnce());
  });
});
