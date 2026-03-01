import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ParsedClass, AppConfig, InvoicePeriod } from '../../lib/types';
import { filterByDateRange } from '../../lib/invoice/grouper';
import { generateInvoice } from '../../lib/invoice/generator';
import { generateAndOpenPdf } from '../../lib/pdf/generatePdf';

interface Props {
  classes: ParsedClass[];
  config: AppConfig;
  onSaveConfig: (c: AppConfig) => Promise<void>;
}

interface InvoiceRow {
  studioName: string;
  monthKey: string; // "YYYY-MM"
  label: string;    // "February 2026"
  classCount: number;
  total: number;
  classes: ParsedClass[];
}

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

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
        total: clsList.reduce((sum, c) => sum + c.studentCount, 0), // placeholder — real total from invoice
        classes: clsList,
      };
    })
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey) || a.studioName.localeCompare(b.studioName));
}

export function InvoicesTab({ classes, config, onSaveConfig }: Props) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const rows = buildRows(classes);

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
      const [year, month] = row.monthKey.split('-');
      const from = `${year}-${month}-01`;
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
      const period: InvoicePeriod = { from, to };
      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);
      const monthClasses = filterByDateRange(row.classes, from, to);
      const { invoice } = generateInvoice(row.studioName, monthClasses, studioConfig, period);
      await generateAndOpenPdf(invoice, config);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
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
            <tr><td colSpan={5} className="py-8 text-center text-gray-400">No classes loaded</td></tr>
          )}
          {rows.map(row => {
            const rowKey = `${row.studioName}__${row.monthKey}`;
            const studioConfig = config.studios[row.studioName];
            // Compute real total from invoice generator
            let total = 0;
            if (studioConfig) {
              try {
                const [year, month] = row.monthKey.split('-');
                const from = `${year}-${month}-01`;
                const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
                const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
                const { invoice } = generateInvoice(row.studioName, row.classes, studioConfig, { from, to });
                total = invoice.totalAmount;
              } catch { /* no matching tier */ }
            }
            return (
              <tr key={rowKey} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-4">{row.studioName}</td>
                <td className="py-2 pr-4">{row.label}</td>
                <td className="py-2 pr-4 text-right">{row.classCount}</td>
                <td className="py-2 pr-4 text-right font-mono">
                  {studioConfig ? `€${total}` : <span className="text-gray-400">—</span>}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => handleGenerate(row)}
                    disabled={!studioConfig || generating === rowKey}
                    className="text-xs px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                  >
                    {generating === rowKey ? 'Generating…' : 'Generate Invoice…'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
