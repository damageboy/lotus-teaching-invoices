import { describe, expect, it, vi } from 'vitest';
import {
  generateAndOpenPdf,
  openPdfBytes,
  type OpenPdfResult,
} from '../../src/lib/pdf/generatePdf';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);

describe('openPdfBytes', () => {
  it('opens preview bytes through the app cache command', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'opened' } satisfies OpenPdfResult);

    await expect(openPdfBytes('studio-a-2026-08.pdf', PDF_BYTES, { invoke })).resolves.toEqual({
      status: 'opened',
    });

    expect(invoke).toHaveBeenCalledWith('write_and_open_temp_pdf', {
      filename: 'studio-a-2026-08.pdf',
      pdfBytes: Array.from(PDF_BYTES),
    });
  });

  it('maps native command rejection to a visible failed result', async () => {
    const invoke = vi.fn().mockRejectedValue({ message: 'No PDF viewer is installed' });

    await expect(openPdfBytes('invoice.pdf', PDF_BYTES, { invoke })).resolves.toEqual({
      status: 'failed',
      message: 'No PDF viewer is installed',
    });
  });
});

describe('generateAndOpenPdf', () => {
  it('renders preview bytes and opens them without using outputDir or local file authority', async () => {
    const rendered = new Uint8Array([1, 2, 3, 4]);
    const renderPdf = vi.fn().mockResolvedValue(rendered);
    const openPdfBytes = vi.fn().mockResolvedValue({ status: 'opened' });
    const invoice = {
      studioName: 'Studio A',
      invoicePeriod: { from: '2026-08-01', to: '2026-08-31' },
    } as Parameters<typeof generateAndOpenPdf>[0];
    const config = { outputDir: '/must/not/be/read' } as Parameters<typeof generateAndOpenPdf>[1];

    await generateAndOpenPdf(invoice, config, { renderPdf, openPdfBytes });

    expect(renderPdf).toHaveBeenCalledWith(invoice, config);
    expect(openPdfBytes).toHaveBeenCalledWith('studio-a-2026-08.pdf', rendered);
  });
});
