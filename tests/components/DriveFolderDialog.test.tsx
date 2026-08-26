import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DriveFolderPage,
  DriveLocation,
  StagedDriveRoot,
} from '../../src/lib/drive/folders.js';
import type { DriveInvoiceEntry, DriveInvoiceScan } from '../../src/lib/drive/invoiceCatalog.js';
import type { DriveFileRecord } from '../../src/lib/drive/types.js';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';

const restoreDom = installReactTestEnvironment();
Object.defineProperties(window.HTMLElement.prototype, {
  attachEvent: { configurable: true, value: () => {} },
  detachEvent: { configurable: true, value: () => {} },
});
afterAll(() => restoreDom());
const { DriveFolderDialog } = await import('../../src/components/InvoicesTab/DriveFolderDialog.js');

const roots: Array<{ root: Root; container: HTMLElement }> = [];

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
  return {
    rerender(next: ReactNode) {
      act(() => root.render(next));
    },
  };
}

function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return label.trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  if (element.tagName === 'INPUT') {
    return (element.closest('label')?.textContent ?? '').trim();
  }
  return (element.textContent ?? '').trim();
}

function roleElements(root: ParentNode, role: string): HTMLElement[] {
  const selector =
    role === 'button'
      ? 'button'
      : role === 'textbox'
        ? 'input[type="text"], input:not([type])'
        : role === 'navigation'
          ? 'nav, [role="navigation"]'
          : `[role="${role}"]`;
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

function queryRole(root: ParentNode, role: string, name?: string): HTMLElement | null {
  return (
    roleElements(root, role).find(
      (element) => name === undefined || accessibleName(element) === name
    ) ?? null
  );
}

function getRole(root: ParentNode, role: string, name?: string): HTMLElement {
  const element = queryRole(root, role, name);
  if (element === null) throw new Error(`Missing ${role}${name === undefined ? '' : ` ${name}`}`);
  return element;
}

function queryText(root: ParentNode, text: string): HTMLElement | null {
  const elements = [...root.querySelectorAll<HTMLElement>('*')];
  return (
    elements.find(
      (element) =>
        (element.textContent ?? '').trim() === text &&
        ![...element.children].some((child) => (child.textContent ?? '').trim() === text)
    ) ?? null
  );
}

async function waitFor<T>(assertion: () => T | Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

const screen = {
  getByRole(role: string, options: { name?: string } = {}) {
    return getRole(document, role, options.name);
  },
  queryByRole(role: string, options: { name?: string } = {}) {
    return queryRole(document, role, options.name);
  },
  findByRole(role: string, options: { name?: string } = {}) {
    return waitFor(() => getRole(document, role, options.name));
  },
  getByText(text: string) {
    const element = queryText(document, text);
    if (element === null) throw new Error(`Missing text ${text}`);
    return element;
  },
  queryByText(text: string) {
    return queryText(document, text);
  },
  findByText(text: string) {
    return waitFor(() => {
      const element = queryText(document, text);
      if (element === null) throw new Error(`Missing text ${text}`);
      return element;
    });
  },
};

function within(root: ParentNode) {
  return {
    getByRole(role: string, options: { name?: string } = {}) {
      return getRole(root, role, options.name);
    },
    getByText(text: string) {
      const element = queryText(root, text);
      if (element === null) throw new Error(`Missing text ${text}`);
      return element;
    },
  };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

const userEvent = {
  setup: () => ({ click }),
};

const fireEvent = {
  keyDown(target: Document, init: { key: string }) {
    const eventWindow = target.defaultView;
    if (eventWindow === null) throw new Error('Document has no window');
    act(() => target.dispatchEvent(new eventWindow.KeyboardEvent('keydown', init)));
  },
};

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const inputWindow = input.ownerDocument.defaultView;
  if (inputWindow === null) throw new Error('Input has no owning window');
  const setter = Object.getOwnPropertyDescriptor(
    inputWindow.HTMLInputElement.prototype,
    'value'
  )?.set;
  if (setter === undefined) throw new Error('Input value setter is unavailable');
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new inputWindow.Event('input', { bubbles: true }));
    input.dispatchEvent(new inputWindow.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

function folder(
  id: string,
  name: string,
  overrides: Partial<DriveFileRecord> = {}
): DriveFileRecord {
  return {
    id,
    name,
    mimeType: FOLDER_MIME_TYPE,
    parents: ['root'],
    driveId: null,
    ownedByMe: true,
    trashed: false,
    version: '1',
    size: null,
    md5Checksum: null,
    sha256Checksum: null,
    properties: {},
    capabilities: {
      canListChildren: true,
      canAddChildren: true,
      canEdit: true,
      canDownload: false,
    },
    etag: '"folder-etag"',
    ...overrides,
  };
}

function invoiceEntry(state: DriveInvoiceEntry['state'], id: string): DriveInvoiceEntry {
  return {
    key:
      state === 'malformed' || state === 'corrupt'
        ? null
        : { studioSlug: `studio-${id}`, monthKey: '2026-08' },
    file: {
      ...folder(id, `${id}.pdf`),
      mimeType: 'application/pdf',
      size: '4',
      capabilities: {
        canListChildren: false,
        canAddChildren: false,
        canEdit: state !== 'permission',
        canDownload: state !== 'permission',
      },
    },
    filename: `${id}.pdf`,
    invoiceNumber: state === 'malformed' ? null : '3/2026',
    state,
    sourceSha256: null,
    pdfSha256: null,
    message: state === 'fresh' ? null : `${state} invoice`,
  };
}

function scan(
  entries: DriveInvoiceEntry[] = [
    invoiceEntry('fresh', 'a'),
    invoiceEntry('fresh', 'b'),
    invoiceEntry('stale', 'c'),
  ],
  overrides: Partial<DriveInvoiceScan> = {}
): DriveInvoiceScan {
  return {
    entries,
    warnings: [],
    blockingConflicts: [],
    maxSequenceByYear: { '2026': 3 },
    ...overrides,
  };
}

const myDrive: DriveLocation = {
  kind: 'myDrive',
  id: 'root',
  name: 'My Drive',
  driveId: null,
};
const sharedDriveA: DriveLocation = {
  kind: 'sharedDrive',
  id: 'shared-a',
  name: 'Shared Drive A',
  driveId: 'shared-a',
};
const sharedDriveB: DriveLocation = {
  kind: 'sharedDrive',
  id: 'shared-b',
  name: 'Shared Drive B',
  driveId: 'shared-b',
};
const sharedInvoices = folder('shared-invoices', '2026 Invoices', {
  parents: ['shared-a'],
  driveId: 'shared-a',
  ownedByMe: false,
});
const stagedShared: StagedDriveRoot = {
  root: {
    folderId: sharedInvoices.id,
    driveId: 'shared-a',
    folderName: sharedInvoices.name,
  },
  rootFile: sharedInvoices,
  finalFolder: folder('final-a', 'Final', {
    parents: [sharedInvoices.id],
    driveId: 'shared-a',
    ownedByMe: false,
  }),
};

type FolderService = React.ComponentProps<typeof DriveFolderDialog>['folderService'];

function serviceDouble(overrides: Partial<FolderService> = {}): FolderService {
  return {
    listLocations: vi.fn(async () => [myDrive, sharedDriveA, sharedDriveB]),
    listChildren: vi.fn(async (location: DriveLocation, parentId: string) => {
      if (location.id === 'shared-a' && parentId === 'shared-a') {
        return { folders: [sharedInvoices], nextPageToken: null };
      }
      return { folders: [], nextPageToken: null };
    }),
    createChild: vi.fn(async () => folder('created', 'Created')),
    stageRoot: vi.fn(async () => stagedShared),
    ...overrides,
  };
}

function dialogProps(
  overrides: Partial<React.ComponentProps<typeof DriveFolderDialog>> = {}
): React.ComponentProps<typeof DriveFolderDialog> {
  return {
    open: true,
    layout: 'desktop',
    currentRoot: null,
    folderService: serviceDouble(),
    scanCandidate: vi.fn(async () => scan()),
    onConfirm: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...overrides,
  };
}

async function enterSharedCandidate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Shared Drive A' }));
  await user.click(await screen.findByRole('button', { name: '2026 Invoices' }));
}

describe('DriveFolderDialog', () => {
  it('stages a Shared Drive root and passes the legacy seed only after explicit activation', async () => {
    const user = userEvent.setup({ document });
    const onConfirm = vi.fn(async () => {});
    render(
      <DriveFolderDialog
        {...dialogProps({
          currentRoot: {
            folderId: 'old-root',
            driveId: null,
            folderName: 'Old Invoices',
          },
          legacyLastInvoice: '8/2026',
          onConfirm,
        })}
      />
    );

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(await screen.findByText('3 recognized invoices')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Activating this folder changes the invoice view on every device signed into this Google account. Files are not moved or deleted.'
      )
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));
    expect(onConfirm).toHaveBeenCalledWith(stagedShared, '8/2026');
  });

  it('does not present activation as cancellable after the remote confirmation starts', async () => {
    const user = userEvent.setup({ document });
    const pending = deferred<void>();
    const onConfirm = vi.fn(async () => pending.promise);
    const onClose = vi.fn();
    render(<DriveFolderDialog {...dialogProps({ onConfirm, onClose })} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await screen.findByText('3 recognized invoices');
    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    pending.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('ignores a successful activation from a closed session after reopening and confirming again', async () => {
    const user = userEvent.setup({ document });
    const oldActivation = deferred<void>();
    const newActivation = deferred<void>();
    let activationNumber = 0;
    const onConfirm = vi.fn(() => {
      activationNumber += 1;
      return activationNumber === 1 ? oldActivation.promise : newActivation.promise;
    });
    const onClose = vi.fn();
    const props = dialogProps({ onConfirm, onClose });
    const view = render(<DriveFolderDialog {...props} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await screen.findByText('3 recognized invoices');
    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));

    view.rerender(<DriveFolderDialog {...props} open={false} />);
    view.rerender(<DriveFolderDialog {...props} open />);
    await screen.findByRole('button', { name: 'Shared Drive A' });
    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await screen.findByText('3 recognized invoices');
    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));

    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );

    await act(async () => {
      oldActivation.resolve();
      await oldActivation.promise;
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activating…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('ignores a failed activation from a closed session after reopening and confirming again', async () => {
    const user = userEvent.setup({ document });
    const oldActivation = deferred<void>();
    const newActivation = deferred<void>();
    let activationNumber = 0;
    const onConfirm = vi.fn(() => {
      activationNumber += 1;
      return activationNumber === 1 ? oldActivation.promise : newActivation.promise;
    });
    const onClose = vi.fn();
    const props = dialogProps({ onConfirm, onClose });
    const view = render(<DriveFolderDialog {...props} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await screen.findByText('3 recognized invoices');
    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));

    view.rerender(<DriveFolderDialog {...props} open={false} />);
    view.rerender(<DriveFolderDialog {...props} open />);
    await screen.findByRole('button', { name: 'Shared Drive A' });
    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await screen.findByText('3 recognized invoices');
    await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));

    expect(onConfirm).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldActivation.reject(new Error('old activation failed'));
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('old activation failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Activating…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('shows every returned Drive location and pages folder results without losing earlier folders', async () => {
    const user = userEvent.setup({ document });
    const first = folder('first', 'First invoices');
    const later = folder('later', 'Later invoices');
    const listChildren = vi.fn(
      async (
        _location: DriveLocation,
        _parentId: string,
        pageToken?: string
      ): Promise<DriveFolderPage> =>
        pageToken === 'page-2'
          ? { folders: [later], nextPageToken: null }
          : { folders: [first], nextPageToken: 'page-2' }
    );
    render(
      <DriveFolderDialog {...dialogProps({ folderService: serviceDouble({ listChildren }) })} />
    );

    expect(await screen.findByRole('button', { name: 'My Drive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shared Drive A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shared Drive B' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'My Drive' }));
    expect(await screen.findByRole('button', { name: 'First invoices' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load more folders' }));

    expect(screen.getByRole('button', { name: 'First invoices' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Later invoices' })).toBeTruthy();
    expect(listChildren).toHaveBeenLastCalledWith(myDrive, 'root', 'page-2');
  });

  it('navigates back and through breadcrumbs using folder IDs as the service authority', async () => {
    const user = userEvent.setup({ document });
    const parent = folder('parent-id', 'Parent', { parents: ['root'] });
    const child = folder('child-id', 'Child', { parents: ['parent-id'] });
    const listChildren = vi.fn(
      async (_location: DriveLocation, parentId: string): Promise<DriveFolderPage> => ({
        folders: parentId === 'root' ? [parent] : parentId === parent.id ? [child] : [],
        nextPageToken: null,
      })
    );
    render(
      <DriveFolderDialog {...dialogProps({ folderService: serviceDouble({ listChildren }) })} />
    );

    await user.click(await screen.findByRole('button', { name: 'My Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Parent' }));
    await user.click(await screen.findByRole('button', { name: 'Child' }));

    const breadcrumbs = screen.getByRole('navigation', { name: 'Drive folder path' });
    expect(within(breadcrumbs).getByRole('button', { name: 'My Drive' })).toBeTruthy();
    expect(within(breadcrumbs).getByRole('button', { name: 'Parent' })).toBeTruthy();
    expect(within(breadcrumbs).getByText('Child')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Child' })).toBeTruthy();
    await user.click(within(breadcrumbs).getByRole('button', { name: 'Drive locations' }));
    expect(await screen.findByRole('button', { name: 'Shared Drive A' })).toBeTruthy();
  });

  it('validates a new folder name before creating and opens the created folder', async () => {
    const user = userEvent.setup({ document });
    const created = folder('created-id', 'August Invoices', { parents: ['root'] });
    const createChild = vi.fn(async () => created);
    render(
      <DriveFolderDialog {...dialogProps({ folderService: serviceDouble({ createChild }) })} />
    );

    await user.click(await screen.findByRole('button', { name: 'My Drive' }));
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    await changeInput(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(screen.getByText('Enter a folder name.')).toBeTruthy();
    expect(createChild).not.toHaveBeenCalled();

    await changeInput(input, '  August Invoices  ');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));

    await waitFor(() =>
      expect(createChild).toHaveBeenCalledWith(myDrive, 'root', 'August Invoices')
    );
    expect(await screen.findByText('August Invoices')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it.each([
    'Selected Drive root contains multiple direct Final folders',
    'Selected Drive folder cannot add children',
  ])('keeps a staging blocker visible without scanning or activating: %s', async (message) => {
    const user = userEvent.setup({ document });
    const scanCandidate = vi.fn(async () => scan());
    const onConfirm = vi.fn(async () => {});
    const stageRoot = vi.fn(async () => {
      throw new Error(message);
    });
    render(
      <DriveFolderDialog
        {...dialogProps({
          folderService: serviceDouble({ stageRoot }),
          scanCandidate,
          onConfirm,
        })}
      />
    );

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(scanCandidate).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Activate for all devices' })).toBeNull();
  });

  it('reports scan categories and disables activation for duplicate, corrupt, and permission blockers', async () => {
    const user = userEvent.setup({ document });
    const entries = [
      invoiceEntry('fresh', 'fresh'),
      invoiceEntry('malformed', 'malformed'),
      invoiceEntry('duplicate', 'duplicate'),
      invoiceEntry('permission', 'permission'),
      invoiceEntry('corrupt', 'corrupt'),
    ];
    render(
      <DriveFolderDialog
        {...dialogProps({
          scanCandidate: vi.fn(async () =>
            scan(entries, {
              warnings: ['Malformed finalized invoice filename: malformed.pdf'],
              blockingConflicts: [
                {
                  scope: 'invoice',
                  kind: 'duplicate',
                  key: { studioSlug: 'studio-a', monthKey: '2026-08' },
                  message: 'Duplicate invoice studio-a 2026-08',
                },
                {
                  scope: 'invoice',
                  kind: 'permission',
                  key: { studioSlug: 'studio-b', monthKey: '2026-08' },
                  message: 'permission.pdf: missing update permission',
                },
                {
                  scope: 'invoice',
                  kind: 'corrupt',
                  key: { studioSlug: 'studio-c', monthKey: '2026-08' },
                  message: 'corrupt.pdf: checksum mismatch',
                },
              ],
            })
          ),
        })}
      />
    );

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(await screen.findByText('1 recognized invoice')).toBeTruthy();
    expect(screen.getByText('1 malformed file')).toBeTruthy();
    expect(screen.getByText('1 duplicate invoice')).toBeTruthy();
    expect(screen.getByText('1 permission problem')).toBeTruthy();
    expect(screen.getByText('1 corrupt file')).toBeTruthy();
    expect(screen.getByText('Malformed finalized invoice filename: malformed.pdf')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Activate for all devices',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it('refreshes the staged scan after manual copying and allows a warning-only candidate', async () => {
    const user = userEvent.setup({ document });
    const scanCandidate = vi
      .fn<() => Promise<DriveInvoiceScan>>()
      .mockResolvedValueOnce(
        scan([invoiceEntry('malformed', 'manual')], {
          warnings: ['Malformed finalized invoice filename: manual.pdf'],
        })
      )
      .mockResolvedValueOnce(
        scan([invoiceEntry('fresh', 'manual'), invoiceEntry('fresh', 'current')])
      );
    render(<DriveFolderDialog {...dialogProps({ scanCandidate })} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(await screen.findByText('1 malformed file')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Activate for all devices',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Refresh scan' }));
    expect(await screen.findByText('2 recognized invoices')).toBeTruthy();
    expect(screen.queryByText('Malformed finalized invoice filename: manual.pdf')).toBeNull();
    expect(scanCandidate).toHaveBeenCalledTimes(2);
  });

  it('blocks activation when a staged refresh can no longer verify the candidate', async () => {
    const user = userEvent.setup({ document });
    const scanCandidate = vi
      .fn<() => Promise<DriveInvoiceScan>>()
      .mockResolvedValueOnce(scan())
      .mockRejectedValueOnce(new Error('Drive permission changed'));
    const onConfirm = vi.fn(async () => {});
    render(<DriveFolderDialog {...dialogProps({ scanCandidate, onConfirm })} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(await screen.findByText('3 recognized invoices')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refresh scan' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Drive permission changed');
    const activate = screen.getByRole('button', { name: 'Activate for all devices' });
    expect((activate as HTMLButtonElement).disabled).toBe(true);
    await user.click(activate);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('starts a fresh browser after cancellation interrupts folder creation', async () => {
    const user = userEvent.setup({ document });
    const pending = deferred<DriveFileRecord>();
    const folderService = serviceDouble({
      createChild: vi.fn(async () => pending.promise),
    });
    const props = dialogProps({ folderService });
    const view = render(<DriveFolderDialog {...props} />);

    await user.click(await screen.findByRole('button', { name: 'My Drive' }));
    await changeInput(
      screen.getByRole('textbox', { name: 'New folder name' }) as HTMLInputElement,
      'New root'
    );
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeTruthy();

    view.rerender(<DriveFolderDialog {...props} open={false} />);
    view.rerender(<DriveFolderDialog {...props} open />);
    await user.click(await screen.findByRole('button', { name: 'My Drive' }));

    expect(
      (screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement).disabled
    ).toBe(false);
    pending.resolve(folder('ignored', 'Ignored'));
    await pending.promise;
  });

  it('cancels a staged root without confirming or changing the prior pointer', async () => {
    const user = userEvent.setup({ document });
    const onClose = vi.fn();
    const onConfirm = vi.fn(async () => {});
    const currentRoot = {
      folderId: 'old-root',
      driveId: null,
      folderName: 'Old Invoices',
    } as const;
    render(<DriveFolderDialog {...dialogProps({ currentRoot, onClose, onConfirm })} />);

    await enterSharedCandidate(user);
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(await screen.findByText('3 recognized invoices')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(currentRoot).toEqual({
      folderId: 'old-root',
      driveId: null,
      folderName: 'Old Invoices',
    });
  });

  it('renders an accessible mobile modal with 48-pixel controls and dismisses on Escape', async () => {
    const user = userEvent.setup({ document });
    const onClose = vi.fn();
    render(<DriveFolderDialog {...dialogProps({ layout: 'mobile', onClose })} />);

    const dialog = screen.getByRole('dialog', { name: 'Choose Drive invoice folder' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.click(await screen.findByRole('button', { name: 'My Drive' }));
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input')];
    expect(controls.length).toBeGreaterThan(0);
    expect(
      controls.every(
        (control) =>
          control.classList.contains('min-h-12') && control.classList.contains('min-w-12')
      )
    ).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders nothing while closed and does not browse Drive', () => {
    const folderService = serviceDouble();
    render(<DriveFolderDialog {...dialogProps({ open: false, folderService })} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(folderService.listLocations).not.toHaveBeenCalled();
  });
});
