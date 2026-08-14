import React, { useState, useMemo } from 'react';
import { confirm, open as openDialog } from '@tauri-apps/plugin-dialog';
import { ParsedClass, AppConfig, InvoicePeriod } from '../../lib/types';
import { generateInvoice } from '../../lib/invoice/generator';
import {
  generateAndOpenPdf,
  generateAndOpenFinalPdf,
  renderFinalPdf,
  openPdf,
  findExistingFinalInvoice,
  extractInvoiceNumberFromFilename,
} from '../../lib/pdf/generatePdf';
import { parseLastInvoice, formatInvoiceNumber, studioSlug } from '../../lib/invoice/finalization';
import { buildInvoiceRows, type InvoiceRow } from '../../lib/invoice/rows';
import {
  prepareReFinalization,
  prepareInvoiceEmail,
  writeReFinalizedInvoice,
  type InvoiceFreshnessRow,
} from '../../lib/invoice/freshness';
import type { InvoiceFreshnessContext } from '../../hooks/useInvoiceFreshness';
import { logError } from '../../lib/logger';
import { createGmailDraft } from '../../lib/gmail/drafts';

interface Props {
  classes: ParsedClass[];
  config: AppConfig;
  activeFreshness: InvoiceFreshnessRow[];
  activeFreshnessContext: InvoiceFreshnessContext | null;
  freshnessVerified: boolean;
  onAcknowledgeFreshnessClear: (key: InvoiceFreshnessRow['key'], expectedRevision: number) => void;
  onRefreshFreshness: () => Promise<void>;
  onSaveConfig: (c: AppConfig) => Promise<void>;
  dependencies?: ReFinalizationDependencies;
}

export interface ReFinalizationDependencies {
  confirm: typeof confirm;
  prepareReFinalization: typeof prepareReFinalization;
  renderFinalPdf: typeof renderFinalPdf;
  writeReFinalizedInvoice: typeof writeReFinalizedInvoice;
  openPdf: typeof openPdf;
  prepareInvoiceEmail: typeof prepareInvoiceEmail;
  createGmailDraft: typeof createGmailDraft;
}

const DEFAULT_REFINALIZATION_DEPENDENCIES: ReFinalizationDependencies = {
  confirm,
  prepareReFinalization,
  renderFinalPdf,
  writeReFinalizedInvoice,
  openPdf,
  prepareInvoiceEmail,
  createGmailDraft,
};

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
  const from = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

export function InvoicesTab({
  classes,
  config,
  activeFreshness,
  activeFreshnessContext,
  freshnessVerified,
  onAcknowledgeFreshnessClear,
  onRefreshFreshness,
  onSaveConfig,
  dependencies = DEFAULT_REFINALIZATION_DEPENDENCIES,
}: Props) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const freshnessForContext =
      activeFreshnessContext !== null &&
      activeFreshnessContext.calendarId === config.calendarId &&
      activeFreshnessContext.outputDir === config.outputDir
        ? activeFreshness
        : [];
    return buildInvoiceRows(classes, freshnessForContext).filter(
      (row) => row.monthKey <= currentMonth
    );
  }, [activeFreshness, activeFreshnessContext, classes, config.calendarId, config.outputDir]);

  // Compute totals once per rows+config change, not on every render
  const rowTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) continue;
      try {
        const { invoice } = generateInvoice(
          row.studioName,
          row.classes,
          studioConfig,
          periodForMonthKey(row.monthKey)
        );
        map.set(`${row.studioName}__${row.monthKey}`, invoice.totalAmount);
      } catch {
        /* no matching tier */
      }
    }
    return map;
  }, [rows, config.studios]);

  async function chooseOutputFolder() {
    const selected = await openDialog({ directory: true, title: 'Choose invoice output folder' });
    if (typeof selected === 'string') {
      await onSaveConfig({ ...config, outputDir: selected });
    }
  }

  async function handleGenerate(row: InvoiceRow) {
    if (!config.outputDir) {
      setRowError('Set an output folder first.');
      return;
    }
    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);
    try {
      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);
      const period = periodForMonthKey(row.monthKey);
      const { invoice } = generateInvoice(row.studioName, row.classes, studioConfig, period);
      await generateAndOpenPdf(invoice, config);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError(`PDF generation failed for ${row.studioName}: ${msg}`);
      setRowError(msg);
    } finally {
      setGenerating(null);
    }
  }

  async function handleFinalize(row: InvoiceRow) {
    if (!config.outputDir) {
      setRowError('Set an output folder first.');
      return;
    }
    if (!freshnessVerified) {
      setRowError('Finalized invoice status has not been checked.');
      return;
    }
    if (row.freshness) {
      await handleReFinalize(row);
      return;
    }
    if (!config.lastInvoice) {
      setRowError('Set a last invoice number in Settings first (e.g. 0/2026).');
      return;
    }

    const [periodYear, periodMonth] = row.monthKey.split('-');

    const parsed = parseLastInvoice(config.lastInvoice);
    if (!parsed) {
      setRowError('Invalid last invoice number — expected N/YYYY format.');
      return;
    }

    if (periodYear !== parsed.year.toString()) {
      setRowError(
        `Invoice period year (${periodYear}) doesn't match the year in your last invoice number (${parsed.year}). Update the last invoice number in Settings first.`
      );
      return;
    }

    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);

    try {
      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);

      const period = periodForMonthKey(row.monthKey);
      const { invoice } = generateInvoice(row.studioName, row.classes, studioConfig, period);

      const slug = studioSlug(row.studioName);
      const existingFilename = await findExistingFinalInvoice(
        config.outputDir,
        slug,
        periodYear,
        periodMonth
      );

      let invoiceNumber: string;
      let shouldIncrement = true;

      if (existingFilename) {
        const existingNumber = extractInvoiceNumberFromFilename(existingFilename);
        if (!existingNumber) {
          throw new Error(
            `Could not read invoice number from existing file "${existingFilename}". Please check the Final/ folder.`
          );
        }
        const overwrite = await confirm(
          `Invoice ${existingNumber} is already finalized for this period.\n\nOverwrite? The invoice number will be reused — the counter will not increment.`,
          { title: 'Invoice already finalized', kind: 'warning' }
        );
        if (!overwrite) return;
        invoiceNumber = existingNumber;
        shouldIncrement = false;
      } else {
        invoiceNumber = formatInvoiceNumber(parsed.n + 1, parsed.year);
      }

      await generateAndOpenFinalPdf(invoice, config, invoiceNumber);

      if (shouldIncrement) {
        await onSaveConfig({ ...config, lastInvoice: invoiceNumber });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError(`Finalization failed for ${row.studioName}: ${msg}`);
      setRowError(msg);
    } finally {
      setGenerating(null);
    }
  }

  async function handleReFinalize(row: InvoiceRow) {
    const active = row.freshness;
    if (!active) return;
    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);
    try {
      const prepared = await dependencies.prepareReFinalization(active.key, active.revision);
      const overwrite = await dependencies.confirm(
        `Invoice ${prepared.invoiceNumber} is out of date for this period.\n\nOverwrite ${prepared.finalFilename}? The invoice number will be reused — the counter will not increment.`,
        { title: 'Re-finalize invoice', kind: 'warning' }
      );
      if (!overwrite) return;

      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);
      const { invoice } = generateInvoice(
        row.studioName,
        row.classes,
        studioConfig,
        periodForMonthKey(row.monthKey)
      );
      const pdfBytes = await dependencies.renderFinalPdf(invoice, config, prepared.invoiceNumber);
      const written = await dependencies.writeReFinalizedInvoice({
        key: prepared.key,
        finalFilename: prepared.finalFilename,
        invoiceNumber: prepared.invoiceNumber,
        expectedFreshnessRevision: prepared.freshnessRevision,
        expectedFileRevision: prepared.fileRevision,
        pdfBytes: Array.from(pdfBytes),
      });
      onAcknowledgeFreshnessClear(active.key, active.revision);
      void onRefreshFreshness().catch((error) => {
        logError(
          `Invoice freshness refresh failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      const opened = await dependencies.openPdf(written.outputPath);
      if (opened.status === 'failed') {
        setRowError(`Invoice written but could not be opened: ${opened.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Re-finalization failed for ${row.studioName}: ${message}`);
      setRowError(message);
    } finally {
      setGenerating(null);
    }
  }

  async function handleDraftEmail(row: InvoiceRow) {
    const studioConfig = config.studios[row.studioName];
    if (!studioConfig?.invoiceEmail) return;
    if (!config.outputDir) {
      setRowError('Set an output folder first.');
      return;
    }
    if (!freshnessVerified) {
      setRowError('Finalized invoice status has not been checked.');
      return;
    }
    if (row.freshness) {
      setRowError('Re-finalize the invoice first.');
      return;
    }

    if (!config.calendarId) {
      setRowError('Set a calendar first.');
      return;
    }
    const [periodYear, periodMonth] = row.monthKey.split('-');

    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);

    try {
      const prepared = await dependencies.prepareInvoiceEmail({
        calendarId: config.calendarId,
        outputDir: config.outputDir,
        studioName: row.studioName,
        monthKey: row.monthKey,
      });
      const monthName = MONTH_NAMES[parseInt(periodMonth) - 1];
      await dependencies.createGmailDraft({
        pdfBytes: new Uint8Array(prepared.pdfBytes),
        to: studioConfig.invoiceEmail,
        subject: `Invoice ${prepared.invoiceNumber} - ${config.teacher.name}`,
        body: `Please find attached the invoice for ${monthName} ${periodYear}.`,
        pdfFilename: prepared.finalFilename,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError(`Gmail draft failed for ${row.studioName}: ${msg}`);
      setRowError(msg);
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Output folder */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600">Output folder:</span>
        <span className="text-sm font-mono text-gray-800 flex-1 truncate">
          {config.outputDir || <span className="text-gray-400 italic">not set</span>}
        </span>
        <button
          onClick={chooseOutputFolder}
          className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          Change folder…
        </button>
      </div>

      {rowError && <p className="text-sm text-red-500">{rowError}</p>}

      {/* Invoice table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
            <th className="py-2 pr-4 font-medium">Studio</th>
            <th className="py-2 pr-4 font-medium">Month</th>
            <th className="py-2 pr-4 font-medium text-right">Classes</th>
            <th className="py-2 pr-4 font-medium text-right">Total (€)</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-gray-400">
                No classes loaded
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const rowKey = `${row.studioName}__${row.monthKey}`;
            const studioConfig = config.studios[row.studioName];
            const total = rowTotals.get(rowKey);
            const todayStr = new Date().toISOString().slice(0, 10);
            const missingCount = row.classes.filter(
              (c) => c.studentCount === 0 && c.date < todayStr
            ).length;
            const blocked = missingCount > 0;
            const prevRow = rows[i - 1];
            const showSeparator = prevRow && prevRow.monthKey !== row.monthKey;
            return (
              <React.Fragment key={rowKey}>
                {showSeparator && (
                  <tr>
                    <td colSpan={5} className="py-1">
                      <div className="border-t-2 border-gray-300" />
                    </td>
                  </tr>
                )}
                <tr
                  data-invoice-status={row.freshness ? 'stale' : 'current'}
                  className="border-b border-gray-100 hover:bg-gray-50"
                >
                  <td className="py-2 pr-4">
                    <span className="flex items-center gap-1.5">
                      {row.studioName}
                      {row.freshness && (
                        <span className="text-xs text-red-600 font-medium">Out of date</span>
                      )}
                      {blocked && (
                        <span
                          title={`${missingCount} class(es) missing student count`}
                          className="text-amber-500 cursor-help"
                        >
                          ⚠
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="py-2 pr-4 text-right">{row.classCount}</td>
                  <td className="py-2 pr-4 text-right font-mono">
                    {total !== undefined ? (
                      `€${total.toFixed(2)}`
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleGenerate(row)}
                        disabled={blocked || !studioConfig || generating !== null}
                        className="text-xs px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                      >
                        {generating === rowKey ? 'Generating…' : 'Generate Invoice…'}
                      </button>
                      <button
                        onClick={() => handleFinalize(row)}
                        disabled={
                          blocked || !studioConfig || generating !== null || !freshnessVerified
                        }
                        className="text-xs px-3 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                      >
                        {generating === rowKey
                          ? 'Finalizing…'
                          : row.freshness
                            ? 'Re-finalize Invoice…'
                            : 'Finalize Invoice…'}
                      </button>
                      {studioConfig?.invoiceEmail && (
                        <button
                          onClick={() => handleDraftEmail(row)}
                          disabled={
                            blocked ||
                            generating !== null ||
                            !freshnessVerified ||
                            row.freshness !== null
                          }
                          title={row.freshness ? 'Re-finalize the invoice first.' : undefined}
                          className="text-xs px-3 py-1 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                        >
                          {generating === rowKey ? 'Drafting…' : 'Draft Email…'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
