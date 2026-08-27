import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];
const allowDrive = vi.fn(async () => undefined);
const classes: never[] = [];

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;

const config = {
  teacher: {
    name: '',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: '',
  studios: {},
};

vi.mock('../../src/hooks/useConfig.js', () => ({
  useConfig: () => ({
    config,
    isDirty: false,
    isLoading: false,
    loadError: null,
    saveError: null,
    updateConfig: vi.fn(),
    save: vi.fn(async () => undefined),
    saveOrThrow: vi.fn(async () => undefined),
    saveUpdateOrThrow: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/hooks/useCalendarData.js', () => ({
  useCalendarData: () => ({
    classes,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    reloadCache: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useGoogleAuthorization.js', () => ({
  useGoogleAuthorization: () => ({
    hasDrive: false,
    hasCalendarWrite: false,
    isLoading: false,
    authorizationIncarnation: 0,
    promptOpen: false,
    isAuthorizing: false,
    error: null,
    allowDrive,
    allowCalendarEditing: vi.fn(),
    dismissCalendarEditingPrompt: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useCalendarEditing.js', () => ({
  useCalendarEditing: () => ({
    canEdit: false,
    reassignOccurrenceStudio: vi.fn(),
    prepareOccurrenceValueEdit: vi.fn(),
    saveOccurrenceValueEdit: vi.fn(),
    prepareSeriesStudioEdit: vi.fn(),
    saveSeriesStudioEdit: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useCalendarPicker.js', () => ({
  useCalendarPicker: () => ({
    calendars: null,
    listOpen: false,
    loading: false,
    saving: false,
    error: null,
    selectedName: 'Not configured',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useCompactLayout.js', () => ({
  useCompactLayout: () => false,
}));
vi.mock('../../src/components/CalendarTab/index.js', () => ({
  CalendarTab: () => <div>Calendar</div>,
}));
vi.mock('../../src/components/IncomeTab/index.js', () => ({
  IncomeTab: () => <div>Income</div>,
}));
vi.mock('../../src/components/LogPanel/index.js', () => ({ LogPanel: () => null }));
vi.mock('../../src/components/UpdateNotification.js', () => ({ UpdateNotification: () => null }));
vi.mock('../../src/components/CalendarPermissionPrompt.js', () => ({
  CalendarPermissionPrompt: () => null,
}));
vi.mock('../../src/components/setup/DriveFolderDialog.js', () => ({
  DriveFolderDialog: () => null,
}));
vi.mock('../../src/lib/logger.js', () => ({
  initRustLogListener: async () => () => {},
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../../src/lib/gmail/auth.js', async () => {
  const { AuthorizationRequiredError } =
    await import('../../src/lib/google/mobile-authorization.js');
  return {
    getAccessToken: vi.fn(async () => {
      throw new AuthorizationRequiredError('Drive access needs user action');
    }),
    clearEphemeralAccessToken: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/lib/drive/folders.js', () => ({
  DriveFolderService: class DriveFolderService {},
  DriveFolderError: class DriveFolderError extends Error {},
}));
vi.mock('../../src/lib/drive/invoiceCatalog.js', () => ({ scanFinalFolder: vi.fn() }));
vi.mock('../../src/lib/pdf/generatePdf.js', () => ({
  renderFinalPdf: vi.fn(),
  generateAndOpenPdf: vi.fn(),
  openPdfBytes: vi.fn(),
  createGmailDraft: vi.fn(),
}));
vi.mock('../../src/lib/invoice/rows.js', () => ({
  buildCurrentInvoiceSources: async () => [],
  currentInvoiceSourceInputKey: () => 'fixture',
  visibleCurrentInvoiceSourceBuild: () => ({ sources: [], ready: true, error: null }),
  buildInvoiceRows: () => [],
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

const { waitFor } = await import('@testing-library/react');
const { default: App } = await import('../../src/App.js');

function button(name: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (!target) throw new Error(`Missing button: ${name}`);
  return target;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function renderApp(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(<App />));
  return container;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  allowDrive.mockClear();
});
afterAll(() => restoreEnvironment());

describe('App Drive setup without an existing grant', () => {
  it('authorizes from Connections and keeps Invoices strictly empty', async () => {
    const container = renderApp();

    await click(button('Rates & Config'));
    await waitFor(() => expect(button('Pick Drive folder…').disabled).toBe(false));
    const pickDrive = button('Pick Drive folder…');
    await click(pickDrive);
    expect(allowDrive).toHaveBeenCalledOnce();

    await click(button('Invoices'));
    const content = container.querySelector('.flex-1.overflow-auto');
    expect(content?.innerHTML).toBe('');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});
