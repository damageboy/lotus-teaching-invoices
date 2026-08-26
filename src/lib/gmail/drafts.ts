import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';
import { getAccessToken, type GetAccessTokenOptions } from './auth';
import { logInfo, logError } from '../logger';

interface MimeParams {
  to: string;
  subject: string;
  body: string;
  pdfBase64: string;
  pdfFilename: string;
}

const BOUNDARY = '____lotus_invoice_boundary____';
const GMAIL_DRAFTS_URL = 'https://mail.google.com/mail/#drafts';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface GmailDraftDependencies {
  invoke: Invoke;
  getAccessToken: (options?: GetAccessTokenOptions) => Promise<string>;
  openUrl: (url: string) => Promise<void>;
}

const gmailDraftDependencies: GmailDraftDependencies = {
  invoke: tauriInvoke,
  getAccessToken,
  openUrl: import.meta.env.VITE_LOTUS_E2E === '1' ? async () => undefined : tauriOpenUrl,
};

/** RFC 2047 encode a header value for non-ASCII safety. */
export function rfc2047Encode(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** Build an RFC 2822 MIME multipart message string. */
export function buildMimeMessage(params: MimeParams): string {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${rfc2047Encode(params.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body,
    '',
    `--${BOUNDARY}`,
    `Content-Type: application/pdf; name="${params.pdfFilename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${params.pdfFilename}"`,
    '',
    params.pdfBase64,
    '',
    `--${BOUNDARY}--`,
  ];
  return lines.join('\r\n');
}

/** Base64url-encode a string (Gmail API requires URL-safe base64). Handles UTF-8. */
function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Uint8Array to standard base64. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Create a Gmail draft with the finalized PDF attached.
 * Opens Gmail drafts page on success.
 */
export async function createGmailDraft(
  params: {
    pdfBytes: Uint8Array;
    to: string;
    subject: string;
    body: string;
    pdfFilename: string;
  },
  dependencies: GmailDraftDependencies = gmailDraftDependencies
): Promise<void> {
  logInfo(`Creating Gmail draft for ${params.to}...`);

  const pdfBase64 = uint8ToBase64(params.pdfBytes);

  // Build MIME message
  const mime = buildMimeMessage({
    to: params.to,
    subject: params.subject,
    body: params.body,
    pdfBase64,
    pdfFilename: params.pdfFilename,
  });

  const raw = base64urlEncode(mime);

  const createDraft = (accessToken: string) =>
    dependencies.invoke<void>('gmail_create_draft', {
      accessToken,
      rawMessage: raw,
    });

  try {
    await createDraft(await dependencies.getAccessToken({ interactive: true }));
  } catch (error) {
    if (!isUnauthorizedError(error)) {
      logError('Gmail draft creation failed');
      throw error;
    }
    const refreshed = await dependencies.getAccessToken({
      forceRefresh: true,
      interactive: false,
    });
    await createDraft(refreshed);
  }

  logInfo('Gmail draft created successfully');
  await dependencies.openUrl(GMAIL_DRAFTS_URL);
}

function isUnauthorizedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    !Array.isArray(error) &&
    Reflect.get(error, 'code') === 'unauthorized' &&
    Reflect.get(error, 'status') === 401
  );
}
