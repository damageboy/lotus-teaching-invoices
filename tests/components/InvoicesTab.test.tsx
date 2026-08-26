import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { AppConfig, ParsedClass } from '../../src/lib/types.js';
import type { DriveInvoiceEntry } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveInvoicesState } from '../../src/hooks/useDriveInvoices.js';
import { DriveStoreError } from '../../src/lib/drive/invoiceStore.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
  return root;
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  clearLog();
});
afterAll(() => restoreEnvironment());

const { InvoicesTab, activateDriveStorage } =
  await import('../../src/components/InvoicesTab/index.js');
const { clearLog, subscribeLog } = await import('../../src/lib/logger.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: 'calendar-a',
  outputDir: '/legacy-output',
  lastInvoice: '11/2026',
  studios: {
    Yoga: {
      fullName: 'Yoga',
      address: '',
      invoiceEmail: 'studio@example.com',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    },
  },
};

const currentClass: ParsedClass = {
  eventIdentity: { calendarId: 'calendar-a', eventId: 'event-1', etag: '"event-1"' },
  sourceSummary: 'Yoga / Flow',
  sourceDescription: '2',
  studioName: 'Yoga',
  classType: 'Flow',
  date: '2026-07-03',
  startTime: '10:00',
  endTime: '11:00',
  studentCount: 2,
};

function entry(
  state: DriveInvoiceEntry['state'] = 'fresh',
  overrides: Partial<DriveInvoiceEntry> = {}
): DriveInvoiceEntry {
  return {
    key: { studioSlug: 'yoga', monthKey: '2026-07' },
    file: {
      id: 'pdf-yoga-2026-07',
      name: '12-2026-yoga-2026-07.pdf',
      mimeType: 'application/pdf',
      parents: ['final-folder'],
      driveId: null,
      ownedByMe: true,
      trashed: false,
      version: '2',
      size: '4',
      md5Checksum: null,
      sha256Checksum: 'a'.repeat(64),
      properties: {},
      capabilities: {
        canListChildren: false,
        canAddChildren: false,
        canEdit: true,
        canDownload: true,
      },
      etag: '"pdf-v2"',
    },
    filename: '12-2026-yoga-2026-07.pdf',
    invoiceNumber: '12/2026',
    state,
    sourceSha256: 'b'.repeat(64),
    pdfSha256: 'a'.repeat(64),
    message: state === 'fresh' ? null : `Drive state: ${state}`,
    ...overrides,
  };
}

function driveState(
  status: DriveInvoicesState['status'],
  overrides: Partial<DriveInvoicesState> & { entries?: DriveInvoiceEntry[] } = {}
): DriveInvoicesState {
  const entries = overrides.entries ?? [];
  return {
    status,
    snapshot:
      status === 'ready'
        ? ({
            stagedRoot: {
              root: { folderId: 'root-folder', driveId: null, folderName: 'Lotus Invoices' },
              rootFile: { name: 'Lotus Invoices' },
              finalFolder: { id: 'final-folder', name: 'Final' },
            },
            scan: { entries, warnings: [], blockingConflicts: [], maxSequenceByYear: {} },
          } as DriveInvoicesState['snapshot'])
        : null,
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => {}),
    activateRoot: vi.fn(async () => {}),
    finalize: vi.fn(async () => entry()),
    refinalize: vi.fn(async () => entry()),
    recoverReservation: vi.fn(async () => {}),
    downloadVerified: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    ...overrides,
  };
}

function dependencies() {
  return {
    generateAndOpenPdf: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    openPdfBytes: vi.fn(async () => ({ status: 'opened' as const })),
    createGmailDraft: vi.fn(async () => {}),
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    classes: [currentClass],
    config,
    activeFreshness: [],
    activeFreshnessContext: null,
    freshnessVerified: true,
    onAcknowledgeFreshnessClear: vi.fn(),
    onRefreshFreshness: vi.fn(async () => {}),
    drive: driveState('ready'),
    folderService: {
      listLocations: vi.fn(async () => []),
      listChildren: vi.fn(),
      createChild: vi.fn(),
      stageRoot: vi.fn(),
    },
    scanCandidate: vi.fn(),
    onSaveConfig: vi.fn(async () => {}),
    dependencies: dependencies(),
    ...overrides,
  };
}

describe('Drive-backed InvoicesTab', () => {
  it('offers app-driven recovery only for a durable reservation error', async () => {
    const ready = driveState('ready');
    const drive = driveState('blocked', {
      snapshot: ready.snapshot,
      error: new DriveStoreError(
        'recoveryRequired',
        'Invoice upload response was not confirmed; recover the reservation',
        false
      ),
    });
    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain('recover the reservation');
    await click(button('Recover invoice reservation'));
    await waitFor(() => expect(drive.recoverReservation).toHaveBeenCalledOnce());
  });

  it('writes Drive control before removing legacy authority from the latest queued config', async () => {
    const calls: string[] = [];
    const queuedWrite = deferred<void>();
    const drive = driveState('unconfigured', {
      activateRoot: vi.fn(async () => {
        calls.push('drive');
      }),
    });
    let currentConfig = config;
    let durableConfig: AppConfig | null = null;
    const saveConfig = vi.fn(async (update: (current: AppConfig) => AppConfig) => {
      calls.push('config');
      await queuedWrite.promise;
      durableConfig = update(currentConfig);
    });

    const activation = activateDriveStorage(
      drive,
      {
        root: { folderId: 'root', driveId: null, folderName: 'Drive Root' },
        rootFile: {} as any,
        finalFolder: {} as any,
      },
      config,
      saveConfig
    );
    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
    currentConfig = {
      ...config,
      teacher: { ...config.teacher, name: 'Concurrent Teacher' },
    };
    queuedWrite.resolve();
    await activation;

    expect(calls).toEqual(['drive', 'config']);
    expect(drive.activateRoot).toHaveBeenCalledWith(expect.any(Object), '11/2026');
    expect(durableConfig).toEqual(
      expect.objectContaining({ teacher: expect.objectContaining({ name: 'Concurrent Teacher' }) })
    );
    expect(durableConfig).not.toHaveProperty('outputDir');
    expect(durableConfig).not.toHaveProperty('lastInvoice');
  });

  it('keeps legacy config fields when remote activation fails', async () => {
    const drive = driveState('unconfigured', {
      activateRoot: vi.fn(async () => {
        throw new Error('Drive control conflict');
      }),
    });
    const saveConfig = vi.fn();

    await expect(
      activateDriveStorage(
        drive,
        {
          root: { folderId: 'root', driveId: null, folderName: 'Drive Root' },
          rootFile: {} as any,
          finalFolder: {} as any,
        },
        config,
        saveConfig
      )
    ).rejects.toThrow('Drive control conflict');

    expect(saveConfig).not.toHaveBeenCalled();
    expect(config).toHaveProperty('outputDir', '/legacy-output');
    expect(config).toHaveProperty('lastInvoice', '11/2026');
  });

  it('keeps Preview available before Drive setup and disables persistent actions', () => {
    render(<InvoicesTab {...(props({ drive: driveState('unconfigured') }) as any)} />);

    expect(button('Preview PDF').disabled).toBe(false);
    expect(button('Finalize PDF').disabled).toBe(true);
    expect(button('Choose Drive folder').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('/legacy-output');
  });

  it('uses verified Drive bytes for open and draft without rendering a replacement', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const finalized = entry();
    const drive = driveState('ready', {
      entries: [finalized],
      downloadVerified: vi.fn(async () => bytes),
    });
    const deps = dependencies();
    render(<InvoicesTab {...(props({ drive, dependencies: deps }) as any)} />);

    await click(button('Open PDF'));
    await waitFor(() => expect(deps.openPdfBytes).toHaveBeenCalledOnce());
    await click(button('Draft Email'));
    await waitFor(() => expect(deps.createGmailDraft).toHaveBeenCalledOnce());

    expect(drive.downloadVerified).toHaveBeenCalledTimes(2);
    expect(deps.openPdfBytes).toHaveBeenCalledWith(finalized.filename, bytes);
    expect(deps.createGmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ pdfBytes: bytes, pdfFilename: finalized.filename })
    );
    expect(deps.generateAndOpenPdf).not.toHaveBeenCalled();
  });

  it('keeps verified read actions enabled but disables re-finalization without edit permission', async () => {
    const readOnly = entry('stale', { message: 'Calendar or billing data changed' });
    readOnly.file.capabilities.canEdit = false;
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const drive = driveState('ready', {
      entries: [readOnly],
      downloadVerified: vi.fn(async () => bytes),
    });
    const deps = dependencies();
    render(<InvoicesTab {...(props({ drive, dependencies: deps }) as any)} />);

    expect(button('Re-finalize PDF').disabled).toBe(true);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);

    await click(button('Open PDF'));
    await waitFor(() => expect(deps.openPdfBytes).toHaveBeenCalledWith(readOnly.filename, bytes));
    await click(button('Draft Email'));
    await waitFor(() => expect(deps.createGmailDraft).toHaveBeenCalledOnce());

    expect(drive.downloadVerified).toHaveBeenCalledTimes(2);
    expect(drive.refinalize).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Edit access is required to re-finalize');
  });

  it.each([
    ['duplicate', 'Multiple Drive files map to yoga 2026-07'],
    ['corrupt', 'PDF checksum does not match'],
    ['permission', 'Drive invoice cannot be downloaded'],
  ] as const)('blocks %s rows with the exact Drive reason', (state, reason) => {
    render(
      <InvoicesTab
        {...(props({
          drive: driveState('ready', { entries: [entry(state, { message: reason })] }),
        }) as any)}
      />
    );

    expect(document.body.textContent).toContain(reason);
    expect(button('Open PDF').disabled).toBe(true);
    expect(button('Draft Email').disabled).toBe(true);
  });

  it.each([
    ['offline', 'Google Drive is offline'],
    ['blocked', 'Google Drive content changed; refresh before retrying'],
  ] as const)('blocks persistent actions while globally %s', (status, reason) => {
    const drive = driveState(status, {
      error: { message: reason, code: status === 'offline' ? 'offline' : 'conflict' } as any,
    });
    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain(reason);
    expect(button('Finalize PDF').disabled).toBe(true);
    expect(button('Preview PDF').disabled).toBe(false);
  });

  it('confirms finalization, then opens only the verified returned Drive file', async () => {
    const finalized = entry();
    const drive = driveState('ready', {
      finalize: vi.fn(async () => finalized),
      downloadVerified: vi.fn(async () => new Uint8Array([1, 2, 3])),
    });
    const deps = dependencies();
    render(<InvoicesTab {...(props({ drive, dependencies: deps }) as any)} />);

    await click(button('Finalize PDF'));
    await waitFor(() => expect(deps.openPdfBytes).toHaveBeenCalledOnce());

    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Finalize the invoice for Yoga'),
      expect.objectContaining({ title: 'Finalize invoice' })
    );
    expect(drive.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ key: { studioSlug: 'yoga', monthKey: '2026-07' } })
    );
    expect(drive.downloadVerified).toHaveBeenCalledWith(finalized);
    expect(deps.openPdfBytes).toHaveBeenCalledWith(finalized.filename, new Uint8Array([1, 2, 3]));
  });

  it('re-finalizes a stale Drive entry without allocating or changing its number', async () => {
    const stale = entry('stale');
    const refreshed = entry('fresh', { invoiceNumber: stale.invoiceNumber, file: stale.file });
    const drive = driveState('ready', {
      entries: [stale],
      refinalize: vi.fn(async () => refreshed),
    });
    const deps = dependencies();
    render(<InvoicesTab {...(props({ drive, dependencies: deps }) as any)} />);

    await click(button('Re-finalize PDF'));
    await waitFor(() => expect(drive.refinalize).toHaveBeenCalledOnce());

    expect(drive.refinalize).toHaveBeenCalledWith(expect.any(Object), stale);
    expect(drive.finalize).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('12/2026');
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
    await click(button('Open PDF'));
    await click(button('Draft Email'));
    await waitFor(() => expect(drive.downloadVerified).toHaveBeenCalledTimes(3));
  });

  it('renders and logs unkeyed scan warnings and blocking conflicts once per scan', () => {
    const drive = driveState('ready');
    drive.snapshot!.scan.warnings = ['Malformed finalized invoice filename: stray.pdf'];
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'global',
        kind: 'sequenceAmbiguity',
        message: 'Managed Drive file has no canonical invoice key',
      },
    ];
    const messages: string[] = [];
    const unsubscribe = subscribeLog((entries) => {
      messages.splice(0, messages.length, ...entries.map((item) => item.msg));
    });
    const view = render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain('Malformed finalized invoice filename: stray.pdf');
    expect(document.body.textContent).toContain('Managed Drive file has no canonical invoice key');
    expect(button('Finalize PDF').disabled).toBe(true);
    act(() => view.render(<InvoicesTab {...(props({ drive }) as any)} />));
    expect(
      messages.filter((message) =>
        message.includes('Malformed finalized invoice filename: stray.pdf')
      )
    ).toHaveLength(1);
    expect(
      messages.filter((message) =>
        message.includes('Managed Drive file has no canonical invoice key')
      )
    ).toHaveLength(1);
    unsubscribe();
  });

  it('keeps re-finalization and verified reads available during an unrelated scoped conflict', () => {
    const drive = driveState('ready', { entries: [entry('stale')] });
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'invoice',
        kind: 'corrupt',
        key: { studioSlug: 'studio-b', monthKey: '2026-07' },
        message: 'Unrelated managed Drive file is corrupt',
      },
    ];

    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain('Unrelated managed Drive file is corrupt');
    expect(button('Re-finalize PDF').disabled).toBe(false);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
  });

  it('blocks re-finalization for a matching scoped conflict', () => {
    const drive = driveState('ready', { entries: [entry('stale')] });
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'invoice',
        kind: 'corrupt',
        key: { studioSlug: 'yoga', monthKey: '2026-07' },
        message: 'Matching managed Drive file is corrupt',
      },
    ];

    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(button('Re-finalize PDF').disabled).toBe(true);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
  });

  it('shows a current-source build blocker and disables every persistent action', () => {
    const reason = 'Yoga 2026-07: invoice input contains unbillable classes';
    render(<InvoicesTab {...(props({ sourceError: reason }) as any)} />);

    expect(document.body.textContent).toContain(reason);
    expect(button('Finalize PDF').disabled).toBe(true);
    expect(button('Open PDF').disabled).toBe(true);
    expect(button('Draft Email').disabled).toBe(true);
  });

  it('shows historical Drive-only rows and the configured root with refresh and switch actions', async () => {
    const historical = entry('fresh', {
      key: { studioSlug: 'former-studio', monthKey: '2025-11' },
      file: { ...entry().file, id: 'historical' },
      filename: '3-2025-former-studio-2025-11.pdf',
      invoiceNumber: '3/2025',
    });
    const drive = driveState('ready', { entries: [historical] });
    render(<InvoicesTab {...(props({ classes: [], drive }) as any)} />);

    expect(document.body.textContent).toContain('former-studio');
    expect(document.body.textContent).toContain('3/2025');
    expect(document.body.textContent).toContain('Lotus Invoices');
    await click(button('Refresh Drive'));
    expect(drive.refresh).toHaveBeenCalledOnce();
    expect(button('Change Drive folder…').disabled).toBe(false);
  });

  it('resolves a historical Drive-only slug to one configured studio for display and email', async () => {
    const historical = entry('fresh', {
      key: { studioSlug: 'former-studio', monthKey: '2025-11' },
      file: { ...entry().file, id: 'historical-resolved' },
      filename: '3-2025-former-studio-2025-11.pdf',
      invoiceNumber: '3/2025',
    });
    const resolvedConfig: AppConfig = {
      ...config,
      studios: {
        'Former Studio': {
          fullName: 'Former Studio GmbH',
          address: '',
          invoiceEmail: 'former@example.com',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
        },
      },
    };
    const deps = dependencies();
    render(
      <InvoicesTab
        {...(props({
          classes: [],
          config: resolvedConfig,
          drive: driveState('ready', { entries: [historical] }),
          dependencies: deps,
        }) as any)}
      />
    );

    expect(document.body.textContent).toContain('Former Studio');
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
    await click(button('Draft Email'));
    await waitFor(() =>
      expect(deps.createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'former@example.com' })
      )
    );
  });

  it('keeps verified historical bytes openable but explicitly blocks ambiguous config actions', () => {
    const historical = entry('fresh', {
      key: { studioSlug: 'former-studio', monthKey: '2025-11' },
      filename: '3-2025-former-studio-2025-11.pdf',
      invoiceNumber: '3/2025',
    });
    const studio = {
      fullName: 'Former Studio',
      address: '',
      invoiceEmail: 'former@example.com',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
    };
    const ambiguousConfig: AppConfig = {
      ...config,
      studios: { 'Former Studio': studio, 'Former-Studio': studio },
    };
    render(
      <InvoicesTab
        {...(props({
          classes: [],
          config: ambiguousConfig,
          drive: driveState('ready', { entries: [historical] }),
        }) as any)}
      />
    );

    expect(document.body.textContent).toContain(
      'Drive slug "former-studio" matches multiple configured studios'
    );
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(true);
  });

  it('keeps a historical PDF openable when no studio matches and blocks only config actions', () => {
    const historical = entry('fresh', {
      key: { studioSlug: 'unknown-studio', monthKey: '2025-11' },
      filename: '3-2025-unknown-studio-2025-11.pdf',
      invoiceNumber: '3/2025',
    });
    render(
      <InvoicesTab
        {...(props({ classes: [], drive: driveState('ready', { entries: [historical] }) }) as any)}
      />
    );

    expect(document.body.textContent).toContain(
      'No configured studio matches Drive slug "unknown-studio".'
    );
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(true);
    expect(button('Preview PDF').disabled).toBe(true);
    expect(button('Finalize PDF').disabled).toBe(true);
  });

  it('does not open the folder dialog when Drive authorization fails', async () => {
    const reason = 'Google authorization was denied';
    render(
      <InvoicesTab
        {...(props({
          drive: driveState('authorizationRequired'),
          onAuthorizeDrive: vi.fn(async () => {
            throw new Error(reason);
          }),
        }) as any)}
      />
    );

    await click(button('Choose Drive folder'));
    await waitFor(() => expect(document.body.textContent).toContain(reason));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a row-scoped operation indicator from the controller operation key', () => {
    render(
      <InvoicesTab
        {...(props({
          drive: driveState('ready', { operationKey: 'finalize:yoga:2026-07' }),
        }) as any)}
      />
    );

    expect(document.body.textContent).toContain('Finalizing…');
    expect(button('Preview PDF').disabled).toBe(true);
  });
});
