import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { buildMimeMessage, createGmailDraft, rfc2047Encode } from '../../src/lib/gmail/drafts';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x2a]);

function draftInput(overrides: Partial<Parameters<typeof createGmailDraft>[0]> = {}) {
  return {
    pdfBytes: PDF_BYTES,
    to: 'studio@example.com',
    subject: 'Invoice 8/2026 - Jane Doe',
    body: 'Please find attached the invoice.',
    pdfFilename: 'studio-a-2026-08.pdf',
    ...overrides,
  };
}

function draftDependencies(overrides: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue('access-token-1'),
    openUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function decodeRawMime(raw: string): string {
  const padded = raw
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(raw.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

describe('buildMimeMessage', () => {
  it('includes To header', () => {
    const mime = buildMimeMessage({
      to: 'studio@example.com',
      subject: 'Invoice 8/2026 - Jane Doe',
      body: 'Please find attached the invoice.',
      pdfBase64: 'AAAA',
      pdfFilename: 'invoice.pdf',
    });
    expect(mime).toContain('To: studio@example.com');
  });

  it('includes Subject header', () => {
    const mime = buildMimeMessage({
      to: 'studio@example.com',
      subject: 'Invoice 8/2026 - Jane Doe',
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

  it('RFC 2047-encodes subject with non-ASCII characters', () => {
    const mime = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Invoice 8/2026 - Müller',
      body: 'hi',
      pdfBase64: 'AAAA',
      pdfFilename: 'f.pdf',
    });
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).not.toContain('Subject: Invoice 8/2026 - Müller');
  });

  it('leaves ASCII-only subject unencoded', () => {
    const mime = buildMimeMessage({
      to: 'a@b.com',
      subject: 'Invoice 8/2026 - Jane Doe',
      body: 'hi',
      pdfBase64: 'AAAA',
      pdfFilename: 'f.pdf',
    });
    expect(mime).toContain('Subject: Invoice 8/2026 - Jane Doe');
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

describe('createGmailDraft', () => {
  it('sends the exact supplied Drive bytes in the Gmail MIME attachment', async () => {
    const dependencies = draftDependencies();

    await createGmailDraft(draftInput(), dependencies);

    const raw = dependencies.invoke.mock.calls[0]![1].rawMessage as string;
    expect(decodeRawMime(raw)).toContain(Buffer.from(PDF_BYTES).toString('base64'));
    expect(dependencies.invoke).toHaveBeenCalledWith('gmail_create_draft', {
      accessToken: 'access-token-1',
      rawMessage: raw,
    });
  });

  it('retries exactly once after a typed unauthorized response without rebuilding the message', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'unauthorized',
        status: 401,
        message: 'Authorization expired',
      })
      .mockResolvedValueOnce(undefined);
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('access-token-1')
      .mockResolvedValueOnce('access-token-2');
    const dependencies = draftDependencies({ invoke, getAccessToken });

    await createGmailDraft(draftInput(), dependencies);

    expect(getAccessToken).toHaveBeenNthCalledWith(1, { interactive: true });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      interactive: false,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]![1].rawMessage).toBe(invoke.mock.calls[0]![1].rawMessage);
    expect(invoke.mock.calls[1]![1].accessToken).toBe('access-token-2');
  });

  it('does not retry an unauthorized code without the typed 401 status', async () => {
    const error = { code: 'unauthorized', status: 403, message: 'Permission denied' };
    const invoke = vi.fn().mockRejectedValue(error);
    const getAccessToken = vi.fn().mockResolvedValue('access-token-1');
    const dependencies = draftDependencies({ invoke, getAccessToken });

    await expect(createGmailDraft(draftInput(), dependencies)).rejects.toBe(error);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not retry errors that merely mention 401 without the typed unauthorized code', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('request failed with 401 text'));
    const getAccessToken = vi.fn().mockResolvedValue('access-token-1');
    const dependencies = draftDependencies({ invoke, getAccessToken });

    await expect(createGmailDraft(draftInput(), dependencies)).rejects.toThrow(
      'request failed with 401 text'
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(dependencies.openUrl).not.toHaveBeenCalled();
  });

  it('opens the Gmail drafts URL through the cross-platform opener only after success', async () => {
    const dependencies = draftDependencies();

    await createGmailDraft(draftInput(), dependencies);

    expect(dependencies.openUrl).toHaveBeenCalledWith('https://mail.google.com/mail/#drafts');
    expect(dependencies.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.openUrl.mock.invocationCallOrder[0]!
    );
  });
});
