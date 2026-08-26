import React from 'react';
import { pdf, type DocumentProps } from '@react-pdf/renderer';
import { invoke } from '@tauri-apps/api/core';
import { Invoice, AppConfig } from '../types';
import { InvoiceDocument } from './InvoiceDocument';
import { previewFilename } from '../invoice/finalization';

async function renderPdf(invoice: Invoice, config: AppConfig): Promise<Uint8Array> {
  const element = React.createElement(InvoiceDocument, {
    invoice,
    config,
  }) as unknown as React.ReactElement<DocumentProps>;
  const blob = await pdf(element).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function renderFinalPdf(
  invoice: Invoice,
  config: AppConfig,
  invoiceNumber: string
): Promise<Uint8Array> {
  return renderPdf({ ...invoice, invoiceNumber }, config);
}

export type OpenPdfResult = { status: 'opened' } | { status: 'failed'; message: string };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface OpenPdfBytesDependencies {
  invoke: Invoke;
}

interface GeneratePreviewDependencies {
  renderPdf: typeof renderPdf;
  openPdfBytes: (filename: string, bytes: Uint8Array) => Promise<OpenPdfResult>;
}

const openPdfBytesDependencies: OpenPdfBytesDependencies = { invoke };

function visibleErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = Reflect.get(error, 'message');
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export async function openPdf(path: string): Promise<OpenPdfResult> {
  try {
    await invoke('open_file', { path });
    return { status: 'opened' };
  } catch (error) {
    return { status: 'failed', message: visibleErrorMessage(error) };
  }
}

export async function openPdfBytes(
  filename: string,
  bytes: Uint8Array,
  dependencies: OpenPdfBytesDependencies = openPdfBytesDependencies
): Promise<OpenPdfResult> {
  try {
    return await dependencies.invoke<OpenPdfResult>('write_and_open_temp_pdf', {
      filename,
      pdfBytes: Array.from(bytes),
    });
  } catch (error) {
    return { status: 'failed', message: visibleErrorMessage(error) };
  }
}

/** Render a disposable preview in memory, then open it from the app cache. */
export async function generateAndOpenPdf(
  invoice: Invoice,
  config: AppConfig,
  dependencies: GeneratePreviewDependencies = { renderPdf, openPdfBytes }
): Promise<void> {
  const filename = previewFilename(
    invoice.studioName,
    invoice.invoicePeriod.from,
    invoice.invoicePeriod.to
  );
  const bytes = await dependencies.renderPdf(invoice, config);
  const opened = await dependencies.openPdfBytes(filename, bytes);
  if (opened.status === 'failed') throw new Error(opened.message);
}
