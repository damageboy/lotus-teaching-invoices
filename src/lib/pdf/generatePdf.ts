import React from 'react';
import { pdf, type DocumentProps } from '@react-pdf/renderer';
import { writeFile, mkdir, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { Invoice, AppConfig } from '../types';
import { logWarn } from '../logger';
import { InvoiceDocument } from './InvoiceDocument';
import {
  studioSlug,
  previewFilename,
  finalizedFilename,
  matchesFinalizedInvoice,
  extractInvoiceNumberFromFilename,
} from '../invoice/finalization';

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function renderPdf(invoice: Invoice, config: AppConfig): Promise<Uint8Array> {
  const element = React.createElement(InvoiceDocument, {
    invoice,
    config,
  }) as unknown as React.ReactElement<DocumentProps>;
  const blob = await pdf(element).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

/** Write preview PDF to {outputDir}/Preview/ and open it. */
export async function generateAndOpenPdf(invoice: Invoice, config: AppConfig): Promise<void> {
  const previewDir = `${config.outputDir}/Preview`;
  await ensureDir(previewDir);
  const filename = previewFilename(
    invoice.studioName,
    invoice.invoicePeriod.from,
    invoice.invoicePeriod.to
  );
  const outputPath = `${previewDir}/${filename}`;
  await writeFile(outputPath, await renderPdf(invoice, config));
  await invoke('open_file', { path: outputPath });
}

/**
 * Scan {outputDir}/Final/ for a previously finalized file matching this studio+period.
 * Returns the filename (not full path) if found, or null.
 * Does not throw if the Final directory does not yet exist.
 */
export async function findExistingFinalInvoice(
  outputDir: string,
  slug: string,
  periodYear: string,
  periodMonth: string
): Promise<string | null> {
  const finalDir = `${outputDir}/Final`;
  try {
    const entries = await readDir(finalDir);
    for (const entry of entries) {
      if (
        !entry.isDirectory &&
        entry.name &&
        matchesFinalizedInvoice(entry.name, slug, periodYear, periodMonth)
      ) {
        return entry.name;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT means the Final dir doesn't exist yet — expected on first run
    if (
      !msg.includes('No such file') &&
      !msg.includes('os error 2') &&
      !msg.includes('(os error 2)')
    ) {
      logWarn(`findExistingFinalInvoice: unexpected error scanning Final/ folder: ${msg}`);
    }
  }
  return null;
}

/** Write finalized PDF to {outputDir}/Final/ with invoice number embedded in filename. */
export async function generateAndOpenFinalPdf(
  invoice: Invoice,
  config: AppConfig,
  invoiceNumber: string
): Promise<void> {
  const finalDir = `${config.outputDir}/Final`;
  await ensureDir(finalDir);
  const [periodYear, periodMonth] = invoice.invoicePeriod.from.split('-');
  const slug = studioSlug(invoice.studioName);
  const filename = finalizedFilename(slug, periodYear, periodMonth, invoiceNumber);
  const outputPath = `${finalDir}/${filename}`;
  const invoiceWithNumber: Invoice = { ...invoice, invoiceNumber };
  await writeFile(outputPath, await renderPdf(invoiceWithNumber, config));
  await invoke('open_file', { path: outputPath });
}

/** Extract invoice number from a finalized filename (convenience re-export for InvoicesTab). */
export { extractInvoiceNumberFromFilename };
