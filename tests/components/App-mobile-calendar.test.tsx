import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];
let compactLayout = true;
let latestCalendarActivation: number | undefined;

const config = {
  calendarId: 'calendar-a',
  studios: {},
  personal: { name: '', address: '', taxId: '' },
};
const classes: never[] = [];
const refresh = vi.fn();
const reloadCache = vi.fn();
const updateConfig = vi.fn();
const save = vi.fn();
const saveOrThrow = vi.fn();
const saveUpdateOrThrow = vi.fn();

vi.mock('../../src/hooks/useConfig.js', () => ({
  useConfig: () => ({
    config,
    isDirty: false,
    isLoading: false,
    loadError: null,
    saveError: null,
    updateConfig,
    save,
    saveOrThrow,
    saveUpdateOrThrow,
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('../../src/hooks/useCalendarData.js', () => ({
  useCalendarData: () => ({
    classes,
    isLoading: false,
    error: null,
    refresh,
    reloadCache,
  }),
}));
vi.mock('../../src/hooks/useGoogleAuthorization.js', () => ({
  useGoogleAuthorization: () => ({
    hasDrive: true,
    hasCalendarWrite: false,
    isLoading: false,
    authorizationIncarnation: 0,
    promptOpen: false,
    isAuthorizing: false,
    error: null,
    allowDrive: vi.fn(),
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
vi.mock('../../src/hooks/useDriveInvoices.js', () => ({
  useDriveInvoices: () => ({
    status: 'ready',
    snapshot: {
      stagedRoot: {
        root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' },
      },
    },
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => undefined),
    activateRoot: vi.fn(async () => undefined),
    saveConfig: vi.fn(async () => ({})),
    finalize: vi.fn(),
    refinalize: vi.fn(),
    downloadVerified: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useCompactLayout.js', () => ({
  useCompactLayout: () => compactLayout,
}));
vi.mock('../../src/components/CalendarTab/index.js', () => ({
  CalendarTab: (props: { mobileActivation?: number; onAddStudio?: (name: string) => void }) => {
    latestCalendarActivation = props.mobileActivation;
    return (
      <div>
        Calendar activation {props.mobileActivation}
        <button type="button" onClick={() => props.onAddStudio?.('New Studio')}>
          Configure studio
        </button>
      </div>
    );
  },
}));
vi.mock('../../src/components/InvoicesTab/index.js', () => ({
  InvoicesTab: () => <div>Invoices content</div>,
}));
vi.mock('../../src/components/IncomeTab/index.js', () => ({
  IncomeTab: () => <div>Income content</div>,
}));
vi.mock('../../src/components/RatesTab/index.js', () => ({
  RatesTab: () => <div>Rates content</div>,
}));
vi.mock('../../src/components/LogPanel/index.js', () => ({ LogPanel: () => null }));
vi.mock('../../src/components/UpdateNotification.js', () => ({ UpdateNotification: () => null }));
vi.mock('../../src/components/CalendarPermissionPrompt.js', () => ({
  CalendarPermissionPrompt: () => null,
}));
vi.mock('../../src/lib/logger.js', () => ({
  initRustLogListener: async () => () => {},
  logInfo: vi.fn(),
}));
vi.mock('../../src/lib/drive/transport.js', () => ({ createTauriDriveApi: () => ({}) }));
vi.mock('../../src/lib/drive/folders.js', () => ({
  DriveFolderService: class DriveFolderService {},
}));
vi.mock('../../src/lib/drive/invoiceCatalog.js', () => ({ scanFinalFolder: vi.fn() }));
vi.mock('../../src/lib/drive/invoiceStore.js', () => ({
  DriveInvoiceStore: class DriveInvoiceStore {},
}));
vi.mock('../../src/lib/pdf/generatePdf.js', () => ({ renderFinalPdf: vi.fn() }));
vi.mock('../../src/lib/invoice/rows.js', () => ({
  buildCurrentInvoiceSources: async () => ({ sources: [], issues: [] }),
  currentInvoiceSourceInputKey: () => 'fixture',
  visibleCurrentInvoiceSourceBuild: () => ({
    sources: [],
    issues: [],
    ready: true,
    error: null,
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

const { default: App } = await import('../../src/App.js');

function namedButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.textContent ?? '').trim() === name
  );
  if (!button) throw new Error(`Missing button named ${name}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function renderApp() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(<App />));
  return {
    rerender() {
      act(() => root.render(<App />));
    },
  };
}

beforeEach(() => {
  compactLayout = true;
  latestCalendarActivation = undefined;
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

afterAll(() => restoreEnvironment());

describe('App mobile Calendar activation', () => {
  it('increments every mobile Calendar selection but not other App routes', async () => {
    const view = renderApp();
    expect(latestCalendarActivation).toBe(0);

    await click(namedButton('Calendar'));
    expect(latestCalendarActivation).toBe(1);

    await click(namedButton('Invoices'));
    await click(namedButton('Calendar'));
    expect(latestCalendarActivation).toBe(2);

    compactLayout = false;
    view.rerender();
    await click(namedButton('Calendar'));
    expect(latestCalendarActivation).toBe(2);

    await click(namedButton('Configure studio'));
    expect(document.body.textContent).toContain('Rates content');
    expect(latestCalendarActivation).toBe(2);
  });
});
