import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DriveInvoicesState,
  UseDriveInvoicesOptions,
} from '../../src/hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../../src/lib/drive/invoiceStore.js';
import type { AppConfig } from '../../src/lib/types.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];
const classes: never[] = [];
let compactLayout = false;
let configState: AppConfig;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const candidateFolder = {
  id: 'invoice-root',
  name: 'Invoice Root',
  mimeType: 'application/vnd.google-apps.folder',
  parents: ['root'],
  driveId: null,
  ownedByMe: true,
  trashed: false,
  capabilities: {
    canAddChildren: true,
    canDownload: false,
    canEdit: true,
    canListChildren: true,
  },
  properties: {},
  size: null,
  sha256Checksum: null,
  md5Checksum: null,
  etag: '"invoice-root"',
  version: '1',
};
const candidateRoot = {
  root: { folderId: 'invoice-root', driveId: null, folderName: 'Invoice Root' },
  rootFile: candidateFolder,
  finalFolder: { ...candidateFolder, id: 'final-root', name: 'Final', parents: ['invoice-root'] },
};
let authorizationState: {
  isLoading: boolean;
  isAuthorizing: boolean;
  hasCalendarWrite: boolean;
  hasDrive: boolean;
  authorizationIncarnation: number;
  promptOpen: boolean;
  error: Error | null;
  allowCalendarEditing: () => Promise<void>;
  allowDrive: () => Promise<void>;
  dismissCalendarEditingPrompt: () => Promise<void>;
  openCalendarEditingPrompt: () => void;
};

const readyDriveState: DriveInvoicesState = {
  status: 'ready' as const,
  snapshot: {
    stagedRoot: {
      root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' },
    },
  } as DriveStoreSnapshot,
  error: null,
  operationKey: null,
  recovery: null,
  refresh: vi.fn(async () => undefined),
  activateRoot: vi.fn(async () => readyDriveState.snapshot as DriveStoreSnapshot),
  resolveRoot: vi.fn(async () => ({
    kind: 'activated',
    snapshot: readyDriveState.snapshot as DriveStoreSnapshot,
  })),
  completeNewRoot: vi.fn(async () => readyDriveState.snapshot as DriveStoreSnapshot),
  confirmRecoveryCandidate: vi.fn(async () => readyDriveState.snapshot as DriveStoreSnapshot),
  saveConfig: vi.fn(async () => ({}) as never),
  finalize: vi.fn(async () => {
    throw new Error('finalize is not used by setup tests');
  }),
  refinalize: vi.fn(async () => {
    throw new Error('refinalize is not used by setup tests');
  }),
  downloadVerified: vi.fn(async () => new Uint8Array()),
};
let driveState: DriveInvoicesState;
const mocks = {
  buildCurrentInvoiceSources: vi.fn(async () => ({ sources: [], issues: [] })),
  invoke: vi.fn(async (command: string) => (command === 'read_legacy_config' ? null : null)),
  calendarPermissionOpen: false,
  driveOptions: null as UseDriveInvoicesOptions | null,
  driveStateForOptions: null as ((options: UseDriveInvoicesOptions) => DriveInvoicesState) | null,
};

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
(globalThis as unknown as { __APP_IS_OFFICIAL__: boolean }).__APP_IS_OFFICIAL__ = false;

vi.mock('../../src/hooks/useConfig.js', () => ({
  useConfig: () => ({
    config: configState,
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
  useGoogleAuthorization: () => authorizationState,
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
  useCalendarPicker: ({ config }: { config: AppConfig }) => ({
    calendars: null,
    listOpen: false,
    loading: false,
    saving: false,
    error: null,
    selectedName: config.calendarName ?? 'Not configured',
    connectionStatus: config.calendarId?.trim() ? 'accessible' : 'missing',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
    retryValidation: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/hooks/useDriveInvoices.js', () => ({
  useDriveInvoices: (options: UseDriveInvoicesOptions) => {
    mocks.driveOptions = options;
    return mocks.driveStateForOptions?.(options) ?? driveState;
  },
}));
vi.mock('../../src/hooks/useCompactLayout.js', () => ({
  useCompactLayout: () => compactLayout,
}));
vi.mock('../../src/components/CalendarTab/index.js', () => ({
  CalendarTab: () => <div>Calendar content</div>,
}));
vi.mock('../../src/components/InvoicesTab/index.js', () => ({
  InvoicesTab: ({ sourceError }: { sourceError: string | null }) => (
    <div>
      Invoices content
      {sourceError && <span>Invoice source error: {sourceError}</span>}
    </div>
  ),
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
  CalendarPermissionPrompt: ({ open }: { open: boolean }) => {
    mocks.calendarPermissionOpen = open;
    return null;
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  initRustLogListener: async () => () => {},
  logInfo: vi.fn(),
}));
vi.mock('../../src/lib/drive/transport.js', () => ({ createTauriDriveApi: () => ({}) }));
vi.mock('../../src/lib/drive/folders.js', () => ({
  DriveFolderService: class DriveFolderService {
    async listLocations() {
      return [{ kind: 'myDrive', id: 'root', name: 'My Drive', driveId: null }];
    }
    async listChildren(_location: unknown, parentId: string) {
      return { folders: parentId === 'root' ? [candidateFolder] : [], nextPageToken: null };
    }
    async createChild() {
      return candidateFolder;
    }
    async stageRoot() {
      return candidateRoot;
    }
  },
}));
vi.mock('../../src/lib/drive/invoiceCatalog.js', () => ({
  scanFinalFolder: vi.fn(async () => ({
    entries: [],
    warnings: [],
    blockingConflicts: [],
    maxSequenceByYear: {},
  })),
}));
vi.mock('../../src/lib/drive/invoiceStore.js', () => ({
  DriveInvoiceStore: class DriveInvoiceStore {},
}));
vi.mock('../../src/lib/pdf/generatePdf.js', () => ({ renderFinalPdf: vi.fn() }));
vi.mock('../../src/lib/invoice/rows.js', () => ({
  buildCurrentInvoiceSources: mocks.buildCurrentInvoiceSources,
  currentInvoiceSourceInputKey: () => 'fixture',
  visibleCurrentInvoiceSourceBuild: (
    inputKey: string,
    build: { inputKey: string | null; sources: never[]; issues: never[]; error: string | null }
  ) =>
    build.inputKey === inputKey
      ? { sources: build.sources, issues: build.issues, ready: true, error: build.error }
      : { sources: [], issues: [], ready: false, error: null },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

const { screen, waitFor } = await import('@testing-library/react');
const { default: App } = await import('../../src/App.js');

function namedButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.textContent ?? '').trim() === name
  );
  if (!button) throw new Error(`Missing button named ${name}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function renderApp(options: { compact?: boolean } = {}) {
  compactLayout = options.compact ?? compactLayout;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(<App />));
  return { container, rerender: () => act(() => root.render(<App />)) };
}

function renderIncompleteApp() {
  configState = { ...configState, calendarId: undefined };
  authorizationState = { ...authorizationState, hasDrive: false };
  driveState = { ...driveState, status: 'authorizationRequired', snapshot: null };
  return renderApp();
}

function renderDriveStepApp() {
  configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
  authorizationState = { ...authorizationState, hasDrive: true };
  driveState = { ...driveState, status: 'unconfigured', snapshot: null };
  return renderApp();
}

async function settleLocalPointerRead(): Promise<void> {
  await waitFor(() => expect(mocks.driveOptions?.pointer).toMatchObject({ kind: 'absent' }));
}

beforeEach(() => {
  compactLayout = false;
  configState = {
    teacher: {
      name: 'Teacher',
      address: '',
      taxNumber: '',
      bankDetails: { accountOwner: '', iban: '', bic: '' },
    },
    studios: {},
  };
  authorizationState = {
    isLoading: false,
    isAuthorizing: false,
    hasCalendarWrite: false,
    hasDrive: false,
    authorizationIncarnation: 0,
    promptOpen: false,
    error: null,
    allowCalendarEditing: vi.fn(async () => undefined),
    allowDrive: vi.fn(async () => undefined),
    dismissCalendarEditingPrompt: vi.fn(async () => undefined),
    openCalendarEditingPrompt: vi.fn(),
  };
  driveState = { ...readyDriveState, status: 'authorizationRequired', snapshot: null };
  mocks.buildCurrentInvoiceSources.mockReset();
  mocks.buildCurrentInvoiceSources.mockImplementation(() => new Promise(() => {}));
  mocks.calendarPermissionOpen = false;
  mocks.driveOptions = null;
  mocks.driveStateForOptions = null;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === 'read_legacy_config' ? null : null
  );
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  window.history.replaceState(null, '');
});

afterAll(() => restoreEnvironment());

describe('App required Google setup', () => {
  it('waits for the local pointer read before enabling Drive bootstrap', async () => {
    const pointerRead = deferred<string | null>();
    mocks.invoke.mockImplementation((command: string) =>
      command === 'read_drive_config_pointer' ? pointerRead.promise : Promise.resolve(null)
    );
    renderIncompleteApp();

    expect(mocks.driveOptions?.discoveryEnabled).toBe(false);
    expect(mocks.driveOptions?.pointer).toBeUndefined();
    expect(document.body.textContent).toBe('Loading…');

    await act(async () => {
      pointerRead.resolve(null);
      await pointerRead.promise;
    });

    await settleLocalPointerRead();
    expect(mocks.driveOptions?.discoveryEnabled).toBe(true);
  });

  it('passes a valid local pointer to exact-file startup', async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'read_drive_config_pointer'
        ? JSON.stringify({ version: 1, configFileId: 'config-file-7' })
        : null
    );
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = readyDriveState;
    renderApp();

    await waitFor(() =>
      expect(mocks.driveOptions?.pointer).toMatchObject({
        kind: 'valid',
        fileId: 'config-file-7',
      })
    );
  });

  it('removes the exact legacy YAML after a cloud config is loaded', async () => {
    const raw = 'teacher:\n  name: Legacy\nstudios: {}\n';
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'read_legacy_config' ? raw : null
    );
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = readyDriveState;
    renderApp();

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('remove_verified_legacy_config', {
        expectedRaw: raw,
      })
    );
  });

  it('shows only loading while authorized Drive discovery is unresolved', async () => {
    authorizationState = { ...authorizationState, isLoading: false, hasDrive: true };
    driveState = { ...driveState, status: 'loading', snapshot: null };
    renderApp();
    await settleLocalPointerRead();
    expect(document.body.textContent).toBe('Loading…');
    expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
  });

  it('selects Calendar after a configured cold start finishes checking Drive', async () => {
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = { ...driveState, status: 'loading', snapshot: null };
    const view = renderApp();
    await settleLocalPointerRead();
    expect(document.body.textContent).toBe('Loading…');

    driveState = readyDriveState;
    view.rerender();

    expect(document.body.textContent).toContain('Calendar content');
  });

  it('opens Welcome over Rates and gates every other desktop destination', async () => {
    renderIncompleteApp();
    await settleLocalPointerRead();
    expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
    expect(document.body.textContent).toContain('Rates content');
    expect(namedButton('Calendar').disabled).toBe(true);
    expect(namedButton('Invoices').disabled).toBe(true);
    expect(namedButton('Income').disabled).toBe(true);
    expect(namedButton('Rates & Config').disabled).toBe(false);
  });

  it('gates mobile destinations while leaving Settings available', async () => {
    configState = { ...configState, calendarId: undefined };
    authorizationState = { ...authorizationState, hasDrive: false };
    driveState = { ...driveState, status: 'authorizationRequired', snapshot: null };
    renderApp({ compact: true });
    await settleLocalPointerRead();
    expect(document.body.textContent).toContain('Rates content');
    expect(namedButton('Calendar').disabled).toBe(true);
    expect(namedButton('Invoices').disabled).toBe(true);
    expect(namedButton('Income').disabled).toBe(true);
    expect(namedButton('Settings').disabled).toBe(false);
  });

  it('dismisses for the session, keeps Rates active, and does not build invoice sources', async () => {
    renderIncompleteApp();
    await settleLocalPointerRead();
    await click(namedButton('Set up later'));
    expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
    expect(document.body.textContent).toContain('Rates content');
    expect(mocks.buildCurrentInvoiceSources).not.toHaveBeenCalled();
  });

  it('closes Welcome when a confirmed Drive configuration completes setup', async () => {
    const view = renderDriveStepApp();
    await settleLocalPointerRead();
    expect(document.body.textContent).toContain('Rates content');
    driveState = readyDriveState;
    authorizationState = { ...authorizationState, hasDrive: true };
    view.rerender();

    expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
    expect(document.body.textContent).toContain('Calendar content');
    expect(namedButton('Invoices').disabled).toBe(false);
  });

  it('keeps activation alive across mobile-to-desktop history transfer and closes the dialog', async () => {
    const activation = deferred<DriveStoreSnapshot>();
    const activateRoot = vi.fn(() => activation.promise);
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = {
      ...driveState,
      status: 'unconfigured',
      snapshot: null,
      activateRoot,
      resolveRoot: vi.fn(async () => ({
        kind: 'activated',
        snapshot: await activateRoot(),
      })),
    };
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const view = renderApp({ compact: true });
    await settleLocalPointerRead();
    const wizardHistoryState = window.history.state;

    await click(namedButton('Pick Drive folder…'));
    expect(await screen.findByRole('dialog', { name: 'Choose Drive invoice folder' })).toBeTruthy();
    await click(namedButton('Create / Select folder…'));
    await click(await screen.findByRole('button', { name: 'My Drive' }));
    await click(await screen.findByRole('button', { name: 'Invoice Root' }));
    await click(namedButton('Use this folder'));
    expect(await screen.findByText('0 recognized invoices')).toBeTruthy();
    await click(namedButton('Activate for all devices'));
    await waitFor(() => expect(activateRoot).toHaveBeenCalledOnce());

    driveState = { ...driveState, status: 'loading', snapshot: null };
    view.rerender();
    expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Choose Drive invoice folder' })).toBeTruthy();
    expect(document.body.textContent).toContain('Rates content');

    compactLayout = false;
    view.rerender();
    await waitFor(() => expect(historyBack).toHaveBeenCalledOnce());
    window.history.replaceState(wizardHistoryState, '');
    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await Promise.resolve();
    });
    expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Choose Drive invoice folder' })).toBeTruthy();
    expect(window.history.state).toBe(wizardHistoryState);

    driveState = {
      ...readyDriveState,
      activateRoot,
      resolveRoot: vi.fn(async () => ({
        kind: 'activated',
        snapshot: await activateRoot(),
      })),
    };
    view.rerender();
    await act(async () => {
      activation.resolve({
        stagedRoot: candidateRoot,
        config: { file: { parents: [candidateRoot.root.folderId] } },
      } as DriveStoreSnapshot);
      await activation.promise;
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose Drive invoice folder' })).toBeNull()
    );
    expect(document.body.textContent).toContain('Calendar content');
    expect(historyBack).toHaveBeenCalledTimes(2);
  });

  it('unlocks without leaving Rates when completion came after dismissal', async () => {
    const view = renderDriveStepApp();
    await settleLocalPointerRead();
    await click(namedButton('Set up later'));
    driveState = { ...driveState, status: 'loading', snapshot: null };
    view.rerender();
    expect(document.body.textContent).toContain('Rates content');
    driveState = readyDriveState;
    view.rerender();
    expect(document.body.textContent).toContain('Rates content');
  });

  it('suppresses optional Calendar editing permission until required setup closes', async () => {
    authorizationState = { ...authorizationState, promptOpen: true };
    const view = renderDriveStepApp();
    await settleLocalPointerRead();
    expect(mocks.calendarPermissionOpen).toBe(false);

    driveState = readyDriveState;
    view.rerender();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull()
    );
    expect(mocks.calendarPermissionOpen).toBe(true);
  });

  it('starts on Drive when Calendar is already configured', async () => {
    renderDriveStepApp();
    await settleLocalPointerRead();
    expect(screen.getByRole('heading', { name: 'Choose your invoice folder' })).toBeTruthy();
    expect(document.body.textContent).toContain('Step 1 of 2');
  });

  it('discovers the real authorization requirement without an existing grant', async () => {
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    driveState = { ...driveState, status: 'authorizationRequired', snapshot: null };
    renderApp();
    await settleLocalPointerRead();
    expect(mocks.driveOptions?.discoveryEnabled).toBe(true);
    const pickDrive = namedButton('Pick Drive folder…');
    expect(pickDrive.disabled).toBe(false);
    await click(pickDrive);
    expect(authorizationState.allowDrive).toHaveBeenCalledOnce();
  });

  it('keeps the full source context while Drive reconciles the built sources', async () => {
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    let fullSourceReady = false;
    mocks.driveStateForOptions = (options) =>
      options.sourceContextKey === 'setup-discovery'
        ? readyDriveState
        : fullSourceReady
          ? readyDriveState
          : { ...readyDriveState, status: 'loading', snapshot: null };
    mocks.buildCurrentInvoiceSources
      .mockReset()
      .mockResolvedValueOnce({ sources: [], issues: [] })
      .mockImplementation(() => new Promise(() => {}));
    const view = renderApp();
    await settleLocalPointerRead();

    await waitFor(() => expect(mocks.driveOptions?.sourceContextKey).toBe('fixture'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.buildCurrentInvoiceSources).toHaveBeenCalledOnce();
    expect(mocks.driveOptions?.sourceContextKey).toBe('fixture');
    expect(document.body.textContent).not.toBe('Loading…');

    fullSourceReady = true;
    view.rerender();
    expect(mocks.driveOptions?.sourceContextKey).toBe('fixture');
    expect(document.body.textContent).toContain('Calendar content');
  });

  it('starts on Calendar when Drive is already configured', async () => {
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = readyDriveState;
    renderApp();
    await settleLocalPointerRead();
    expect(screen.getByRole('heading', { name: 'Choose your teaching calendar' })).toBeTruthy();
    expect(document.body.textContent).toContain('Step 2 of 2');
  });

  it('shows the unavailable Drive error and its Retry action', async () => {
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = {
      ...driveState,
      status: 'offline',
      snapshot: null,
      error: { message: 'Drive unavailable' } as DriveInvoicesState['error'],
    };
    renderApp();
    await settleLocalPointerRead();
    expect(screen.getByRole('alert').textContent).toBe('Drive unavailable');
    expect(screen.getByRole('button', { name: 'Retry Google Drive' })).toBeTruthy();
  });

  it('forces an active destination back to Rates if readiness becomes incomplete', async () => {
    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = readyDriveState;
    const view = renderApp();
    await settleLocalPointerRead();
    await click(namedButton('Income'));
    expect(document.body.textContent).toContain('Income content');

    configState = { ...configState, calendarId: undefined };
    view.rerender();
    expect(document.body.textContent).toContain('Rates content');
    await click(namedButton('Set up later'));

    configState = { ...configState, calendarId: 'calendar-a' };
    view.rerender();
    expect(document.body.textContent).toContain('Rates content');
  });

  it('preserves session dismissal when the layout changes', async () => {
    const view = renderIncompleteApp();
    await settleLocalPointerRead();
    await click(namedButton('Set up later'));
    compactLayout = true;
    view.rerender();
    expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
    expect(document.body.textContent).toContain('Rates content');
  });

  it('publishes invoice source errors only after setup is ready', async () => {
    mocks.buildCurrentInvoiceSources.mockRejectedValue(new Error('Source build failed'));
    const view = renderIncompleteApp();
    await settleLocalPointerRead();
    expect(mocks.buildCurrentInvoiceSources).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Source build failed');

    configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
    authorizationState = { ...authorizationState, hasDrive: true };
    driveState = readyDriveState;
    view.rerender();
    await waitFor(() => expect(mocks.buildCurrentInvoiceSources).toHaveBeenCalledOnce());
    await click(namedButton('Invoices'));
    await waitFor(() =>
      expect(document.body.textContent).toContain('Invoice source error: Source build failed')
    );
  });
});
