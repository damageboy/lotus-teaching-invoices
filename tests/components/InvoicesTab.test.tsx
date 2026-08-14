import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import type { AppConfig, ParsedClass } from '../../src/lib/types.js';
import type { InvoiceFreshnessRow } from '../../src/lib/invoice/freshness.js';

const restoreEnvironment = installReactTestEnvironment();
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function render(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(ui));
}

function elementWithText(text: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>('*')].find(
    (element) => element.children.length === 0 && element.textContent?.trim() === text
  );
  if (!match) throw new Error(`Missing text: ${text}`);
  return match;
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void): Promise<void> {
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
  outputDir: '/output-a',
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

const stale: InvoiceFreshnessRow = {
  key: {
    calendarId: 'calendar-a',
    outputDir: '/output-a',
    studioName: 'Yoga',
    monthKey: '2025-11',
  },
  invoiceNumber: '42/2025',
  finalFilename: '42-2025-yoga-2025-11.pdf',
  staleAt: '2026-08-15T12:00:00Z',
  reason: 'Lesson changed',
  clearedAt: null,
  revision: 3,
  lastOperationId: 'operation-1',
};

const currentClass: ParsedClass = {
  eventIdentity: { calendarId: 'calendar-a', eventId: 'event-1' },
  sourceSummary: 'Yoga / Flow',
  sourceDescription: '2',
  studioName: 'Yoga',
  classType: 'Flow',
  date: '2025-11-03',
  startTime: '10:00',
  endTime: '11:00',
  studentCount: 2,
};

describe('InvoicesTab stale invoice status', () => {
  it('keeps a stale-only invoice visible and blocks unsafe actions', () => {
    render(
      <InvoicesTab
        classes={[]}
        config={config}
        activeFreshness={[stale]}
        activeFreshnessContext={{ calendarId: 'calendar-a', outputDir: '/output-a' }}
        freshnessVerified
        onAcknowledgeFreshnessClear={vi.fn()}
        onRefreshFreshness={vi.fn()}
        onSaveConfig={vi.fn()}
      />
    );

    expect(document.body.textContent).toContain('Yoga');
    expect(elementWithText('November 2025')).toBeTruthy();
    expect(elementWithText('Out of date')).toBeTruthy();
    expect(elementWithText('0')).toBeTruthy();
    expect(elementWithText('€0.00')).toBeTruthy();

    const refinalize = buttonWithText('Re-finalize Invoice…');
    expect(refinalize.disabled).toBe(false);

    const draft = buttonWithText('Draft Email…');
    expect(draft.disabled).toBe(true);
    expect(draft.title).toBe('Re-finalize the invoice first.');
  });

  it('re-finalizes with the recorded number and clears stale before opening', async () => {
    const fileRevision = {
      sizeBytes: '3',
      modifiedUnixNanos: '1',
      deviceId: '2',
      fileId: '3',
      changedUnixNanos: '4',
      finalDirectoryDeviceId: '5',
      finalDirectoryFileId: '6',
    };
    const dependencies = {
      confirm: vi.fn(async () => true),
      prepareReFinalization: vi.fn(async () => ({
        key: stale.key,
        finalFilename: stale.finalFilename,
        invoiceNumber: stale.invoiceNumber,
        fileRevision,
        freshnessRevision: stale.revision,
      })),
      renderFinalPdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
      writeReFinalizedInvoice: vi.fn(async () => ({
        status: 'written' as const,
        outputPath: '/output-a/Final/42-2025-yoga-2025-11.pdf',
        filename: stale.finalFilename,
      })),
      openPdf: vi.fn(async () => ({ status: 'opened' as const })),
      prepareInvoiceEmail: vi.fn(),
      createGmailDraft: vi.fn(),
    };
    const acknowledge = vi.fn();
    const refresh = vi.fn(async () => {});
    render(
      <InvoicesTab
        classes={[]}
        config={config}
        activeFreshness={[stale]}
        activeFreshnessContext={{ calendarId: 'calendar-a', outputDir: '/output-a' }}
        freshnessVerified
        dependencies={dependencies}
        onAcknowledgeFreshnessClear={acknowledge}
        onRefreshFreshness={refresh}
        onSaveConfig={vi.fn()}
      />
    );

    await click(buttonWithText('Re-finalize Invoice…'));
    await waitForAssertion(() => expect(dependencies.openPdf).toHaveBeenCalledOnce());

    expect(dependencies.prepareReFinalization).toHaveBeenCalledWith(stale.key, 3);
    expect(dependencies.renderFinalPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        studioName: 'Yoga',
        totalClasses: 0,
        totalAmount: 0,
      }),
      config,
      '42/2025'
    );
    expect(dependencies.writeReFinalizedInvoice).toHaveBeenCalledWith({
      key: stale.key,
      finalFilename: stale.finalFilename,
      invoiceNumber: stale.invoiceNumber,
      expectedFreshnessRevision: 3,
      expectedFileRevision: fileRevision,
      pdfBytes: [1, 2, 3],
    });
    expect(acknowledge).toHaveBeenCalledWith(stale.key, 3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(dependencies.writeReFinalizedInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0]!
    );
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.openPdf.mock.invocationCallOrder[0]!
    );
  });

  it('drafts email from the backend-verified invoice bytes', async () => {
    const dependencies = {
      confirm: vi.fn(),
      prepareReFinalization: vi.fn(),
      renderFinalPdf: vi.fn(),
      writeReFinalizedInvoice: vi.fn(),
      openPdf: vi.fn(),
      prepareInvoiceEmail: vi.fn(async () => ({
        key: stale.key,
        finalFilename: stale.finalFilename,
        invoiceNumber: stale.invoiceNumber,
        fileRevision: {
          sizeBytes: '3',
          modifiedUnixNanos: '1',
          deviceId: '2',
          fileId: '3',
          changedUnixNanos: '4',
          finalDirectoryDeviceId: '5',
          finalDirectoryFileId: '6',
        },
        pdfBytes: [0x70, 0x64, 0x66],
      })),
      createGmailDraft: vi.fn(async () => {}),
    };
    render(
      <InvoicesTab
        classes={[currentClass]}
        config={config}
        activeFreshness={[]}
        activeFreshnessContext={{ calendarId: 'calendar-a', outputDir: '/output-a' }}
        freshnessVerified
        dependencies={dependencies}
        onAcknowledgeFreshnessClear={vi.fn()}
        onRefreshFreshness={vi.fn()}
        onSaveConfig={vi.fn()}
      />
    );

    await click(buttonWithText('Draft Email…'));
    await waitForAssertion(() => expect(dependencies.createGmailDraft).toHaveBeenCalledOnce());

    expect(dependencies.prepareInvoiceEmail).toHaveBeenCalledWith({
      calendarId: 'calendar-a',
      outputDir: '/output-a',
      studioName: 'Yoga',
      monthKey: '2025-11',
    });
    expect(dependencies.createGmailDraft).toHaveBeenCalledWith({
      pdfBytes: new Uint8Array([0x70, 0x64, 0x66]),
      to: 'studio@example.com',
      subject: 'Invoice 42/2025 - Teacher',
      body: 'Please find attached the invoice for November 2025.',
      pdfFilename: stale.finalFilename,
    });
  });

  it('does not expose stale rows from a previous output-folder request', () => {
    render(
      <InvoicesTab
        classes={[]}
        config={{ ...config, outputDir: '/output-b' }}
        activeFreshness={[stale]}
        activeFreshnessContext={{ calendarId: 'calendar-a', outputDir: '/output-a' }}
        freshnessVerified={false}
        onAcknowledgeFreshnessClear={vi.fn()}
        onRefreshFreshness={vi.fn()}
        onSaveConfig={vi.fn()}
      />
    );

    expect(document.body.textContent).not.toContain('Out of date');
    expect(document.body.textContent).toContain('No classes loaded');
  });
});
