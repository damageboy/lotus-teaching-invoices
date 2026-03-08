# Gmail Draft Integration Design

## Goal

After finalizing an invoice, the user can click "Draft Email..." to create a Gmail draft with the finalized PDF attached, pre-addressed to the studio's invoice email. The draft opens in Gmail for review before sending.

## Architecture

```
User clicks "Draft Email" on finalized invoice
        ↓
InvoicesTab  →  src/lib/gmail/auth.ts    (has valid token? if not → OAuth flow)
                       ↓
                src/lib/gmail/auth.ts    →  invoke('start_oauth_server')
                       ↓                    (Rust binds 127.0.0.1, returns port)
                shell:open Google consent URL in browser
                       ↓
                invoke('wait_oauth_code')  →  Rust returns auth code
                       ↓
                auth.ts exchanges code → tokens, saves to gmail-tokens.json
        ↓
src/lib/gmail/drafts.ts  →  reads finalized PDF from disk
        ↓
builds RFC 2822 MIME message (to, subject, body, PDF attachment)
        ↓
POST gmail.users.drafts.create via plugin-http
        ↓
shell:open https://mail.google.com/mail/#drafts
```

## Key Files

### New files

- `src/lib/gmail/auth.ts` — OAuth2 flow, token storage/refresh
- `src/lib/gmail/drafts.ts` — MIME construction, drafts.create API call
- `src/lib/gmail/constants.ts` — client ID, client secret, scopes, endpoints
- `src-tauri/src/oauth.rs` — loopback server (Tauri commands)

### Modified files

- `src/components/InvoicesTab/index.tsx` — "Draft Email..." button
- `src-tauri/src/lib.rs` — register oauth commands
- `src-tauri/capabilities/default.json` — add Google API URL scopes

## OAuth2 Flow

### Rust side (`src-tauri/src/oauth.rs`)

Two Tauri commands:

- `start_oauth_server()` → binds `TcpListener` on `127.0.0.1:0` (OS-assigned port), stores listener in Tauri state, returns port
- `wait_oauth_code(timeout_secs)` → accepts one connection, parses `?code=...` query param, responds with "You can close this tab" HTML page, shuts down the listener, clears state, returns auth code. Times out after `timeout_secs` (default 120s).

The server is ephemeral — lives for exactly one request, then shuts down.

### TypeScript side (`src/lib/gmail/auth.ts`)

1. Check `gmail-tokens.json` in AppData — if refresh token exists, use it to get a fresh access token via `POST https://oauth2.googleapis.com/token`
2. If no token or refresh fails → start OAuth flow:
   - `invoke('start_oauth_server')` → get port
   - Build consent URL with `redirect_uri=http://127.0.0.1:{port}`, scopes `gmail.compose calendar.events`
   - `shell:open` the consent URL
   - `invoke('wait_oauth_code', { timeoutSecs: 120 })` → get auth code
   - Exchange code for tokens via `POST https://oauth2.googleapis.com/token`
   - Save `{ access_token, refresh_token, expires_at }` to `gmail-tokens.json`
3. Return the access token

Token refresh: before each Gmail API call, check `expires_at`. If expired, use refresh token. If refresh fails (revoked), re-trigger full OAuth flow.

### OAuth credentials

- Client ID: `918178070743-m12oc3dv1rp40blkdomhc1767oigocpr.apps.googleusercontent.com`
- Client secret: `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`
- These are embedded in the app binary (standard for desktop OAuth2 public clients)

### OAuth scopes

- `https://www.googleapis.com/auth/gmail.compose` — create drafts (used now)
- `https://www.googleapis.com/auth/calendar.events` — read/write events (reserved for future Calendar API integration)

## MIME Construction and drafts.create

`src/lib/gmail/drafts.ts`:

1. Read finalized PDF from disk (Tauri `plugin-fs`)
2. Base64-encode the PDF bytes
3. Build RFC 2822 MIME multipart message:

```
To: {studio.invoiceEmail}
Subject: Invoice {invoiceNumber} — {teacher.name}
Content-Type: multipart/mixed; boundary="boundary"

--boundary
Content-Type: text/plain; charset="UTF-8"

Please find attached the invoice for {month} {year}.

--boundary
Content-Type: application/pdf; name="{filename}.pdf"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="{filename}.pdf"

{base64-encoded PDF}
--boundary--
```

4. Base64url-encode the entire MIME message
5. `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts` with body `{ "message": { "raw": "{base64url}" } }`, `Authorization: Bearer {access_token}` header
6. On success → `shell:open https://mail.google.com/mail/#drafts`

`From` field left empty — Gmail fills it with the authenticated user's email.

## UI Integration (InvoicesTab)

### "Draft Email..." button

Appears only when:

- The invoice has been finalized (finalized PDF exists on disk)
- The studio has a non-empty `invoiceEmail` configured

Placement: third action button in the row, after Finalize.

### Click flow

1. Check for valid Gmail token (refresh if needed, or trigger OAuth consent)
2. Locate the finalized PDF path on disk
3. Call `createGmailDraft(pdfPath, studio.invoiceEmail, subject, body)`
4. On success → open Gmail drafts in browser, log success
5. On error → show error in log panel

### Edge cases

- No `invoiceEmail` configured → button doesn't appear
- OAuth consent denied/cancelled → timeout, log error
- PDF file missing on disk → error in log panel

## Tauri Capability Changes

Add to `src-tauri/capabilities/default.json` HTTP scope:

- `https://oauth2.googleapis.com/**`
- `https://gmail.googleapis.com/**`

No new plugins needed — `plugin-http`, `plugin-fs`, `plugin-shell` already initialized.
No new Cargo dependencies — `std::net::TcpListener` is sufficient for the loopback server.

## Decisions Summary

| Decision            | Choice                                              |
| ------------------- | --------------------------------------------------- |
| Approach            | OAuth server in Rust, rest in TypeScript            |
| Client ID           | Hardcoded from Google Cloud project                 |
| Token storage       | `gmail-tokens.json` in AppData                      |
| OAuth redirect      | Loopback `127.0.0.1`, ephemeral server with timeout |
| Scopes              | `gmail.compose` + `calendar.events` (future)        |
| Email content       | Fixed template, not configurable                    |
| Draft button        | Shows only after finalization + email configured    |
| After draft created | Auto-open Gmail drafts page                         |
