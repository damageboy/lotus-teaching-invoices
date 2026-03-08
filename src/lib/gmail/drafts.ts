import { readFile } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import { open } from '@tauri-apps/plugin-shell';
import { GMAIL_API_BASE } from './constants';
import { getAccessToken } from './auth';
import { logInfo, logError } from '../logger';

interface MimeParams {
  to: string;
  subject: string;
  body: string;
  pdfBase64: string;
  pdfFilename: string;
}

const BOUNDARY = '____lotus_invoice_boundary____';

/** Build an RFC 2822 MIME multipart message string. */
export function buildMimeMessage(params: MimeParams): string {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
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
export async function createGmailDraft(params: {
  pdfPath: string;
  to: string;
  subject: string;
  body: string;
  pdfFilename: string;
}): Promise<void> {
  logInfo(`Creating Gmail draft for ${params.to}...`);

  const accessToken = await getAccessToken();

  // Read the PDF file
  const pdfBytes = await readFile(params.pdfPath);
  const pdfBase64 = uint8ToBase64(pdfBytes);

  // Build MIME message
  const mime = buildMimeMessage({
    to: params.to,
    subject: params.subject,
    body: params.body,
    pdfBase64,
    pdfFilename: params.pdfFilename,
  });

  const raw = base64urlEncode(mime);

  // Create draft via Gmail API
  const resp = await fetch(`${GMAIL_API_BASE}/users/me/drafts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const msg = `Gmail draft creation failed (${resp.status}): ${text}`;
    logError(msg);
    throw new Error(msg);
  }

  logInfo('Gmail draft created successfully');
  await open('https://mail.google.com/mail/#drafts');
}
