import { invoke } from '@tauri-apps/api/core';

export interface InvoiceFreshnessKey {
  calendarId: string;
  outputDir: string;
  studioName: string;
  monthKey: string;
}

export interface InvoiceFreshnessRow {
  key: InvoiceFreshnessKey;
  invoiceNumber: string;
  finalFilename: string;
  staleAt: string;
  reason: string;
  clearedAt: string | null;
  revision: number;
  lastOperationId: string | null;
}

export interface FileRevision {
  sizeBytes: string;
  modifiedUnixNanos: string;
  deviceId: string | null;
  fileId: string | null;
  changedUnixNanos: string | null;
  finalDirectoryDeviceId: string | null;
  finalDirectoryFileId: string | null;
}

export interface PreparedReFinalization {
  key: InvoiceFreshnessKey;
  finalFilename: string;
  invoiceNumber: string;
  fileRevision: FileRevision;
  freshnessRevision: number;
}

export interface PreparedInvoiceEmail {
  key: InvoiceFreshnessKey;
  finalFilename: string;
  invoiceNumber: string;
  fileRevision: FileRevision;
  pdfBytes: number[];
}

export interface WriteReFinalizedInvoiceRequest {
  key: InvoiceFreshnessKey;
  finalFilename: string;
  invoiceNumber: string;
  expectedFreshnessRevision: number;
  expectedFileRevision: FileRevision;
  pdfBytes: number[];
}

export interface WrittenReFinalizedInvoice {
  status: 'written';
  outputPath: string;
  filename: string;
}

export type InvoiceFreshnessErrorCode =
  | 'invalidInput'
  | 'notFound'
  | 'ambiguous'
  | 'unreadable'
  | 'stale'
  | 'conflict'
  | 'storage';

export interface InvoiceFreshnessError {
  code: InvoiceFreshnessErrorCode;
  message: string;
  filenames?: string[];
  currentRevision?: number;
}

export type ClearInvoiceFreshnessResult =
  | { status: 'cleared'; row: InvoiceFreshnessRow }
  | { status: 'notFound' }
  | { status: 'conflict'; currentRevision: number };

export interface MarkInvoiceFreshnessRequest {
  key: InvoiceFreshnessKey;
  invoiceNumber: string;
  finalFilename: string;
  reason: string;
  operationId: string | null;
}

export function listActiveInvoiceFreshness(
  calendarId: string,
  outputDir: string
): Promise<InvoiceFreshnessRow[]> {
  return invoke<InvoiceFreshnessRow[]>('list_active_invoice_freshness', {
    calendarId,
    outputDir,
  });
}

export function prepareReFinalization(
  key: InvoiceFreshnessKey,
  expectedRevision: number
): Promise<PreparedReFinalization> {
  return invoke<PreparedReFinalization>('prepare_re_finalization', { key, expectedRevision });
}

export function clearInvoiceFreshness(
  key: InvoiceFreshnessKey,
  expectedRevision: number
): Promise<ClearInvoiceFreshnessResult> {
  return invoke<ClearInvoiceFreshnessResult>('clear_invoice_freshness', {
    key,
    expectedRevision,
  });
}

export function prepareInvoiceEmail(key: InvoiceFreshnessKey): Promise<PreparedInvoiceEmail> {
  return invoke<PreparedInvoiceEmail>('prepare_invoice_email', { key });
}

export function writeReFinalizedInvoice(
  request: WriteReFinalizedInvoiceRequest
): Promise<WrittenReFinalizedInvoice> {
  return invoke<WrittenReFinalizedInvoice>('write_re_finalized_invoice', { request });
}

export function markInvoiceFreshness(
  request: MarkInvoiceFreshnessRequest
): Promise<InvoiceFreshnessRow> {
  return invoke<InvoiceFreshnessRow>('mark_invoice_freshness', { request });
}
