import React from 'react';
import { pdf, type DocumentProps } from '@react-pdf/renderer';
import { writeFile } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-shell';
import { Invoice, AppConfig } from '../types';
import { InvoiceDocument } from './InvoiceDocument';

export function invoiceFilename(invoice: Invoice): string {
  const slug = invoice.studioName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const [year, month] = invoice.invoicePeriod.from.split('-');
  return `${slug}-${year}-${month}.pdf`;
}

export async function generateAndOpenPdf(invoice: Invoice, config: AppConfig): Promise<void> {
  const filename = invoiceFilename(invoice);
  const outputPath = `${config.outputDir}/${filename}`;

  const element = React.createElement(InvoiceDocument, { invoice, config }) as unknown as React.ReactElement<DocumentProps>;

  const blob = await pdf(element).toBlob();
  const arrayBuffer = await blob.arrayBuffer();
  await writeFile(outputPath, new Uint8Array(arrayBuffer));
  await open(outputPath);
}
