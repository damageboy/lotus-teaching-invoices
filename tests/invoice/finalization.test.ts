import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import {
  parseLastInvoice,
  formatInvoiceNumber,
  studioSlug,
  previewFilename,
  finalizedFilename,
  extractInvoiceNumberFromFilename,
  matchesFinalizedInvoice,
} from '../../src/lib/invoice/finalization';

const sharedMocks = {
  invoke: vi.fn(),
};

vi.mock('@tauri-apps/api/core', () => ({ invoke: sharedMocks.invoke }));

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const {
  clearInvoiceFreshness,
  listActiveInvoiceFreshness,
  markInvoiceFreshness,
  prepareInvoiceEmail,
  prepareReFinalization,
  writeReFinalizedInvoice,
} = await import('../../src/lib/invoice/freshness.js');
const { useInvoiceFreshness } = await import('../../src/hooks/useInvoiceFreshness.js');
type InvoiceFreshnessRow = import('../../src/lib/invoice/freshness.js').InvoiceFreshnessRow;

function freshnessRow(overrides: Partial<InvoiceFreshnessRow> = {}): InvoiceFreshnessRow {
  return {
    key: {
      calendarId: 'calendar-a',
      outputDir: '/canonical/output-a',
      studioName: 'Yoga',
      monthKey: '2026-01',
    },
    invoiceNumber: '8/2026',
    finalFilename: '8-2026-yoga-2026-01.pdf',
    staleAt: '2026-08-15T12:00:00.000000000Z',
    reason: 'Lesson changed',
    clearedAt: null,
    revision: 1,
    lastOperationId: 'operation-a',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  sharedMocks.invoke.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  restoreDom();
});

describe('parseLastInvoice', () => {
  it('parses a valid string', () => {
    expect(parseLastInvoice('7/2026')).toEqual({ n: 7, year: 2026 });
  });
  it('returns null for empty string', () => {
    expect(parseLastInvoice('')).toBeNull();
  });
  it('returns null for invalid format', () => {
    expect(parseLastInvoice('abc')).toBeNull();
    expect(parseLastInvoice('7-2026')).toBeNull();
  });
});

describe('formatInvoiceNumber', () => {
  it('formats n and year correctly', () => {
    expect(formatInvoiceNumber(8, 2026)).toBe('8/2026');
  });
});

describe('studioSlug', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(studioSlug('Yoga Studio GmbH')).toBe('yoga-studio-gmbh');
  });
  it('strips leading and trailing hyphens', () => {
    expect(studioSlug('--Test--')).toBe('test');
  });
  it.each([
    ['Yoga Studio GmbH', 'yoga-studio-gmbh'],
    ['--Test--', 'test'],
    ['Bikram Yoga', 'bikram-yoga'],
    ['İ Yoga', 'i-yoga'],
    ['Crème & Co.', 'cr-me-co'],
  ])('matches the Rust cross-language fixture %j', (studio, expected) => {
    expect(studioSlug(studio)).toBe(expected);
  });
});

describe('previewFilename', () => {
  it('returns slug-year-month.pdf', () => {
    expect(previewFilename('Yoga Studio', '2026-01-01', '2026-01-31')).toBe(
      'yoga-studio-2026-01.pdf'
    );
  });
});

describe('finalizedFilename', () => {
  it('encodes invoice number at the start', () => {
    expect(finalizedFilename('yogibar', '2026', '01', '8/2026')).toBe('8-2026-yogibar-2026-01.pdf');
  });
});

describe('extractInvoiceNumberFromFilename', () => {
  it('extracts from a finalized filename', () => {
    expect(extractInvoiceNumberFromFilename('8-2026-yogibar-2026-01.pdf')).toBe('8/2026');
  });
  it('returns null for a preview filename', () => {
    expect(extractInvoiceNumberFromFilename('yogibar-2026-01.pdf')).toBeNull();
  });
});

describe('matchesFinalizedInvoice', () => {
  it('matches the correct studio/period', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      true
    );
  });
  it('does not match a different month', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-02.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
  it('does not match a different studio', () => {
    expect(matchesFinalizedInvoice('8-2026-other-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
  it('does not match a slug that is a suffix of another studio slug', () => {
    expect(matchesFinalizedInvoice('8-2026-bikram-yoga-2026-01.pdf', 'yoga', '2026', '01')).toBe(
      false
    );
  });
  it.each(['8-26-yoga-2026-01.pdf', '8-2026-yoga-2026-1.pdf', '8-2026-yoga-2026-01.pdf.bak'])(
    'rejects malformed finalized filename %s',
    (filename) => {
      expect(matchesFinalizedInvoice(filename, 'yoga', '2026', '01')).toBe(false);
    }
  );
});

describe('invoice freshness Tauri wrappers', () => {
  const key = {
    calendarId: 'calendar-a',
    outputDir: '/output',
    studioName: 'Yoga',
    monthKey: '2026-01',
  };

  it('uses the exact typed command boundary', async () => {
    const row = freshnessRow();
    const fileRevision = {
      sizeBytes: '3',
      modifiedUnixNanos: '1',
      deviceId: '2',
      fileId: '3',
      changedUnixNanos: '4',
      finalDirectoryDeviceId: '5',
      finalDirectoryFileId: '6',
    };
    const preparedReFinalization = {
      key,
      finalFilename: row.finalFilename,
      invoiceNumber: row.invoiceNumber,
      fileRevision,
      freshnessRevision: 1,
    };
    const preparedEmail = {
      key,
      finalFilename: row.finalFilename,
      invoiceNumber: row.invoiceNumber,
      fileRevision,
      pdfBytes: [0x70, 0x64, 0x66],
    };
    const writeRequest = {
      key,
      finalFilename: row.finalFilename,
      invoiceNumber: row.invoiceNumber,
      expectedFreshnessRevision: 1,
      expectedFileRevision: fileRevision,
      pdfBytes: [0x70, 0x64, 0x66],
    };
    const writeResult = {
      status: 'written' as const,
      outputPath: '/output/Final/8-2026-yoga-2026-01.pdf',
      filename: row.finalFilename,
    };
    sharedMocks.invoke
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce(preparedReFinalization)
      .mockResolvedValueOnce({ status: 'cleared', row: { ...row, revision: 2 } })
      .mockResolvedValueOnce(preparedEmail)
      .mockResolvedValueOnce(writeResult)
      .mockResolvedValueOnce(row);

    await expect(listActiveInvoiceFreshness('calendar-a', '/output')).resolves.toEqual([row]);
    await expect(prepareReFinalization(key, 1)).resolves.toEqual(preparedReFinalization);
    await clearInvoiceFreshness(key, 1);
    await expect(prepareInvoiceEmail(key)).resolves.toEqual(preparedEmail);
    await expect(writeReFinalizedInvoice(writeRequest)).resolves.toEqual(writeResult);
    await markInvoiceFreshness({
      key,
      invoiceNumber: row.invoiceNumber,
      finalFilename: row.finalFilename,
      reason: row.reason,
      operationId: row.lastOperationId,
    });

    expect(sharedMocks.invoke.mock.calls).toEqual([
      ['list_active_invoice_freshness', { calendarId: 'calendar-a', outputDir: '/output' }],
      ['prepare_re_finalization', { key, expectedRevision: 1 }],
      ['clear_invoice_freshness', { key, expectedRevision: 1 }],
      ['prepare_invoice_email', { key }],
      ['write_re_finalized_invoice', { request: writeRequest }],
      [
        'mark_invoice_freshness',
        {
          request: {
            key,
            invoiceNumber: row.invoiceNumber,
            finalFilename: row.finalFilename,
            reason: row.reason,
            operationId: row.lastOperationId,
          },
        },
      ],
    ]);
  });
});

describe('useInvoiceFreshness', () => {
  it('loads active rows and exposes an authoritative reload', async () => {
    const row = freshnessRow();
    const load = vi.fn().mockResolvedValue([row]);
    const { result } = renderHook(() => useInvoiceFreshness('calendar-a', '/output-a', load));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([row]);
    expect(result.current.loadedContext).toEqual({
      calendarId: 'calendar-a',
      outputDir: '/output-a',
    });
    expect(result.current.isCurrentContextVerified).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.reload();
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('preserves previous rows across a context switch and a failed replacement load', async () => {
    const rowA = freshnessRow();
    const pendingB = deferred<InvoiceFreshnessRow[]>();
    const load = vi.fn().mockResolvedValueOnce([rowA]).mockReturnValueOnce(pendingB.promise);
    const { result, rerender } = renderHook(
      ({ calendarId, outputDir }) => useInvoiceFreshness(calendarId, outputDir, load),
      { initialProps: { calendarId: 'calendar-a', outputDir: '/output-a' } }
    );
    await waitFor(() => expect(result.current.rows).toEqual([rowA]));

    rerender({ calendarId: 'calendar-b', outputDir: '/output-b' });
    expect(result.current.rows).toEqual([rowA]);
    expect(result.current.loadedContext).toEqual({
      calendarId: 'calendar-a',
      outputDir: '/output-a',
    });
    expect(result.current.isCurrentContextVerified).toBe(false);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pendingB.reject(new Error('freshness unavailable'));
      await pendingB.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([rowA]);
    expect(result.current.error).toBe('freshness unavailable');
  });

  it('removes only the acknowledged stale revision before a best-effort reload', async () => {
    const row = freshnessRow();
    const load = vi.fn().mockResolvedValue([row]);
    const { result } = renderHook(() => useInvoiceFreshness('calendar-a', '/output-a', load));
    await waitFor(() => expect(result.current.rows).toEqual([row]));

    act(() => result.current.acknowledgeClear(row.key, row.revision));
    expect(result.current.rows).toEqual([]);

    const newer = { ...row, revision: row.revision + 1 };
    sharedMocks.invoke.mockReset();
    const loadNewer = vi.fn().mockResolvedValue([newer]);
    const next = renderHook(() => useInvoiceFreshness('calendar-a', '/output-a', loadNewer));
    await waitFor(() => expect(next.result.current.rows).toEqual([newer]));
    act(() => next.result.current.acknowledgeClear(newer.key, row.revision));
    expect(next.result.current.rows).toEqual([newer]);
    next.unmount();
  });

  it('makes a saved reload callback a true no-op after its context is replaced', async () => {
    const rowA = freshnessRow();
    const rowB = freshnessRow({
      key: {
        calendarId: 'calendar-b',
        outputDir: '/canonical/output-b',
        studioName: 'Pilates',
        monthKey: '2026-02',
      },
    });
    const pendingB = deferred<InvoiceFreshnessRow[]>();
    const load = vi.fn().mockResolvedValueOnce([rowA]).mockReturnValueOnce(pendingB.promise);
    const { result, rerender } = renderHook(
      ({ calendarId, outputDir }) => useInvoiceFreshness(calendarId, outputDir, load),
      { initialProps: { calendarId: 'calendar-a', outputDir: '/output-a' } }
    );
    await waitFor(() => expect(result.current.rows).toEqual([rowA]));
    const reloadA = result.current.reload;

    rerender({ calendarId: 'calendar-b', outputDir: '/output-b' });
    expect(result.current.rows).toEqual([rowA]);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await reloadA();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.rows).toEqual([rowA]);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => pendingB.resolve([rowB]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([rowB]);
    expect(result.current.error).toBeNull();
  });

  it('ignores a previous-context reload rejection while the replacement load settles', async () => {
    const rowA = freshnessRow();
    const rowB = freshnessRow({
      key: {
        calendarId: 'calendar-b',
        outputDir: '/canonical/output-b',
        studioName: 'Pilates',
        monthKey: '2026-02',
      },
    });
    const pendingReloadA = deferred<InvoiceFreshnessRow[]>();
    const pendingB = deferred<InvoiceFreshnessRow[]>();
    const load = vi
      .fn()
      .mockResolvedValueOnce([rowA])
      .mockReturnValueOnce(pendingReloadA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const { result, rerender } = renderHook(
      ({ calendarId, outputDir }) => useInvoiceFreshness(calendarId, outputDir, load),
      { initialProps: { calendarId: 'calendar-a', outputDir: '/output-a' } }
    );
    await waitFor(() => expect(result.current.rows).toEqual([rowA]));

    let reloadA!: Promise<void>;
    act(() => {
      reloadA = result.current.reload();
    });
    rerender({ calendarId: 'calendar-b', outputDir: '/output-b' });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pendingReloadA.reject(new Error('stale A failure'));
      await reloadA;
    });
    expect(result.current.rows).toEqual([rowA]);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => pendingB.resolve([rowB]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([rowB]);
    expect(result.current.error).toBeNull();
  });

  it('ignores stale calendar requests and completions after unmount', async () => {
    const pendingA = deferred<InvoiceFreshnessRow[]>();
    const pendingB = deferred<InvoiceFreshnessRow[]>();
    const rowA = freshnessRow();
    const rowB = freshnessRow({
      key: {
        calendarId: 'calendar-b',
        outputDir: '/canonical/output-b',
        studioName: 'Pilates',
        monthKey: '2026-02',
      },
    });
    const load = vi
      .fn()
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const { result, rerender, unmount } = renderHook(
      ({ calendarId, outputDir }) => useInvoiceFreshness(calendarId, outputDir, load),
      { initialProps: { calendarId: 'calendar-a', outputDir: '/output-a' } }
    );

    rerender({ calendarId: 'calendar-b', outputDir: '/output-b' });
    await act(async () => pendingB.resolve([rowB]));
    await waitFor(() => expect(result.current.rows).toEqual([rowB]));
    await act(async () => pendingA.resolve([rowA]));
    expect(result.current.rows).toEqual([rowB]);

    const pendingReload = deferred<InvoiceFreshnessRow[]>();
    load.mockReturnValueOnce(pendingReload.promise);
    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = result.current.reload();
    });
    unmount();
    await act(async () => {
      pendingReload.resolve([rowA]);
      await reloadPromise;
    });
  });

  it.each([
    [undefined, '/output'],
    ['', '/output'],
    ['calendar', undefined],
    ['calendar', ''],
  ])('returns a safe empty state for missing input %#', (calendarId, outputDir) => {
    const load = vi.fn();
    const { result } = renderHook(() => useInvoiceFreshness(calendarId, outputDir, load));

    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
