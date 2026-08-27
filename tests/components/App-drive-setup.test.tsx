import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationRequiredError } from '../../src/lib/google/mobile-authorization.js';
import type { CurrentInvoiceSource } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];
const allowDrive = vi.fn(async () => undefined);
const getAccessToken = vi.fn(async () => {
  throw new AuthorizationRequiredError('Drive access needs user action');
});
const classes: never[] = [];
let publishReadySnapshot = false;
let publishUnconfiguredSnapshot = false;
let refreshOverride: (() => Promise<DriveStoreSnapshot>) | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const buildCurrentInvoiceSources = vi.fn(
  async (): Promise<CurrentInvoiceSource[]> => [
    {
      key: { studioSlug: 'studio-a', monthKey: '2026-08' },
      studioName: 'Studio A',
      invoice: {
        studioName: 'Studio A',
        invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
        generatedAt: '2026-08-27T00:00:00.000Z',
        issueDate: '2026-08-27',
        classes: [],
        totalClasses: 0,
        totalAmount: 0,
      },
      classes: [],
      config,
      fingerprint: { sourceSha256: 'source-a', calendarSha256: 'calendar-a' },
    },
  ]
);

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;

const config = {
  teacher: {
    name: '',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: 'calendar-a',
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
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
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
  useGoogleAuthorization: () => authorizationState,
}));
let authorizationState = {
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
};
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
  return {
    getAccessToken,
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
  buildCurrentInvoiceSources,
  currentInvoiceSourceInputKey: () => 'fixture',
  visibleCurrentInvoiceSourceBuild: (
    inputKey: string,
    build: { inputKey: string | null; sources: never[]; error: string | null }
  ) =>
    build.inputKey === inputKey
      ? { sources: build.sources, ready: true, error: build.error }
      : { sources: [], ready: false, error: null },
  buildInvoiceRows: () => [],
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

const { waitFor } = await import('@testing-library/react');
const { DriveInvoiceStore, DriveStoreError } = await import('../../src/lib/drive/invoiceStore.js');
const realBootstrap = DriveInvoiceStore.prototype.bootstrap;
const realRefresh = DriveInvoiceStore.prototype.refresh;
const readySnapshot = {
  config: {
    file: { id: 'config-file', parents: ['root-a'] },
    config,
  },
  stagedRoot: {
    root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' },
  },
  scan: { entries: [], warnings: [], blockingConflicts: [] },
} as DriveStoreSnapshot;
const bootstrap = vi
  .spyOn(DriveInvoiceStore.prototype, 'bootstrap')
  .mockImplementation(function (sources) {
    if (publishReadySnapshot) return Promise.resolve(readySnapshot);
    if (publishUnconfiguredSnapshot) return Promise.resolve(null);
    return realBootstrap.call(this, sources);
  });
const storeRefresh = vi
  .spyOn(DriveInvoiceStore.prototype, 'refresh')
  .mockImplementation(function (sources) {
    if (refreshOverride !== null) return refreshOverride();
    if (publishReadySnapshot) return Promise.resolve(readySnapshot);
    return realRefresh.call(this, sources);
  });
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

function renderApp() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(<App />));
  return { container, rerender: () => act(() => root.render(<App />)) };
}

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  allowDrive.mockClear();
  getAccessToken.mockClear();
  bootstrap.mockClear();
  storeRefresh.mockClear();
  buildCurrentInvoiceSources.mockClear();
  publishReadySnapshot = false;
  publishUnconfiguredSnapshot = false;
  refreshOverride = null;
  authorizationState = {
    ...authorizationState,
    hasDrive: false,
    authorizationIncarnation: 0,
  };
});
afterAll(() => {
  bootstrap.mockRestore();
  storeRefresh.mockRestore();
  restoreEnvironment();
});

describe('App Drive setup without an existing grant', () => {
  it('gates Invoices through real no-grant discovery, then unlocks an empty Drive', async () => {
    const { container, rerender } = renderApp();

    await waitFor(() => expect(button('Pick Drive folder…').disabled).toBe(false));
    expect(button('Invoices').disabled).toBe(true);
    const pickDrive = button('Pick Drive folder…');
    await click(pickDrive);
    expect(allowDrive).toHaveBeenCalledOnce();

    authorizationState = {
      ...authorizationState,
      hasDrive: true,
      authorizationIncarnation: 1,
    };
    rerender();
    await waitFor(() =>
      expect(container.textContent).toContain('Google Drive authorization is required')
    );
    expect(getAccessToken).toHaveBeenCalledWith({ requireDrive: true, interactive: false });
    expect(button('Invoices').disabled).toBe(true);

    publishReadySnapshot = true;
    authorizationState = { ...authorizationState, authorizationIncarnation: 2 };
    rerender();
    await waitFor(() => expect(button('Invoices').disabled).toBe(false));
    await click(button('Invoices'));
    const content = container.querySelector('.flex-1.overflow-auto');
    expect(content?.textContent).toContain('No invoices');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('table')).toBeTruthy();
  });

  it('keeps the built source context while the real hook masks a slow full-source refresh', async () => {
    const fullSourceRefresh = deferred<DriveStoreSnapshot>();
    publishReadySnapshot = true;
    refreshOverride = () => fullSourceRefresh.promise;
    authorizationState = {
      ...authorizationState,
      hasDrive: true,
      authorizationIncarnation: 1,
    };
    const { container, rerender } = renderApp();

    await waitFor(() => expect(storeRefresh).toHaveBeenCalledOnce());
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Calendar');
    expect(container.textContent).not.toBe('Loading…');
    expect(button('Invoices').disabled).toBe(false);

    rerender();
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(storeRefresh).toHaveBeenCalledOnce();
    expect(storeRefresh.mock.calls[0][0][0].fingerprint.sourceSha256).toBe('source-a');
    expect(container.textContent).toContain('Calendar');

    await act(async () => {
      fullSourceRefresh.resolve(readySnapshot);
      await fullSourceRefresh.promise;
    });
    await waitFor(() => expect(button('Invoices').disabled).toBe(false));
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it('keeps setup unlocked and retryable after a real-hook transient full-source error', async () => {
    const fullSourceRefresh = deferred<DriveStoreSnapshot>();
    publishReadySnapshot = true;
    refreshOverride = () => fullSourceRefresh.promise;
    authorizationState = {
      ...authorizationState,
      hasDrive: true,
      authorizationIncarnation: 1,
    };
    const { container, rerender } = renderApp();

    await waitFor(() => expect(storeRefresh).toHaveBeenCalledOnce());
    await click(button('Rates & Config'));
    act(() => {
      fullSourceRefresh.reject(
        new DriveStoreError('offline', 'Google Drive is temporarily unavailable', true)
      );
    });

    await waitFor(() =>
      expect(container.textContent).toContain('Google Drive is temporarily unavailable')
    );
    expect(button('Invoices').disabled).toBe(false);
    expect(button('Retry Google Drive').disabled).toBe(false);
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(storeRefresh).toHaveBeenCalledOnce();
    expect(storeRefresh.mock.calls[0][0][0].fingerprint.sourceSha256).toBe('source-a');

    rerender();
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(storeRefresh).toHaveBeenCalledOnce();

    refreshOverride = () => Promise.resolve(readySnapshot);
    await click(button('Retry Google Drive'));
    await waitFor(() => expect(storeRefresh).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(container.textContent).not.toContain('Google Drive is temporarily unavailable')
    );
    expect(button('Invoices').disabled).toBe(false);
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(storeRefresh.mock.calls[1][0][0].fingerprint.sourceSha256).toBe('source-a');

    rerender();
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(storeRefresh).toHaveBeenCalledTimes(2);
  });

  it('clears retained setup evidence after a conclusive real-hook source refresh error', async () => {
    const fullSourceRefresh = deferred<DriveStoreSnapshot>();
    publishReadySnapshot = true;
    refreshOverride = () => fullSourceRefresh.promise;
    authorizationState = {
      ...authorizationState,
      hasDrive: true,
      authorizationIncarnation: 1,
    };
    const { container } = renderApp();

    await waitFor(() => expect(storeRefresh).toHaveBeenCalledOnce());
    expect(container.textContent).toContain('Calendar');
    publishReadySnapshot = false;
    publishUnconfiguredSnapshot = true;
    refreshOverride = null;
    act(() => {
      fullSourceRefresh.reject(new DriveStoreError('unconfigured', 'Drive root removed', false));
    });

    await waitFor(() => expect(button('Invoices').disabled).toBe(true));
    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button('Pick Drive folder…').disabled).toBe(false));
    expect(container.textContent).toContain('Choose your invoice folder');
    expect(buildCurrentInvoiceSources).toHaveBeenCalledOnce();
  });
});
