import React, { useEffect, useMemo, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { AppLayout } from '../../hooks/useCompactLayout.js';
import type { DriveInvoicesState } from '../../hooks/useDriveInvoices.js';
import type { DriveInvoiceConflict, DriveInvoiceEntry } from '../../lib/drive/invoiceCatalog.js';
import type { AppConfig, InvoicePeriod, ParsedClass } from '../../lib/types.js';
import { createGmailDraft } from '../../lib/gmail/drafts.js';
import { generateInvoice } from '../../lib/invoice/generator.js';
import { buildInvoiceRows, type InvoiceRow } from '../../lib/invoice/rows.js';
import { logError, logWarn } from '../../lib/logger.js';
import { generateAndOpenPdf, openPdfBytes, type OpenPdfResult } from '../../lib/pdf/generatePdf.js';
import {
  MobileInvoices,
  type InvoiceActionAvailability,
  type InvoiceDisplayRow,
} from './MobileInvoices.js';

export type { InvoiceDisplayRow } from './MobileInvoices.js';

export interface InvoiceActionDependencies {
  generateAndOpenPdf: typeof generateAndOpenPdf;
  confirm: typeof confirm;
  openPdfBytes: typeof openPdfBytes;
  createGmailDraft: typeof createGmailDraft;
}

const confirmInvoice: typeof confirm =
  import.meta.env.VITE_LOTUS_E2E === '1'
    ? async () => invoke<boolean>('e2e_confirm_invoice')
    : confirm;

const DEFAULT_DEPENDENCIES: InvoiceActionDependencies = {
  generateAndOpenPdf,
  confirm: confirmInvoice,
  openPdfBytes,
  createGmailDraft,
};

interface Props {
  layout?: AppLayout;
  classes: ParsedClass[];
  config: AppConfig;
  sourceError?: string | null;
  drive: DriveInvoicesState;
  dependencies?: Partial<InvoiceActionDependencies>;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function periodForMonthKey(monthKey: string): InvoicePeriod {
  const [year, month] = monthKey.split('-');
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return {
    from: `${year}-${month}-01`,
    to: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

function rowKey(row: InvoiceRow): string {
  return `${row.key.studioSlug}__${row.monthKey}`;
}

function action(reason: string | null): InvoiceActionAvailability {
  return { enabled: reason === null, reason };
}

function firstReason(...reasons: Array<string | null>): string | null {
  return reasons.find((reason): reason is string => reason !== null) ?? null;
}

function conflictAppliesToRow(conflict: DriveInvoiceConflict, row: InvoiceRow): boolean {
  return (
    conflict.scope === 'global' ||
    (conflict.key.studioSlug === row.key.studioSlug && conflict.key.monthKey === row.key.monthKey)
  );
}

function driveStatusReason(drive: DriveInvoicesState): string | null {
  switch (drive.status) {
    case 'ready':
      return null;
    case 'authorizationRequired':
      return drive.error?.message ?? 'Google Drive authorization is required.';
    case 'unconfigured':
      return 'Choose a Drive folder to use finalized invoice actions.';
    case 'loading':
      return 'Google Drive invoice status is loading.';
    case 'offline':
      return drive.error?.message ?? 'Google Drive is temporarily unavailable.';
    case 'blocked':
      return drive.error?.message ?? 'Google Drive invoice state is blocked.';
  }
}

function entryReason(entries: readonly DriveInvoiceEntry[]): string | null {
  if (entries.length > 1) {
    return entries[0]?.message ?? 'Multiple Drive files map to this studio and month.';
  }
  const entry = entries[0];
  if (entry === undefined || entry.state === 'fresh') return null;
  if (entry.state === 'stale') return entry.message ?? 'Drive invoice is out of date.';
  return entry.message ?? `Drive invoice is ${entry.state}.`;
}

function availabilityFor(
  row: InvoiceRow,
  total: number | null,
  config: AppConfig,
  drive: DriveInvoicesState,
  sourceError: string | null,
  mutationError: string | null
): InvoiceDisplayRow['availability'] {
  const studio = config.studios[row.studioName];
  const today = new Date().toISOString().slice(0, 10);
  const missingCount = row.classes.filter(
    (lesson) => lesson.studentCount === 0 && lesson.date < today
  ).length;
  const contentReason = firstReason(
    row.classes.length === 0 ? 'Current Calendar invoice input is unavailable.' : null,
    row.studioConfigReason,
    studio === undefined && row.studioConfigReason === null
      ? 'Studio configuration is unavailable.'
      : null,
    missingCount > 0
      ? `${missingCount} ${missingCount === 1 ? 'class is' : 'classes are'} missing a student count.`
      : null,
    total === null ? 'Invoice total is unavailable. Check studio rates and student counts.' : null
  );
  const globalReason = firstReason(sourceError, driveStatusReason(drive));
  const selected = row.driveEntries.length === 1 ? row.driveEntries[0] : null;
  const remoteReason = entryReason(row.driveEntries);
  const hasFresh = selected?.state === 'fresh';
  const hasStale = selected?.state === 'stale';
  const hasVerified = hasFresh || hasStale;
  const editReason =
    hasStale && selected !== null && !selected.file.capabilities.canEdit
      ? 'Edit access is required to re-finalize this Drive invoice.'
      : null;
  const downloadReason =
    hasVerified && selected !== null && !selected.file.capabilities.canDownload
      ? 'Download access is required to open or email this Drive invoice.'
      : null;
  const finalizeReason = firstReason(
    globalReason,
    mutationError,
    contentReason,
    editReason,
    selected !== null && !hasStale ? 'This invoice is already finalized.' : null,
    remoteReason !== null && !hasStale ? remoteReason : null
  );
  const openReason = firstReason(
    globalReason,
    downloadReason,
    hasVerified ? null : (remoteReason ?? 'No verified finalized Drive invoice is available.')
  );
  const draftReason = firstReason(
    openReason,
    row.studioConfigReason,
    studio?.invoiceEmail ? null : 'No invoice email configured.',
    config.calendarId ? null : 'Set a calendar in Settings before drafting email.'
  );
  const preview = action(contentReason);
  const finalize = action(finalizeReason);
  const open = action(openReason);
  const draftEmail = action(draftReason);
  const reasons = [
    preview.reason,
    finalize.reason,
    open.reason,
    draftEmail.reason,
    remoteReason,
  ].filter(
    (reason, index, all): reason is string => reason !== null && all.indexOf(reason) === index
  );

  let status: InvoiceDisplayRow['availability']['status'];
  let statusLabel: string;
  if (hasFresh) {
    status = 'fresh';
    statusLabel = 'Finalized';
  } else if (hasStale) {
    status = 'stale';
    statusLabel = 'Out of date';
  } else if (row.driveEntries.length > 0) {
    status = 'blocked';
    statusLabel = 'Blocked';
  } else if (contentReason !== null) {
    status = 'attention';
    statusLabel = 'Needs attention';
  } else if (globalReason !== null) {
    status = 'setup';
    statusLabel = 'Needs setup';
  } else {
    status = 'notFinalized';
    statusLabel = 'Not finalized';
  }

  return { status, statusLabel, reasons, preview, finalize, open, draftEmail };
}

export function InvoicesTab(props: Props) {
  const { drive } = props;
  if (
    drive.snapshot === null &&
    (drive.status === 'authorizationRequired' || drive.status === 'unconfigured')
  ) {
    return null;
  }
  return <InvoicesTabContent {...props} />;
}

function InvoicesTabContent({
  layout = 'desktop',
  classes,
  config,
  sourceError = null,
  drive,
  dependencies: dependencyOverrides,
}: Props) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const [rowAction, setRowAction] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const driveEntries = drive.snapshot?.scan.entries ?? [];
  const rows = useMemo(() => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    return buildInvoiceRows(classes, driveEntries, config).filter(
      (row) => row.monthKey <= currentMonth
    );
  }, [classes, config, driveEntries]);

  const displayRows = useMemo(
    () =>
      rows.map((row): InvoiceDisplayRow => {
        let total: number | null = null;
        const studio = config.studios[row.studioName];
        if (studio !== undefined) {
          try {
            total = generateInvoice(
              row.studioName,
              row.classes,
              studio,
              periodForMonthKey(row.monthKey)
            ).invoice.totalAmount;
          } catch {
            total = null;
          }
        }
        const selected = row.driveEntries.length === 1 ? row.driveEntries[0] : null;
        return {
          row,
          rowKey: rowKey(row),
          total,
          invoiceNumber: selected?.invoiceNumber ?? null,
          driveEntry: selected,
          availability: availabilityFor(
            row,
            total,
            config,
            drive,
            sourceError,
            drive.snapshot?.scan.blockingConflicts.find((conflict) =>
              conflictAppliesToRow(conflict, row)
            )?.message ?? null
          ),
        };
      }),
    [config, drive, rows, sourceError]
  );

  function setRowError(row: InvoiceRow, message: string | null): void {
    const key = rowKey(row);
    setRowErrors((current) => {
      if (message !== null) return { ...current, [key]: message };
      const { [key]: _removed, ...remaining } = current;
      return remaining;
    });
  }

  function inputFor(row: InvoiceRow) {
    const studio = config.studios[row.studioName];
    if (studio === undefined) throw new Error(`No config for studio "${row.studioName}"`);
    const invoice = generateInvoice(
      row.studioName,
      row.classes,
      studio,
      periodForMonthKey(row.monthKey)
    ).invoice;
    return { key: row.key, invoice, classes: row.classes, config };
  }

  async function runRowAction(
    row: InvoiceRow,
    actionKey: string,
    operation: () => Promise<void>
  ): Promise<void> {
    setRowAction(`${actionKey}:${rowKey(row)}`);
    setRowError(row, null);
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Drive invoice action failed for ${row.studioName}: ${message}`);
      setRowError(row, message);
    } finally {
      setRowAction(null);
    }
  }

  async function openVerified(row: InvoiceRow, entry: DriveInvoiceEntry): Promise<void> {
    const bytes = await drive.downloadVerified(entry);
    const opened: OpenPdfResult = await dependencies.openPdfBytes(entry.filename, bytes);
    if (opened.status === 'failed') throw new Error(opened.message);
  }

  function handlePreview(row: InvoiceRow): void {
    void runRowAction(row, 'preview', async () => {
      const { invoice } = inputFor(row);
      await dependencies.generateAndOpenPdf(invoice, config);
    });
  }

  function handleFinalize(row: InvoiceRow): void {
    void runRowAction(row, 'finalize', async () => {
      const selected = row.driveEntries.length === 1 ? row.driveEntries[0] : null;
      const stale = selected?.state === 'stale';
      const accepted = await dependencies.confirm(
        stale
          ? `Invoice ${selected.invoiceNumber ?? ''} is out of date. Re-finalize the invoice for ${row.studioName} and preserve its number?`
          : `Finalize the invoice for ${row.studioName} for ${row.label}?`,
        {
          title: stale ? 'Re-finalize invoice' : 'Finalize invoice',
          kind: 'warning',
        }
      );
      if (!accepted) return;
      const input = inputFor(row);
      const finalized = stale
        ? await drive.refinalize(input, selected)
        : await drive.finalize(input);
      await openVerified(row, finalized);
    });
  }

  function handleOpen(row: InvoiceRow): void {
    void runRowAction(row, 'open', async () => {
      const selected = row.driveEntries.length === 1 ? row.driveEntries[0] : null;
      if (selected?.state !== 'fresh' && selected?.state !== 'stale') {
        throw new Error('No verified Drive invoice is available');
      }
      await openVerified(row, selected);
    });
  }

  function handleDraftEmail(row: InvoiceRow): void {
    void runRowAction(row, 'draft', async () => {
      const selected = row.driveEntries.length === 1 ? row.driveEntries[0] : null;
      const studio = config.studios[row.studioName];
      if (selected?.state !== 'fresh' && selected?.state !== 'stale') {
        throw new Error('No verified Drive invoice is available');
      }
      if (!studio?.invoiceEmail) throw new Error('No invoice email configured.');
      const bytes = await drive.downloadVerified(selected);
      const [year, month] = row.monthKey.split('-');
      await dependencies.createGmailDraft({
        pdfBytes: bytes,
        to: studio.invoiceEmail,
        subject: `Invoice ${selected.invoiceNumber ?? ''} - ${config.teacher.name}`,
        body: `Please find attached the invoice for ${MONTH_NAMES[Number(month) - 1]} ${year}.`,
        pdfFilename: selected.filename,
      });
    });
  }

  const scanWarnings = drive.snapshot?.scan.warnings ?? [];
  const scanConflicts = drive.snapshot?.scan.blockingConflicts ?? [];
  const scanConflictMessages = scanConflicts.map((conflict) => conflict.message);
  const globalMessages = [
    sourceError,
    drive.error?.message ?? null,
    ...scanConflictMessages,
    ...scanWarnings,
  ].filter(
    (message, index, all): message is string =>
      message !== null && message.length > 0 && all.indexOf(message) === index
  );
  const scanMessageSignature = JSON.stringify([scanWarnings, scanConflicts]);

  useEffect(() => {
    for (const warning of scanWarnings) logWarn(`Drive invoice scan warning: ${warning}`);
    for (const conflict of scanConflicts) {
      logError(`Drive invoice scan conflict: ${conflict.message}`);
    }
  }, [scanMessageSignature]);

  const sharedMobileProps = {
    displayRows,
    driveStatus: drive.status,
    globalMessages,
    operationKey: drive.operationKey,
    rowAction,
    rowErrors,
    onPreview: handlePreview,
    onFinalize: handleFinalize,
    onOpen: handleOpen,
    onDraftEmail: handleDraftEmail,
    onRefresh: () => void drive.refresh().catch(() => undefined),
  };

  return (
    <>
      {layout === 'mobile' ? (
        <MobileInvoices {...sharedMobileProps} />
      ) : (
        <div className="p-4 flex flex-col gap-4">
          <div>
            <button
              type="button"
              onClick={() => void drive.refresh().catch(() => undefined)}
              disabled={drive.status === 'loading' || drive.operationKey !== null}
              className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
            >
              Refresh Drive
            </button>
          </div>

          {globalMessages.map((message) => (
            <p
              key={message}
              role="alert"
              className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700"
            >
              {message}
            </p>
          ))}

          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
                <th className="py-2 pr-4 font-medium">Studio</th>
                <th className="py-2 pr-4 font-medium">Month</th>
                <th className="py-2 pr-4 text-right font-medium">Classes</th>
                <th className="py-2 pr-4 text-right font-medium">Total (€)</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-gray-400">
                    No invoices
                  </td>
                </tr>
              )}
              {displayRows.map(
                ({ row, rowKey: key, total, invoiceNumber, driveEntry, availability }) => {
                  const busy = drive.operationKey !== null || rowAction !== null;
                  const finalizeLabel =
                    drive.operationKey === `finalize:${row.key.studioSlug}:${row.key.monthKey}`
                      ? 'Finalizing…'
                      : drive.operationKey === `refinalize:${driveEntry?.file.id ?? ''}`
                        ? 'Re-finalizing…'
                        : driveEntry?.state === 'stale'
                          ? 'Re-finalize PDF'
                          : 'Finalize PDF';
                  return (
                    <tr
                      key={key}
                      data-invoice-status={availability.status}
                      className="border-b border-gray-100"
                    >
                      <td className="py-2 pr-4">{row.studioName}</td>
                      <td className="py-2 pr-4">{row.label}</td>
                      <td className="py-2 pr-4 text-right">{row.classCount}</td>
                      <td className="py-2 pr-4 text-right font-mono">
                        {total === null ? '—' : `€${total.toFixed(2)}`}
                      </td>
                      <td className="py-2 pr-4">
                        <span>{availability.statusLabel}</span>
                        {invoiceNumber && <span className="ml-2 font-mono">{invoiceNumber}</span>}
                        {availability.reasons.map((reason) => (
                          <p key={reason} className="text-xs text-amber-700">
                            {reason}
                          </p>
                        ))}
                        {rowErrors[key] && (
                          <p role="alert" className="text-xs text-red-600">
                            {rowErrors[key]}
                          </p>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handlePreview(row)}
                            disabled={!availability.preview.enabled || busy}
                            className="rounded bg-indigo-50 px-3 py-1 text-xs text-indigo-700 disabled:opacity-40"
                          >
                            {rowAction === `preview:${key}` ? 'Generating…' : 'Preview PDF'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleFinalize(row)}
                            disabled={!availability.finalize.enabled || busy}
                            className="rounded bg-indigo-50 px-3 py-1 text-xs text-indigo-700 disabled:opacity-40"
                          >
                            {finalizeLabel}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpen(row)}
                            disabled={!availability.open.enabled || busy}
                            className="rounded bg-emerald-50 px-3 py-1 text-xs text-emerald-700 disabled:opacity-40"
                          >
                            {rowAction === `open:${key}` ? 'Opening…' : 'Open PDF'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDraftEmail(row)}
                            disabled={!availability.draftEmail.enabled || busy}
                            className="rounded bg-amber-50 px-3 py-1 text-xs text-amber-700 disabled:opacity-40"
                          >
                            {rowAction === `draft:${key}` ? 'Drafting…' : 'Draft Email'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
