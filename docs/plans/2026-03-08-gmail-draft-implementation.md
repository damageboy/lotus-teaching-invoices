# Gmail Draft Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After finalizing an invoice, the user can click "Draft Email..." to create a Gmail draft with the finalized PDF attached and auto-open Gmail drafts.

**Architecture:** OAuth2 loopback server in Rust (two Tauri commands), all token management and Gmail API calls in TypeScript. Three new TS modules under `src/lib/gmail/` handle constants, auth, and draft creation.

**Tech Stack:** Tauri 2 commands (Rust `std::net::TcpListener`), `@tauri-apps/plugin-http` for Gmail API, `@tauri-apps/plugin-fs` for token storage, `@tauri-apps/plugin-shell` for opening browser.

---

### Task 1: Gmail constants module

**Files:**

- Create: `src/lib/gmail/constants.ts`

**Step 1: Create the constants file**

```typescript
export const GOOGLE_CLIENT_ID =
  '918178070743-m12oc3dv1rp40blkdomhc1767oigocpr.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
export const TOKEN_FILE = 'gmail-tokens.json';
```

**Step 2: Verify TypeScript compiles**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: no errors

**Step 3: Commit**

```
feat(gmail): add OAuth and Gmail API constants
```

---

### Task 2: Rust OAuth loopback server

**Files:**

- Create: `src-tauri/src/oauth.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Create `src-tauri/src/oauth.rs`**

```rust
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

pub struct OAuthListener(pub Mutex<Option<TcpListener>>);

#[tauri::command]
pub fn start_oauth_server(state: State<OAuthListener>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(listener);
    Ok(port)
}

#[tauri::command]
pub fn wait_oauth_code(
    state: State<OAuthListener>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let listener = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("No OAuth server running")?
    };

    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;

    // Use SO_RCVTIMEO for accept timeout
    let raw_fd = {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            listener.as_raw_fd()
        }
    };
    #[cfg(unix)]
    unsafe {
        let tv = libc::timeval {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_usec: 0,
        };
        libc::setsockopt(
            raw_fd,
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        );
    }

    let (mut stream, _) = listener
        .accept()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                "OAuth timed out — no response from browser".to_string()
            } else {
                e.to_string()
            }
        })?;

    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;

    // Parse "GET /callback?code=AUTH_CODE&scope=... HTTP/1.1"
    let code = request_line
        .split_whitespace()
        .nth(1) // the path
        .and_then(|path| {
            url::Url::parse(&format!("http://localhost{}", path)).ok()
        })
        .and_then(|url| {
            url.query_pairs()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.into_owned())
        })
        .ok_or("No authorization code found in callback")?;

    // Send a simple HTML response
    let body = "<html><body><h2>Authorization successful</h2><p>You can close this tab and return to the app.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    Ok(code)
}
```

**Step 2: Add `libc` and `url` to Cargo.toml dependencies**

Add these lines to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
libc = "0.2"
url = "2"
```

**Step 3: Wire into `lib.rs`**

In `src-tauri/src/lib.rs`:

1. Add `mod oauth;` at the top
2. Add `.manage(oauth::OAuthListener(std::sync::Mutex::new(None)))` on the builder
3. Add `oauth::start_oauth_server` and `oauth::wait_oauth_code` to the `invoke_handler`

The updated `lib.rs`:

```rust
use tauri::Manager;

mod oauth;

struct ConfigPath(Option<String>);

#[tauri::command]
fn get_config_path(state: tauri::State<ConfigPath>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    let config_path: Option<String> = std::env::args()
        .skip_while(|a| a != "--config")
        .nth(1);

    let builder = tauri::Builder::default()
        .manage(ConfigPath(config_path))
        .manage(oauth::OAuthListener(std::sync::Mutex::new(None)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            log::info!("App started. AppData: {}", app_data_dir.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            get_config_path,
            oauth::start_oauth_server,
            oauth::wait_oauth_code
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors

**Step 5: Commit**

```
feat(gmail): add OAuth2 loopback server in Rust
```

---

### Task 3: Tauri capability changes

**Files:**

- Modify: `src-tauri/capabilities/default.json`

**Step 1: Add Google API URLs to HTTP scope**

Change the `http:default` permission from:

```json
{ "identifier": "http:default", "allow": [{ "url": "https://calendar.google.com/**" }] }
```

to:

```json
{
  "identifier": "http:default",
  "allow": [
    { "url": "https://calendar.google.com/**" },
    { "url": "https://oauth2.googleapis.com/**" },
    { "url": "https://gmail.googleapis.com/**" }
  ]
}
```

**Step 2: Verify Tauri compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors

**Step 3: Commit**

```
feat(gmail): add Google OAuth and Gmail API to HTTP capability scope
```

---

### Task 4: Gmail auth module

**Files:**

- Create: `src/lib/gmail/auth.ts`
- Test: `tests/gmail/auth.test.ts`

**Step 1: Write tests for token helpers**

Create `tests/gmail/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isTokenExpired, buildConsentUrl } from '../../src/lib/gmail/auth';
import { GOOGLE_CLIENT_ID, OAUTH_SCOPES, OAUTH_AUTH_URL } from '../../src/lib/gmail/constants';

describe('isTokenExpired', () => {
  it('returns true when expires_at is in the past', () => {
    expect(isTokenExpired(Date.now() - 1000)).toBe(true);
  });

  it('returns true when expires_at is within 60s buffer', () => {
    expect(isTokenExpired(Date.now() + 30_000)).toBe(true);
  });

  it('returns false when token has time remaining', () => {
    expect(isTokenExpired(Date.now() + 120_000)).toBe(false);
  });
});

describe('buildConsentUrl', () => {
  it('includes client_id, redirect_uri, scope, and response_type', () => {
    const url = buildConsentUrl(12345);
    expect(url).toContain(`client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}`);
    expect(url).toContain('redirect_uri=' + encodeURIComponent('http://127.0.0.1:12345'));
    expect(url).toContain('scope=' + encodeURIComponent(OAUTH_SCOPES));
    expect(url).toContain('response_type=code');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toStartWith(OAUTH_AUTH_URL);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/gmail/auth.test.ts`
Expected: FAIL — module not found

**Step 3: Create `src/lib/gmail/auth.ts`**

```typescript
import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OAUTH_SCOPES,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  TOKEN_FILE,
} from './constants';
import { logInfo, logError } from '../logger';

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

/** Returns true if the token is expired or will expire within 60 seconds. */
export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() + 60_000 >= expiresAt;
}

/** Build the Google OAuth consent URL for the given loopback port. */
export function buildConsentUrl(port: number): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    if (!(await exists(TOKEN_FILE, { baseDir: BaseDirectory.AppData }))) return null;
    const raw = await readTextFile(TOKEN_FILE, { baseDir: BaseDirectory.AppData });
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await writeTextFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}

async function exchangeCodeForTokens(code: string, port: number): Promise<StoredTokens> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: `http://127.0.0.1:${port}`,
    grant_type: 'authorization_code',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status})`);
  }

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // refresh token is not rotated
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function runOAuthFlow(): Promise<StoredTokens> {
  logInfo('Starting Gmail OAuth flow...');
  const port: number = await invoke('start_oauth_server');
  const consentUrl = buildConsentUrl(port);
  await open(consentUrl);
  logInfo('Waiting for authorization in browser...');
  const code: string = await invoke('wait_oauth_code', { timeoutSecs: 120 });
  logInfo('Authorization code received, exchanging for tokens...');
  const tokens = await exchangeCodeForTokens(code, port);
  await saveTokens(tokens);
  logInfo('Gmail authorization complete');
  return tokens;
}

/**
 * Get a valid Gmail access token.
 * Loads from storage, refreshes if expired, or runs full OAuth flow if needed.
 */
export async function getAccessToken(): Promise<string> {
  const stored = await loadTokens();

  if (stored) {
    if (!isTokenExpired(stored.expires_at)) {
      return stored.access_token;
    }
    // Try refresh
    try {
      logInfo('Refreshing Gmail access token...');
      const refreshed = await refreshAccessToken(stored.refresh_token);
      await saveTokens(refreshed);
      return refreshed.access_token;
    } catch (e) {
      logError(`Token refresh failed, re-authorizing: ${e}`);
    }
  }

  // Full OAuth flow
  const tokens = await runOAuthFlow();
  return tokens.access_token;
}
```

**Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/gmail/auth.test.ts`
Expected: all pass

**Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --project tsconfig.app.json --noEmit`
Expected: all pass

**Step 6: Commit**

```
feat(gmail): add OAuth2 auth module with token storage and refresh
```

---

### Task 5: Gmail draft creation module

**Files:**

- Create: `src/lib/gmail/drafts.ts`
- Test: `tests/gmail/drafts.test.ts`

**Step 1: Write tests for MIME construction**

Create `tests/gmail/drafts.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/gmail/drafts.test.ts`
Expected: FAIL — module not found

**Step 3: Create `src/lib/gmail/drafts.ts`**

```typescript
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

/** Base64url-encode a string (Gmail API requires URL-safe base64). */
function base64urlEncode(str: string): string {
  // First encode to standard base64
  const b64 = btoa(
    str
      .split('')
      .map((c) => String.fromCharCode(c.charCodeAt(0)))
      .join('')
  );
  // Make URL-safe
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
```

**Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/gmail/drafts.test.ts`
Expected: all pass

**Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --project tsconfig.app.json --noEmit`
Expected: all pass

**Step 6: Commit**

```
feat(gmail): add draft creation with MIME construction
```

---

### Task 6: "Draft Email..." button in InvoicesTab

**Files:**

- Modify: `src/components/InvoicesTab/index.tsx`

**Step 1: Add the import and handler**

At the top of the file, add:

```typescript
import { createGmailDraft } from '../../lib/gmail/drafts';
import {
  studioSlug,
  finalizedFilename,
  extractInvoiceNumberFromFilename,
} from '../../lib/invoice/finalization';
```

Note: `studioSlug` is already imported. Add only `finalizedFilename` to the existing import.

Inside the `InvoicesTab` component, add the `handleDraftEmail` handler:

```typescript
async function handleDraftEmail(row: InvoiceRow) {
  const studioConfig = config.studios[row.studioName];
  if (!studioConfig?.invoiceEmail) return;
  if (!config.outputDir) {
    setRowError('Set an output folder first.');
    return;
  }

  const [periodYear, periodMonth] = row.monthKey.split('-');
  const slug = studioSlug(row.studioName);

  const existingFilename = await findExistingFinalInvoice(
    config.outputDir,
    slug,
    periodYear,
    periodMonth
  );

  if (!existingFilename) {
    setRowError('No finalized invoice found for this period. Finalize the invoice first.');
    return;
  }

  const invoiceNumber = extractInvoiceNumberFromFilename(existingFilename);
  const pdfPath = `${config.outputDir}/Final/${existingFilename}`;

  const rowKey = `${row.studioName}__${row.monthKey}`;
  setGenerating(rowKey);
  setRowError(null);

  try {
    const monthName = MONTH_NAMES[parseInt(periodMonth) - 1];
    await createGmailDraft({
      pdfPath,
      to: studioConfig.invoiceEmail,
      subject: `Invoice ${invoiceNumber} — ${config.teacher.name}`,
      body: `Please find attached the invoice for ${monthName} ${periodYear}.`,
      pdfFilename: existingFilename,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`Gmail draft failed for ${row.studioName}: ${msg}`);
    setRowError(msg);
  } finally {
    setGenerating(null);
  }
}
```

**Step 2: Add the button to the row actions**

In the JSX, after the "Finalize Invoice..." button, add:

```tsx
{
  studioConfig?.invoiceEmail && (
    <button
      onClick={() => handleDraftEmail(row)}
      disabled={generating !== null}
      className="text-xs px-3 py-1 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-40"
    >
      {generating === rowKey ? 'Drafting…' : 'Draft Email…'}
    </button>
  );
}
```

**Step 3: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: no errors

**Step 4: Run full test suite**

Run: `bun test`
Expected: all pass

**Step 5: Commit**

```
feat(gmail): add "Draft Email..." button to InvoicesTab
```

---

### Task 7: Manual integration test

**Step 1: Configure a test studio with invoice email**

In the app's Rates tab, set `invoiceEmail` on one studio to your own email address.

**Step 2: Generate and finalize an invoice**

On the Invoices tab, click "Generate Invoice..." then "Finalize Invoice..." for that studio/month.

**Step 3: Click "Draft Email..."**

- First time: should open Google consent in browser, authorize, return to app
- Draft should be created — Gmail drafts page opens in browser
- Verify the draft has: correct recipient, subject with invoice number and teacher name, body text, PDF attached

**Step 4: Test token persistence**

Click "Draft Email..." again — should skip OAuth consent and create draft immediately (using stored token).

**Step 5: Run e2e tests to verify nothing is broken**

Run: `bun run e2e`
Expected: all 15 existing tests pass (the Gmail flow won't be e2e-tested since it needs real Google auth, but existing functionality must not regress)

**Step 6: Commit any fixes**

---

### Task 8: Exclude gmail modules from CLI tsconfig

**Files:**

- Modify: `tsconfig.json`

**Step 1: Check current CLI tsconfig excludes**

The CLI `tsconfig.json` already excludes `src/lib/pdf` and `src/lib/config/defaults.ts` (Vite/browser-only modules). Add `src/lib/gmail` to the exclude list since it uses Tauri APIs not available in Node.

Add to the `exclude` array:

```json
"src/lib/gmail"
```

**Step 2: Verify CLI TypeScript compiles**

Run: `bunx tsc --project tsconfig.json --noEmit`
Expected: no errors

**Step 3: Commit**

```
chore: exclude gmail module from CLI tsconfig
```
