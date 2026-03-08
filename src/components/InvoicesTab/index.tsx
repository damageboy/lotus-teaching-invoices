import { useState, useMemo } from 'react';
import { confirm, open as openDialog } from '@tauri-apps/plugin-dialog';
import { ParsedClass, AppConfig, InvoicePeriod } from '../../lib/types';
import { generateInvoice } from '../../lib/invoice/generator';
import {
  generateAndOpenPdf,
  generateAndOpenFinalPdf,
  findExistingFinalInvoice,
  extractInvoiceNumberFromFilename,
} from '../../lib/pdf/generatePdf';
import { parseLastInvoice, formatInvoiceNumber, studioSlug } from '../../lib/invoice/finalization';
import { logError } from '../../lib/logger';
import { createGmailDraft } from '../../lib/gmail/drafts';

interface Props {
  classes: ParsedClass[];
  config: AppConfig;
  onSaveConfig: (c: AppConfig) => Promise<void>;
}

interface InvoiceRow {
  studioName: string;
  monthKey: string; // "YYYY-MM"
  label: string; // "February 2026"
  classCount: number;
  classes: ParsedClass[];
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

function buildRows(classes: ParsedClass[]): InvoiceRow[] {
  const map = new Map<string, ParsedClass[]>();
  for (const cls of classes) {
    const key = `${cls.studioName}__${cls.date.slice(0, 7)}`;
    const list = map.get(key) ?? [];
    list.push(cls);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([key, clsList]) => {
      const [studioName, monthKey] = key.split('__');
      const [y, m] = monthKey.split('-');
      return {
        studioName,
        monthKey,
        label: `${MONTH_NAMES[parseInt(m) - 1]} ${y}`,
        classCount: clsList.length,
        classes: clsList,
      };
    })
    .sort(
      (a, b) => b.monthKey.localeCompare(a.monthKey) || a.studioName.localeCompare(b.studioName)
    );
}

function periodForMonthKey(monthKey: string): InvoicePeriod {
  const [year, month] = monthKey.split('-');
  const from = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

export function InvoicesTab({ classes, config, onSaveConfig }: Props) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(classes), [classes]);

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

  async function handleDraftEmail(row: InvoiceRow) {
    const studioConfig = config.studios[row.studioName];
    if (!studioConfig?.invoiceEmail) return;
    if (!config.outputDir) {
      setRowError('Set an output folder first.');
      return;
    }

    const [periodYear, periodMonth] = row.monthKey.split('-');
    const slug = studioSlug(row.studioName);

    const existingFilename = await findExistingFinalInvoice(
      config.outputDir,
      slug,
      periodYear,
      periodMonth
    );

    if (!existingFilename) {
      setRowError('No finalized invoice found for this period. Finalize the invoice first.');
      return;
    }

    const invoiceNumber = extractInvoiceNumberFromFilename(existingFilename);
    if (!invoiceNumber) {
      setRowError(
        `Could not read invoice number from existing file "${existingFilename}". Please check the Final/ folder.`
      );
      return;
    }
    const pdfPath = `${config.outputDir}/Final/${existingFilename}`;

    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);

    try {
      const monthName = MONTH_NAMES[parseInt(periodMonth) - 1];
      await createGmailDraft({
        pdfPath,
        to: studioConfig.invoiceEmail,
        subject: `Invoice ${invoiceNumber} — ${config.teacher.name}`,
        body: `Please find attached the invoice for ${monthName} ${periodYear}.`,
        pdfFilename: existingFilename,
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
          {rows.map((row) => {
            const rowKey = `${row.studioName}__${row.monthKey}`;
            const studioConfig = config.studios[row.studioName];
            const total = rowTotals.get(rowKey);
            return (
              <tr key={rowKey} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-4">{row.studioName}</td>
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
                      disabled={!studioConfig || generating !== null}
                      className="text-xs px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                    >
                      {generating === rowKey ? 'Generating…' : 'Generate Invoice…'}
                    </button>
                    <button
                      onClick={() => handleFinalize(row)}
                      disabled={!studioConfig || generating !== null}
                      className="text-xs px-3 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                    >
                      {generating === rowKey ? 'Finalizing…' : 'Finalize Invoice…'}
                    </button>
                    {studioConfig?.invoiceEmail && (
                      <button
                        onClick={() => handleDraftEmail(row)}
                        disabled={generating !== null}
                        className="text-xs px-3 py-1 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                      >
                        {generating === rowKey ? 'Drafting…' : 'Draft Email…'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
