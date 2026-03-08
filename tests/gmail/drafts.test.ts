import { describe, it, expect } from 'vitest';
import { buildMimeMessage } from '../../src/lib/gmail/drafts';

describe('buildMimeMessage', () => {
  it('includes To header', () => {
    const mime = buildMimeMessage({
      to: 'studio@example.com',
      subject: 'Invoice 8/2026 — Jane Doe',
      body: 'Please find attached the invoice.',
      pdfBase64: 'AAAA',
      pdfFilename: 'invoice.pdf',
    });
    expect(mime).toContain('To: studio@example.com');
  });

  it('includes Subject header', () => {
    const mime = buildMimeMessage({
      to: 'studio@example.com',
      subject: 'Invoice 8/2026 — Jane Doe',
      body: 'body text',
      pdfBase64: 'AAAA',
      pdfFilename: 'invoice.pdf',
    });
    expect(mime).toContain('Subject: Invoice 8/2026');
  });

  it('includes the body text in a text/plain part', () => {
    const mime = buildMimeMessage({
      to: 'a@b.com',
      subject: 'test',
      body: 'Hello studio',
      pdfBase64: 'AAAA',
      pdfFilename: 'f.pdf',
    });
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Hello studio');
  });

  it('includes the PDF attachment with correct content-type and filename', () => {
    const mime = buildMimeMessage({
      to: 'a@b.com',
      subject: 'test',
      body: 'hi',
      pdfBase64: 'dGVzdA==',
      pdfFilename: 'my-invoice.pdf',
    });
    expect(mime).toContain('Content-Type: application/pdf; name="my-invoice.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="my-invoice.pdf"');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain('dGVzdA==');
  });

  it('has proper MIME multipart structure with boundary', () => {
    const mime = buildMimeMessage({
      to: 'a@b.com',
      subject: 'test',
      body: 'hi',
      pdfBase64: 'AAAA',
      pdfFilename: 'f.pdf',
    });
    expect(mime).toContain('Content-Type: multipart/mixed; boundary=');
    // starts and ends with boundary markers
    const boundaryMatch = mime.match(/boundary="([^"]+)"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1];
    expect(mime).toContain(`--${boundary}`);
    expect(mime).toContain(`--${boundary}--`);
  });
});
