import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Invoice } from '../types.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function invoiceFilename(invoice: Invoice): string {
  const slug = slugify(invoice.studioName);
  return `${slug}_${invoice.invoicePeriod.from}_to_${invoice.invoicePeriod.to}.json`;
}

export function writeInvoice(invoice: Invoice, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const filename = invoiceFilename(invoice);
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, JSON.stringify(invoice, null, 2) + '\n', 'utf-8');
  return filePath;
}

export function printInvoice(invoice: Invoice): void {
  console.log(JSON.stringify(invoice, null, 2));
}
