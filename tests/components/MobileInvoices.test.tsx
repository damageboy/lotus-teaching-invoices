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

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
  return { root, container };
}

function button(name: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (!target) throw new Error(`Missing button: ${name}`);
  return target;
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
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
  throw lastError;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
afterAll(() => restoreEnvironment());

const { InvoicesTab } = await import('../../src/components/InvoicesTab/index.js');

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: 'calendar-a',
  outputDir: '/ignored-local-output',
  lastInvoice: '6/2026',
  studios: {
    'Test Studio': {
      fullName: 'Test Studio',
      address: '',
      invoiceEmail: 'studio@example.com',
      rateTiers: [{ minStudents: 1, maxStudents: null, rate: 55 }],
    },
  },
};

const lesson: ParsedClass = {
  eventIdentity: { calendarId: 'calendar-a', eventId: 'event-1' },
  sourceSummary: 'Test Studio / Flow',
  sourceDescription: '2',
  studioName: 'Test Studio',
  classType: 'Flow',
  date: '2026-07-03',
  startTime: '10:00',
  endTime: '11:00',
  studentCount: 2,
};

function driveEntry(
  state: DriveInvoiceEntry['state'] = 'fresh',
  overrides: Partial<DriveInvoiceEntry> = {}
): DriveInvoiceEntry {
  return {
    key: { studioSlug: 'test-studio', monthKey: '2026-07' },
    file: {
      id: 'pdf-1',
      name: '7-2026-test-studio-2026-07.pdf',
      mimeType: 'application/pdf',
      parents: ['final'],
      driveId: null,
      ownedByMe: true,
      trashed: false,
      version: '1',
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
      etag: '"v1"',
    },
    filename: '7-2026-test-studio-2026-07.pdf',
    invoiceNumber: '7/2026',
    state,
    sourceSha256: 'b'.repeat(64),
    pdfSha256: 'a'.repeat(64),
    message: state === 'fresh' ? null : `Drive state: ${state}`,
    ...overrides,
  };
}

function driveState(
  status: DriveInvoicesState['status'],
  entries: DriveInvoiceEntry[] = [],
  overrides: Partial<DriveInvoicesState> = {}
): DriveInvoicesState {
  return {
    status,
    snapshot:
      status === 'ready'
        ? ({
            stagedRoot: { root: { folderId: 'root', driveId: null, folderName: 'Mobile Root' } },
            scan: { entries, warnings: [], blockingConflicts: [], maxSequenceByYear: {} },
          } as DriveInvoicesState['snapshot'])
        : null,
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => {}),
    activateRoot: vi.fn(async () => {}),
    finalize: vi.fn(async () => driveEntry()),
    refinalize: vi.fn(async () => driveEntry()),
    recoverReservation: vi.fn(async () => {}),
    downloadVerified: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    ...overrides,
  };
}

function deps() {
  return {
    generateAndOpenPdf: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    openPdfBytes: vi.fn(async () => ({ status: 'opened' as const })),
    createGmailDraft: vi.fn(async () => {}),
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    layout: 'mobile',
    classes: [lesson],
    config,
    activeFreshness: [],
    activeFreshnessContext: null,
    freshnessVerified: true,
    onAcknowledgeFreshnessClear: vi.fn(),
    onRefreshFreshness: vi.fn(async () => {}),
    drive: driveState('ready'),
    dependencies: deps(),
    ...overrides,
  };
}

describe('mobile Drive invoice view', () => {
  it('offers app-driven recovery only for a durable reservation error', async () => {
    const ready = driveState('ready');
    const drive = driveState('blocked', [], {
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

  it.each(['desktop', 'mobile'] as const)(
    'renders no invoice content when Drive is unconfigured on %s',
    (layout) => {
      const { container } = render(
        <InvoicesTab {...(props({ layout, drive: driveState('unconfigured') }) as any)} />
      );
      expect(container.innerHTML).toBe('');
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.querySelector('table')).toBeNull();
      expect(document.body.textContent).not.toContain('Choose Drive');
    }
  );

  it('shows the Drive invoice number and only opens verified bytes', async () => {
    const finalized = driveEntry();
    const drive = driveState('ready', [finalized]);
    const dependencies = deps();
    render(<InvoicesTab {...(props({ drive, dependencies }) as any)} />);

    expect(document.body.textContent).toContain('7/2026');
    expect(document.body.textContent).toContain('Finalized');
    await click(button('Open PDF'));
    await waitFor(() => expect(dependencies.openPdfBytes).toHaveBeenCalledOnce());
    expect(drive.downloadVerified).toHaveBeenCalledWith(finalized);
    expect(dependencies.generateAndOpenPdf).not.toHaveBeenCalled();
  });

  it('shows the exact stale reason and re-finalizes through the controller', async () => {
    const stale = driveEntry('stale', { message: 'Calendar or billing data changed' });
    const drive = driveState('ready', [stale]);
    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain('Calendar or billing data changed');
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
    await click(button('Re-finalize PDF'));
    await waitFor(() => expect(drive.refinalize).toHaveBeenCalledOnce());
    expect(drive.refinalize).toHaveBeenCalledWith(expect.any(Object), stale);
  });

  it('keeps verified mobile read actions enabled but disables re-finalization without edit permission', async () => {
    const readOnly = driveEntry('stale', { message: 'Calendar or billing data changed' });
    readOnly.file.capabilities.canEdit = false;
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const drive = driveState('ready', [readOnly], {
      downloadVerified: vi.fn(async () => bytes),
    });
    const dependencies = deps();
    render(<InvoicesTab {...(props({ drive, dependencies }) as any)} />);

    expect(button('Re-finalize PDF').disabled).toBe(true);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);

    await click(button('Open PDF'));
    await waitFor(() =>
      expect(dependencies.openPdfBytes).toHaveBeenCalledWith(readOnly.filename, bytes)
    );
    await click(button('Draft Email'));
    await waitFor(() => expect(dependencies.createGmailDraft).toHaveBeenCalledOnce());

    expect(drive.downloadVerified).toHaveBeenCalledTimes(2);
    expect(drive.refinalize).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Edit access is required to re-finalize');
  });

  it('shows scan warnings and blocking conflicts that have no invoice row key', () => {
    const drive = driveState('ready');
    drive.snapshot!.scan.warnings = ['Malformed finalized invoice filename: mobile-stray.pdf'];
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'global',
        kind: 'sequenceAmbiguity',
        message: 'Managed mobile Drive file has no invoice key',
      },
    ];

    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain(
      'Malformed finalized invoice filename: mobile-stray.pdf'
    );
    expect(document.body.textContent).toContain('Managed mobile Drive file has no invoice key');
  });

  it('keeps re-finalization and verified reads available during an unrelated scoped conflict', () => {
    const drive = driveState('ready', [driveEntry('stale')]);
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'invoice',
        kind: 'corrupt',
        key: { studioSlug: 'studio-b', monthKey: '2026-07' },
        message: 'Unrelated managed mobile file is corrupt',
      },
    ];

    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(document.body.textContent).toContain('Unrelated managed mobile file is corrupt');
    expect(button('Re-finalize PDF').disabled).toBe(false);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
  });

  it('blocks re-finalization for a matching scoped conflict', () => {
    const drive = driveState('ready', [driveEntry('stale')]);
    drive.snapshot!.scan.blockingConflicts = [
      {
        scope: 'invoice',
        kind: 'corrupt',
        key: { studioSlug: 'test-studio', monthKey: '2026-07' },
        message: 'Matching managed mobile file is corrupt',
      },
    ];

    render(<InvoicesTab {...(props({ drive }) as any)} />);

    expect(button('Re-finalize PDF').disabled).toBe(true);
    expect(button('Open PDF').disabled).toBe(false);
    expect(button('Draft Email').disabled).toBe(false);
  });

  it('keeps permission and conflict failures inside the affected card', () => {
    const permission = driveEntry('permission', { message: 'Cannot download Drive PDF' });
    render(
      <InvoicesTab
        {...(props({
          drive: driveState('ready', [permission], {
            error: { code: 'conflict', message: 'Another device changed this invoice' } as any,
          }),
        }) as any)}
      />
    );

    const card = document.querySelector<HTMLElement>('article');
    expect(card?.textContent).toContain('Cannot download Drive PDF');
    expect(document.body.textContent).toContain('Another device changed this invoice');
    expect(button('Open PDF').disabled).toBe(true);
  });

  it('renders historical Drive-only invoices and refreshes the remote view', async () => {
    const historical = driveEntry('fresh', {
      key: { studioSlug: 'former-studio', monthKey: '2025-11' },
      filename: '3-2025-former-studio-2025-11.pdf',
      invoiceNumber: '3/2025',
    });
    const drive = driveState('ready', [historical]);
    render(<InvoicesTab {...(props({ classes: [], drive }) as any)} />);

    expect(document.body.textContent).toContain('former-studio');
    expect(document.body.textContent).toContain('3/2025');
    await click(button('Refresh Drive'));
    expect(drive.refresh).toHaveBeenCalledOnce();
  });
});
