import type { DriveInvoicesStatus } from '../../hooks/useDriveInvoices.js';
import type { DriveInvoiceEntry } from '../../lib/drive/invoiceCatalog.js';
import type { InvoiceRow } from '../../lib/invoice/rows.js';

export interface InvoiceActionAvailability {
  enabled: boolean;
  reason: string | null;
}

export interface InvoiceDisplayRow {
  row: InvoiceRow;
  rowKey: string;
  total: number | null;
  invoiceNumber: string | null;
  driveEntry: DriveInvoiceEntry | null;
  availability: {
    status: 'notFinalized' | 'fresh' | 'stale' | 'setup' | 'attention' | 'blocked';
    statusLabel: string;
    reasons: string[];
    preview: InvoiceActionAvailability;
    finalize: InvoiceActionAvailability;
    open: InvoiceActionAvailability;
    draftEmail: InvoiceActionAvailability;
  };
}

interface Props {
  displayRows: InvoiceDisplayRow[];
  driveStatus: DriveInvoicesStatus;
  globalMessages: readonly string[];
  operationKey: string | null;
  rowAction: string | null;
  rowErrors: Readonly<Record<string, string>>;
  onPreview: (row: InvoiceRow) => void;
  onFinalize: (row: InvoiceRow) => void;
  onOpen: (row: InvoiceRow) => void;
  onDraftEmail: (row: InvoiceRow) => void;
  onRefresh: () => void;
}

function classCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'class' : 'classes'}`;
}

function groupByMonth(displayRows: InvoiceDisplayRow[]): Array<[string, InvoiceDisplayRow[]]> {
  const groups = new Map<string, InvoiceDisplayRow[]>();
  for (const displayRow of displayRows) {
    const existing = groups.get(displayRow.row.monthKey);
    if (existing) existing.push(displayRow);
    else groups.set(displayRow.row.monthKey, [displayRow]);
  }
  return [...groups.entries()];
}

function statusClasses(status: InvoiceDisplayRow['availability']['status']): string {
  if (status === 'fresh') return 'bg-emerald-50 text-emerald-700';
  if (status === 'stale' || status === 'blocked') return 'bg-red-50 text-red-700';
  return 'bg-amber-50 text-amber-800';
}

function operationLabel(
  row: InvoiceRow,
  entry: DriveInvoiceEntry | null,
  operationKey: string | null,
  fallback: string
): string {
  if (operationKey === `finalize:${row.key.studioSlug}:${row.key.monthKey}`) return 'Finalizing…';
  if (entry !== null && operationKey === `refinalize:${entry.file.id}`) return 'Re-finalizing…';
  if (entry !== null && operationKey === `download:${entry.file.id}`) return 'Downloading…';
  return fallback;
}

export function MobileInvoices({
  displayRows,
  driveStatus,
  globalMessages,
  operationKey,
  rowAction,
  rowErrors,
  onPreview,
  onFinalize,
  onOpen,
  onDraftEmail,
  onRefresh,
}: Props) {
  const monthGroups = groupByMonth(displayRows);
  return (
    <div className="mobile-invoices p-4 flex flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={driveStatus === 'loading' || operationKey !== null}
          className="min-h-12 rounded border border-indigo-300 px-3 font-medium text-indigo-700 disabled:opacity-40"
        >
          Refresh Drive
        </button>
      </div>

      {globalMessages.map((message) => (
        <p
          key={message}
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {message}
        </p>
      ))}

      {monthGroups.length === 0 ? (
        <p className="py-8 text-center text-gray-400">No invoices</p>
      ) : (
        monthGroups.map(([monthKey, rows]) => (
          <section
            key={monthKey}
            aria-label={`${rows[0].row.label} invoices`}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-semibold text-gray-600">{rows[0].row.label}</h2>
            {rows.map(({ row, rowKey, total, invoiceNumber, driveEntry, availability }) => {
              const anotherActionRunning = operationKey !== null || rowAction !== null;
              const finalLabel = driveEntry?.state === 'stale' ? 'Re-finalize PDF' : 'Finalize PDF';
              return (
                <article
                  key={rowKey}
                  aria-label={`${row.studioName} invoice for ${row.label}`}
                  data-invoice-status={availability.status}
                  className="rounded-xl border border-indigo-100 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">{row.studioName}</h3>
                      <p className="text-sm text-gray-500">{row.label}</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${statusClasses(availability.status)}`}
                    >
                      {availability.statusLabel}
                    </span>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-gray-100 py-3 text-sm">
                    {invoiceNumber && (
                      <div>
                        <dt className="text-gray-500">Invoice #</dt>
                        <dd className="font-mono font-semibold text-gray-900">{invoiceNumber}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-gray-500">Classes</dt>
                      <dd className="font-semibold text-gray-900">
                        {classCountLabel(row.classCount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-500">Total</dt>
                      <dd className="font-mono font-semibold text-gray-900">
                        {total === null ? 'Unavailable' : `€${total.toFixed(2)}`}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-3 flex flex-col gap-2">
                    {availability.reasons.map((reason) => (
                      <p key={reason} className="text-sm text-amber-700">
                        {reason}
                      </p>
                    ))}
                    {rowErrors[rowKey] && (
                      <p role="alert" className="text-sm text-red-600">
                        {rowErrors[rowKey]}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => onFinalize(row)}
                      disabled={!availability.finalize.enabled || anotherActionRunning}
                      title={availability.finalize.reason ?? undefined}
                      className="min-h-12 w-full rounded bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-40"
                    >
                      {operationLabel(row, driveEntry, operationKey, finalLabel)}
                    </button>
                    <button
                      type="button"
                      onClick={() => onPreview(row)}
                      disabled={!availability.preview.enabled || anotherActionRunning}
                      title={availability.preview.reason ?? undefined}
                      className="min-h-12 w-full rounded border border-indigo-300 px-4 text-sm font-semibold text-indigo-700 disabled:opacity-40"
                    >
                      {rowAction === `preview:${rowKey}` ? 'Generating…' : 'Preview PDF'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpen(row)}
                      disabled={!availability.open.enabled || anotherActionRunning}
                      title={availability.open.reason ?? undefined}
                      className="min-h-12 w-full rounded border border-emerald-300 px-4 text-sm font-semibold text-emerald-800 disabled:opacity-40"
                    >
                      {rowAction === `open:${rowKey}` ? 'Opening…' : 'Open PDF'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDraftEmail(row)}
                      disabled={!availability.draftEmail.enabled || anotherActionRunning}
                      title={availability.draftEmail.reason ?? undefined}
                      className="min-h-12 w-full rounded border border-amber-300 px-4 text-sm font-semibold text-amber-800 disabled:opacity-40"
                    >
                      {rowAction === `draft:${rowKey}` ? 'Drafting…' : 'Draft Email'}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}
