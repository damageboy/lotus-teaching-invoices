import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupWizardProps } from '../../src/components/setup/SetupWizard.js';
import type { CalendarPickerController } from '../../src/hooks/useCalendarPicker.js';
import type { DriveFolderController } from '../../src/hooks/useDriveFolderController.js';
import { DriveStoreError } from '../../src/lib/drive/invoiceStore.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
afterAll(() => restoreDom());
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { SetupWizard } = await import('../../src/components/setup/SetupWizard.js');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '');
});

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
    connectionStatus: 'missing',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
    retryValidation: vi.fn(async () => undefined),
    ...overrides,
  };
}

function driveController(overrides: Partial<DriveFolderController> = {}): DriveFolderController {
  return {
    dialogOpen: false,
    opening: false,
    cleanupPending: false,
    error: null,
    pendingNewRoot: null,
    openDialog: vi.fn(async () => undefined),
    closeDialog: vi.fn(),
    scanCandidate: vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    })),
    confirmRoot: vi.fn(async () => undefined),
    completePendingNewRoot: vi.fn(async () => undefined),
    clearPendingNewRoot: vi.fn(),
    retry: vi.fn(async () => undefined),
    ...overrides,
  };
}

function props(overrides: Partial<SetupWizardProps> = {}): SetupWizardProps {
  return {
    open: true,
    layout: 'desktop',
    step: 'calendar',
    calendarPicker: calendarController(),
    drive: {
      status: 'unconfigured',
      error: null,
      operationKey: null,
      recovery: null,
      confirmRecoveryCandidate: vi.fn(async () => ({}) as never),
    },
    driveFolder: driveController(),
    driveAcknowledgementRequired: false,
    detectedDriveFolderName: null,
    onAcknowledgeDrive: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe('SetupWizard', () => {
  it('renders the approved Calendar step with icon and text progress', () => {
    render(<SetupWizard {...props({ layout: 'desktop', step: 'calendar' })} />);
    expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
    expect(screen.getByText('Choose your teaching calendar')).toBeTruthy();
    expect(
      screen.getByText('Lotus uses this calendar to find lessons and prepare invoices.')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick calendar…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up later' })).toBeTruthy();
    expect(screen.getByText('You can change this later in Rates & Config.')).toBeTruthy();
    expect(screen.getByTestId('setup-step-calendar').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('setup-step-drive').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('setup-step-calendar').className).toContain('ring-2');
    expect(screen.getByTestId('setup-step-drive').className).toContain('border-solid');
  });

  it('renders the approved Drive step and routes the primary action', () => {
    const openDialog = vi.fn();
    render(
      <SetupWizard {...props({ step: 'drive', driveFolder: driveController({ openDialog }) })} />
    );
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByText('Choose your invoice folder')).toBeTruthy();
    expect(
      screen.getByText('Lotus stores finalized invoices in this Google Drive folder.')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick Drive folder…' }));
    expect(openDialog).toHaveBeenCalledOnce();
    expect(screen.getByText('Next: choose your teaching calendar if needed.')).toBeTruthy();
    expect(screen.queryByLabelText('Drive complete')).toBeNull();
    expect(screen.getByTestId('setup-step-drive').className).toContain('ring-2');
  });

  it('names an automatically detected Drive folder and requires acknowledgement', () => {
    const acknowledgeDrive = vi.fn();
    const openDialog = vi.fn(async () => undefined);
    render(
      <SetupWizard
        {...props({
          step: 'drive',
          driveAcknowledgementRequired: true,
          detectedDriveFolderName: 'LotusInvoices',
          driveFolder: driveController({ openDialog }),
          onAcknowledgeDrive: acknowledgeDrive,
        })}
      />
    );

    expect(screen.getByText('Existing invoice folder found')).toBeTruthy();
    expect(screen.getByText('LotusInvoices')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with LotusInvoices' }));
    expect(acknowledgeDrive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Choose another folder…' }));
    expect(openDialog).toHaveBeenCalledOnce();
  });

  it('requires confirmation for one discovered configuration', () => {
    const confirmRecoveryCandidate = vi.fn(async () => ({}) as never);
    render(
      <SetupWizard
        {...props({
          step: 'drive',
          drive: {
            status: 'confirmationRequired',
            error: null,
            operationKey: null,
            recovery: {
              candidates: [
                {
                  fileId: 'config-1',
                  kind: 'configured',
                  root: { folderId: 'folder-1', driveId: null, folderName: 'LotusInvoices' },
                  rootFile: {} as never,
                  calendarName: 'Teaching',
                },
              ],
              issues: [],
              previousPointerRaw: null,
            },
            confirmRecoveryCandidate,
          },
        })}
      />
    );

    expect(screen.getByText('Found existing configuration in “LotusInvoices”')).toBeTruthy();
    expect(screen.getByText('Calendar: Teaching')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this configuration' }));
    expect(confirmRecoveryCandidate).toHaveBeenCalledWith('config-1');
  });

  it('shows every discovered configuration and another-folder action', () => {
    const recovery = {
      candidates: [
        {
          fileId: 'config-a',
          kind: 'configured' as const,
          root: { folderId: 'a', driveId: null, folderName: 'Alpha' },
          rootFile: {} as never,
          calendarName: 'Calendar A',
        },
        {
          fileId: 'config-b',
          kind: 'configured' as const,
          root: { folderId: 'b', driveId: null, folderName: 'Beta' },
          rootFile: {} as never,
          calendarName: 'Calendar B',
        },
      ],
      issues: [],
      previousPointerRaw: null,
    };
    render(
      <SetupWizard
        {...props({
          step: 'drive',
          drive: {
            status: 'confirmationRequired',
            error: null,
            operationKey: null,
            recovery,
            confirmRecoveryCandidate: vi.fn(async () => ({}) as never),
          },
        })}
      />
    );

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Calendar: Calendar A')).toBeTruthy();
    expect(screen.getByText('Calendar: Calendar B')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use this configuration' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Choose another folder…' })).toBeTruthy();
  });

  it('routes the Calendar action and renders the same selectable list states as Connections', () => {
    const openList = vi.fn();
    const select = vi.fn();
    const calendarPicker = calendarController({
      calendars: [{ id: 'teaching', summary: 'Teaching', accessRole: 'owner' }],
      listOpen: true,
      openList,
      select,
    });
    const view = render(<SetupWizard {...props({ calendarPicker })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pick calendar…' }));
    expect(openList).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Teaching' }));
    expect(select).toHaveBeenCalledWith(calendarPicker.calendars?.[0]);

    view.rerender(
      <SetupWizard
        {...props({ calendarPicker: calendarController({ calendars: [], listOpen: true }) })}
      />
    );
    expect(screen.getByText('No calendars found')).toBeTruthy();
  });

  it('shows controller errors beside the active action and disables busy primary actions', () => {
    const view = render(
      <SetupWizard
        {...props({
          calendarPicker: calendarController({ loading: true, error: 'Calendar unavailable' }),
        })}
      />
    );
    expect(screen.getByText('Calendar unavailable').parentElement).toBe(
      screen.getByRole('button', { name: 'Pick calendar…' }).parentElement
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Pick calendar…' }).disabled).toBe(
      true
    );

    view.rerender(
      <SetupWizard
        {...props({
          step: 'drive',
          drive: {
            status: 'offline',
            error: new DriveStoreError('offline', 'Drive unavailable', true),
            operationKey: null,
            recovery: null,
            confirmRecoveryCandidate: vi.fn(async () => ({}) as never),
          },
          driveFolder: driveController({ cleanupPending: true }),
        })}
      />
    );
    expect(screen.getByText('Drive unavailable').parentElement).toBe(
      screen.getByRole('button', { name: 'Pick Drive folder…' }).parentElement
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Pick Drive folder…' }).disabled
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retry Google Drive' }).disabled
    ).toBe(true);
  });

  it('routes Drive error recovery through the shared folder controller', () => {
    const retry = vi.fn(async () => undefined);
    render(
      <SetupWizard
        {...props({
          step: 'drive',
          driveFolder: driveController({ error: 'Drive discovery failed', retry }),
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry Google Drive' }));

    expect(retry).toHaveBeenCalledOnce();
  });

  it('contains an expected rejected Drive retry after the controller publishes its error', () => {
    const rejectedRetry = Promise.reject(new Error('Drive retry failed'));
    void rejectedRetry.catch(() => undefined);
    const catchRejection = vi.spyOn(rejectedRetry, 'catch');
    const retry = vi.fn(() => rejectedRetry);
    render(
      <SetupWizard
        {...props({
          step: 'drive',
          driveFolder: driveController({ error: 'Drive retry failed', retry }),
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry Google Drive' }));

    expect(catchRejection).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toBe('Drive retry failed');
  });

  it('contains focus and restores the opener when it closes', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open setup';
    document.body.append(opener);
    opener.focus();
    const wizardProps = props();
    const view = render(<SetupWizard {...wizardProps} />);

    const dialog = screen.getByRole('dialog', { name: 'Welcome to Lotus' });
    const primary = screen.getByRole('button', { name: 'Pick calendar…' });
    const secondary = screen.getByRole('button', { name: 'Set up later' });
    await waitFor(() => expect(document.activeElement).toBe(primary));
    expect(dialog.contains(document.activeElement)).toBe(true);

    const backwardTab = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document, backwardTab);
    expect(backwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(secondary);

    const forwardTab = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document, forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(primary);

    view.rerender(<SetupWizard {...wizardProps} open={false} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('defers opener focus restoration while a completing Drive dialog remains active', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open setup';
    document.body.append(opener);
    opener.focus();
    const baseProps = props({ step: 'drive' });
    const view = render(<SetupWizard {...baseProps} />);
    const driveAction = document.createElement('button');
    driveAction.textContent = 'Confirm Drive folder';
    document.body.append(driveAction);

    try {
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Pick Drive folder…' })
        )
      );
      driveAction.focus();
      view.rerender(
        <SetupWizard
          {...baseProps}
          open={false}
          driveFolder={driveController({ dialogOpen: true })}
        />
      );
      await act(async () => Promise.resolve());
      expect(document.activeElement).toBe(driveAction);

      view.rerender(
        <SetupWizard
          {...baseProps}
          open={false}
          driveFolder={driveController({ dialogOpen: false })}
        />
      );
      expect(document.activeElement).toBe(opener);
    } finally {
      driveAction.remove();
      opener.remove();
    }
  });

  it('focuses Set up later when the initial primary action is busy', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open setup';
    document.body.append(opener);
    opener.focus();

    try {
      render(<SetupWizard {...props({ calendarPicker: calendarController({ loading: true }) })} />);

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Set up later' }))
      );
    } finally {
      opener.remove();
    }
  });

  it('focuses Set up later when a step transition has a busy primary action', async () => {
    const baseProps = props();
    const view = render(<SetupWizard {...baseProps} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pick calendar…' }))
    );

    view.rerender(
      <SetupWizard {...baseProps} step="drive" driveFolder={driveController({ opening: true })} />
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Set up later' }))
    );
  });

  it('uses reduced-motion, dynamic viewport, safe-area, and touch-safe mobile classes', () => {
    render(<SetupWizard {...props({ layout: 'mobile' })} />);
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Lotus' });
    expect(dialog.className).toContain('max-h-[100dvh]');
    expect(dialog.className).toContain('motion-reduce:transition-none');
    expect(dialog.className).toContain('pb-[max(env(safe-area-inset-bottom),1rem)]');
    for (const actionName of ['Pick calendar…', 'Set up later']) {
      const action = screen.getByRole('button', { name: actionName });
      expect(action.className).toContain('min-h-12');
      expect(action.className).toContain('min-w-12');
      expect(action.className).toContain('text-base');
    }
  });

  it('dismisses from Set up later and desktop Escape', () => {
    const onDismissFromButton = vi.fn();
    const first = render(<SetupWizard {...props({ onDismiss: onDismissFromButton })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(onDismissFromButton).toHaveBeenCalledOnce();
    first.unmount();

    const onDismissFromEscape = vi.fn();
    render(<SetupWizard {...props({ onDismiss: onDismissFromEscape })} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismissFromEscape).toHaveBeenCalledOnce();
  });

  it('closes the Calendar list before dismissing the wizard', () => {
    const closeList = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SetupWizard
        {...props({
          calendarPicker: calendarController({ listOpen: true, closeList }),
          onDismiss,
        })}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeList).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('pushes and consumes one wizard-owned Android Back entry', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const onDismiss = vi.fn();
    render(<SetupWizard {...props({ layout: 'mobile', onDismiss })} />);
    expect(pushState).toHaveBeenCalledOnce();

    fireEvent.popState(window);
    fireEvent.popState(window);

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('closes the Calendar list before Android Back can dismiss the wizard', () => {
    const closeList = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SetupWizard
        {...props({
          layout: 'mobile',
          calendarPicker: calendarController({ listOpen: true, closeList }),
          onDismiss,
        })}
      />
    );

    fireEvent.popState(window);

    expect(closeList).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not consume Back while DriveFolderDialog owns the top interaction', () => {
    const onDismiss = vi.fn();
    render(
      <SetupWizard
        {...props({
          layout: 'mobile',
          driveFolder: driveController({ dialogOpen: true }),
          onDismiss,
        })}
      />
    );
    fireEvent.popState(window);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses Welcome only after the nested Drive history entry closes', () => {
    const onDismiss = vi.fn();
    const baseProps = props({ layout: 'mobile', step: 'drive', onDismiss });
    const view = render(<SetupWizard {...baseProps} />);
    const wizardHistoryState = window.history.state;

    window.history.pushState({ lotusDriveFolderDialog: 1 }, '');
    view.rerender(
      <SetupWizard {...baseProps} driveFolder={driveController({ dialogOpen: true })} />
    );
    fireEvent.popState(window);
    expect(onDismiss).not.toHaveBeenCalled();

    window.history.replaceState(wizardHistoryState, '');
    view.rerender(<SetupWizard {...baseProps} />);
    fireEvent.popState(window);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('removes its buried history entry after completion waits for Drive to close', () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const onDismiss = vi.fn();
    const baseProps = props({ layout: 'mobile', step: 'drive', onDismiss });
    const view = render(<SetupWizard {...baseProps} />);
    const wizardHistoryState = window.history.state;

    window.history.pushState({ lotusDriveFolderDialog: 1 }, '');
    view.rerender(
      <SetupWizard
        {...baseProps}
        open={false}
        driveFolder={driveController({ dialogOpen: true })}
      />
    );
    expect(historyBack).not.toHaveBeenCalled();

    window.history.replaceState(wizardHistoryState, '');
    view.rerender(
      <SetupWizard
        {...baseProps}
        open={false}
        driveFolder={driveController({ dialogOpen: false })}
      />
    );
    expect(historyBack).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
