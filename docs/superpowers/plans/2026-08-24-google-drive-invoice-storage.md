# Google Drive Invoice Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local finalized-invoice storage with one Google Drive authority that produces the same invoice view on macOS and Android.

**Architecture:** A platform-neutral TypeScript `DriveInvoiceStore` derives invoice state from a normal My Drive control file, a selected root's `Final` child, and standard Drive file properties. Rust owns the Drive HTTP transport and disposable PDF files; macOS retains loopback OAuth, while Android obtains short-lived tokens through a native Google Identity Services Tauri plugin.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2.10, Rust, reqwest 0.12, Google Drive API v3, Google Identity Services `AuthorizationClient`, WebdriverIO, fake Google HTTP service

**Spec:** `docs/superpowers/specs/2026-08-24-google-drive-invoice-storage-design.md`

## Global Constraints

- After Drive activation, Google Drive is the only authority for finalized invoice PDFs, freshness, invoice numbers, and the selected root.
- Preview PDFs remain disposable local cache files; no persistent finalized-PDF cache or offline fallback is permitted.
- Request `https://www.googleapis.com/auth/drive`, not `drive.file` or `drive.appdata`.
- Desktop and Android use distinct OAuth clients. Desktop keeps the loopback refresh-token flow; Android uses native `AuthorizationClient` and does not persist refresh tokens.
- Store `.lotus-teaching-invoices.json` as an ordinary app-owned My Drive file marked by standard property `lotusConfigSchema=1`.
- Store Lotus PDF metadata in standard Drive `properties`, never `appProperties`.
- Support both My Drive and Shared Drives, including pagination, `supportsAllDrives=true`, `includeItemsFromAllDrives=true`, and the correct `corpora`/`driveId` pair.
- The selected root has exactly one direct `Final` child. Duplicate `Final` folders and duplicate studio/month invoices block the affected operation.
- Preserve the current finalized filename and invoice-number formats. Re-finalization preserves the Drive file ID and invoice number.
- Every control-file and PDF replacement uses the exact HTTP ETag from a fresh GET as `If-Match`; a failed precondition is visible and is never retried as an overwrite.
- Source freshness excludes `generatedAt`, `issueDate`, wall-clock values, and operation IDs. Exact PDF bytes are protected independently by `lotusPdfSha256`.
- The user manually copies existing PDFs. Never upload, move, overwrite, or delete an old local invoice as migration behavior.
- Keep the existing Calendar SQLite cache. Remove only local finalized-invoice/freshness authority.
- Do not ship an intermediate release where macOS and Android can select different invoice authorities.
- Preserve the user's unstaged `src-tauri/gen/android/gradle.properties`; never stage it in these commits.

---

### Task 1: Cross-Platform Google Authorization

**Files:**

- Create: `src/lib/google/mobile-authorization.ts`
- Create: `tests/google/mobile-authorization.test.ts`
- Create: `src-tauri/plugins/lotus-mobile/Cargo.toml`
- Create: `src-tauri/plugins/lotus-mobile/build.rs`
- Create: `src-tauri/plugins/lotus-mobile/src/lib.rs`
- Create: `src-tauri/plugins/lotus-mobile/permissions/default.toml`
- Create: `src-tauri/plugins/lotus-mobile/android/build.gradle.kts`
- Create: `src-tauri/plugins/lotus-mobile/android/src/main/AndroidManifest.xml`
- Create: `src-tauri/plugins/lotus-mobile/android/src/main/java/com/houmus/lotus_mobile/LotusMobilePlugin.kt`
- Modify: `src/lib/gmail/constants.ts`
- Modify: `src/lib/gmail/auth.ts`
- Modify: `src/lib/gmail/auth-record.ts`
- Modify: `src/hooks/useGoogleAuthorization.ts`
- Modify: `tests/gmail/auth.test.ts`
- Modify: `tests/gmail/auth-record.test.ts`
- Modify: `tests/hooks/useGoogleAuthorization.test.tsx`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: Existing durable desktop token records and loopback OAuth functions in `src/lib/gmail/auth.ts`.
- Produces: `DRIVE_SCOPE`, `DRIVE_OAUTH_SCOPES`, `GetAccessTokenOptions { requireCalendarWrite?: boolean; requireDrive?: boolean; forceRefresh?: boolean; interactive?: boolean }`, `getAccessToken(options): Promise<string>`, `clearEphemeralAccessToken(): Promise<void>`, and `MobileAuthorizeResult = { status: 'authorized'; accessToken: string; grantedScopes: string[] } | { status: 'needsUserAction' } | { status: 'denied' }`.
- Produces: `GoogleAuthorizationState.hasDrive: boolean`, `GoogleAuthorizationState.authorizationIncarnation: number`, and `GoogleAuthorizationState.allowDrive(): Promise<void>` for setup UI and stale-request invalidation.

- [ ] **Step 1: Add failing scope-union and native-result tests**

```ts
it('requires the full Drive grant in addition to existing scopes', () => {
  expect(requiredScopes({ requireDrive: true })).toEqual([
    GMAIL_COMPOSE_SCOPE,
    CALENDAR_READONLY_SCOPE,
    DRIVE_SCOPE,
  ]);
});

it('rejects a native token whose result omitted Drive', async () => {
  const invoke = vi.fn().mockResolvedValue({
    status: 'authorized',
    accessToken: 'mobile-token',
    grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE],
  });
  await expect(
    authorizeOnAndroid({ requireDrive: true, interactive: true }, { invoke })
  ).rejects.toThrow('Google did not grant Drive access');
});

it('does not launch Android consent during a passive capability check', async () => {
  const invoke = vi.fn().mockResolvedValue({ status: 'needsUserAction' });
  await expect(
    authorizeOnAndroid({ requireDrive: true, interactive: false }, { invoke })
  ).rejects.toMatchObject({ code: 'authorizationRequired' });
  expect(invoke).toHaveBeenCalledWith('plugin:lotus-mobile|authorize', {
    request: expect.objectContaining({ interactive: false }),
  });
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `bunx vitest run tests/google/mobile-authorization.test.ts tests/gmail/auth.test.ts tests/gmail/auth-record.test.ts tests/hooks/useGoogleAuthorization.test.tsx`

Expected: FAIL because Drive scope composition, Android authorization, and `hasDrive` do not exist.

- [ ] **Step 3: Implement the shared authorization contract**

```ts
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_OAUTH_SCOPES = [...BASE_OAUTH_SCOPES, DRIVE_SCOPE] as const;

export interface GetAccessTokenOptions {
  requireCalendarWrite?: boolean;
  requireDrive?: boolean;
  forceRefresh?: boolean;
  interactive?: boolean;
}

export function requiredScopes(options: GetAccessTokenOptions): string[] {
  return [
    ...new Set([
      ...BASE_OAUTH_SCOPES,
      ...(options.requireCalendarWrite ? [CALENDAR_EVENTS_SCOPE] : []),
      ...(options.requireDrive ? [DRIVE_SCOPE] : []),
    ]),
  ];
}
```

Keep desktop token CAS, refresh behavior, and `AUTHORIZATION_SCHEMA_VERSION = 1` intact because the stored record shape does not change. Existing records simply fail the new Drive scope check until incrementally upgraded. Verify the exact returned scope set before installing a new desktop token record. Route Android requests through `authorizeOnAndroid`; `interactive: false` must return an authorization-required error instead of launching UI. A failed desktop refresh with `interactive: false` must also return authorization-required instead of opening a browser. `forceRefresh` must clear the native token from Google Play services before requesting a replacement.

- [ ] **Step 4: Implement the Android Tauri plugin**

Pin `com.google.android.gms:play-services-auth:21.6.0` in the plugin Gradle file. Register `LotusMobilePlugin` from the Rust plugin crate. Implement `authorize` with this state machine:

```kotlin
val request = AuthorizationRequest.builder()
  .setRequestedScopes(invoke.getArray("scopes").map { Scope(it as String) })
  .build()

Identity.getAuthorizationClient(activity).authorize(request)
  .addOnSuccessListener { result ->
    if (result.hasResolution() && !invoke.getBoolean("interactive")) {
      invoke.resolve(JSObject().put("status", "needsUserAction"))
    } else if (result.hasResolution()) {
      startIntentSenderForResult(invoke, result.pendingIntent!!.intentSender, "authorizationResult")
    } else {
      resolveAuthorized(invoke, result)
    }
  }
  .addOnFailureListener { error -> invoke.reject(error.message ?: "Google authorization failed") }
```

The activity callback must call `getAuthorizationResultFromIntent`, return `accessToken` plus every `grantedScope.scopeUri`, map cancellation to `denied`, and retain no token in plugin storage.

- [ ] **Step 5: Expose Drive authorization state without prompting**

On desktop, derive `hasDrive` from the versioned durable token record. On Android, perform a non-interactive native authorization check. `allowDrive()` is the only hook path that passes `interactive: true`; declining Drive leaves Calendar and Gmail capabilities unchanged. Increment `authorizationIncarnation` whenever the installed desktop record or active Android grant changes; never expose the token itself as an identity key.

- [ ] **Step 6: Run authorization tests and platform compilation**

Run: `bunx vitest run tests/google/mobile-authorization.test.ts tests/gmail/auth.test.ts tests/gmail/auth-record.test.ts tests/hooks/useGoogleAuthorization.test.tsx`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/google/mobile-authorization.ts tests/google/mobile-authorization.test.ts src/lib/gmail/constants.ts src/lib/gmail/auth.ts src/lib/gmail/auth-record.ts src/hooks/useGoogleAuthorization.ts tests/gmail/auth.test.ts tests/gmail/auth-record.test.ts tests/hooks/useGoogleAuthorization.test.tsx src-tauri/plugins/lotus-mobile src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: add cross-platform Google authorization"
```

### Task 2: Drive Domain Types, Filename Parsing, and Source Fingerprints

**Files:**

- Create: `src/lib/drive/types.ts`
- Create: `src/lib/invoice/sourceFingerprint.ts`
- Create: `tests/drive/types.test.ts`
- Create: `tests/invoice/sourceFingerprint.test.ts`
- Modify: `src/lib/invoice/finalization.ts`
- Modify: `tests/invoice/finalization.test.ts`

**Interfaces:**

- Consumes: `AppConfig`, `ParsedClass`, `Invoice`, `studioSlug`, and the current finalized filename format.
- Produces: `DriveFileRecord`, `DriveCapabilities`, `DriveError`, `InvoiceKey`, `InvoiceSource`, `InvoiceSourceFingerprint`, `LotusPdfProperties`, `parseFinalizedInvoiceFilename(filename): ParsedFinalizedInvoiceFilename | null`, `buildInvoiceSource(input): InvoiceSource`, `fingerprintInvoiceSource(source): Promise<InvoiceSourceFingerprint>`, and `sha256Hex(bytes): Promise<string>`.

- [ ] **Step 1: Write failing deterministic-domain tests**

```ts
it('parses the complete finalized identity', () => {
  expect(parseFinalizedInvoiceFilename('8-2026-studio-a-2026-08.pdf')).toEqual({
    invoiceNumber: '8/2026',
    sequence: 8,
    invoiceYear: 2026,
    studioSlug: 'studio-a',
    monthKey: '2026-08',
  });
});

it('ignores render time while detecting business changes', async () => {
  const first = buildInvoiceSource(
    sourceInput({
      generatedAt: '2026-08-24T10:00:00Z',
      issueDate: '2026-08-24',
    })
  );
  const later = buildInvoiceSource(
    sourceInput({
      generatedAt: '2026-08-25T10:00:00Z',
      issueDate: '2026-08-25',
    })
  );
  expect(await fingerprintInvoiceSource(first)).toEqual(await fingerprintInvoiceSource(later));

  const changed = buildInvoiceSource(sourceInput({ studentCount: 9 }));
  expect((await fingerprintInvoiceSource(changed)).sourceSha256).not.toBe(
    (await fingerprintInvoiceSource(first)).sourceSha256
  );
});
```

Also cover stable key ordering, class-order normalization, event ID/ETag changes, summary/description changes, rate-tier changes, manual euro overrides, teacher/bank/studio changes, invoice-number changes, invalid months, and slugs containing hyphens.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run tests/drive/types.test.ts tests/invoice/sourceFingerprint.test.ts tests/invoice/finalization.test.ts`

Expected: FAIL because the Drive domain and fingerprint functions are absent.

- [ ] **Step 3: Define strict transport-neutral Drive types**

```ts
export interface DriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId: string | null;
  ownedByMe: boolean;
  version: string;
  size: string | null;
  md5Checksum: string | null;
  sha256Checksum: string | null;
  properties: Readonly<Record<string, string>>;
  capabilities: DriveCapabilities;
  etag: string | null;
}

export interface DriveCapabilities {
  canListChildren: boolean;
  canAddChildren: boolean;
  canEdit: boolean;
  canDownload: boolean;
}

export interface LotusPdfProperties {
  lotusSchema: '1';
  lotusCalendarHash: string;
  lotusStudioSlug: string;
  lotusMonth: string;
  lotusInvoiceNumber: string;
  lotusSourceSha256: string;
  lotusPdfSha256: string;
  lotusOperationId: string;
}

export interface InvoiceKey {
  studioSlug: string;
  monthKey: string;
}

export interface InvoiceSourceFingerprint {
  sourceSha256: string;
  calendarSha256: string;
}

export class DriveError extends Error {
  constructor(
    readonly code:
      | 'authorization'
      | 'offline'
      | 'notFound'
      | 'permission'
      | 'conflict'
      | 'rateLimited'
      | 'server'
      | 'invalidResponse'
      | 'corrupt',
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly fileId?: string
  ) {
    super(message);
  }
}
```

Model Drive failures as `authorization`, `offline`, `notFound`, `permission`, `conflict`, `rateLimited`, `server`, `invalidResponse`, and `corrupt`. Preserve `status`, `retryable`, and `fileId` where supplied.

- [ ] **Step 4: Implement canonical source serialization**

Use schema version `1`. Serialize with recursively sorted object keys. Sort classes by calendar ID, event ID, original start, date, start time, and end time. Include event identity/version, source summary/description, normalized line items/totals, teacher and bank details, studio details and rate tiers, period, studio slug, calendar ID, and invoice number. Exclude `generatedAt`, `issueDate`, operation IDs, and wall-clock values.

- [ ] **Step 5: Run focused tests and type checks**

Run: `bunx vitest run tests/drive/types.test.ts tests/invoice/sourceFingerprint.test.ts tests/invoice/finalization.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Run: `bunx tsc --project tsconfig.json --noEmit`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/drive/types.ts src/lib/invoice/sourceFingerprint.ts src/lib/invoice/finalization.ts tests/drive/types.test.ts tests/invoice/sourceFingerprint.test.ts tests/invoice/finalization.test.ts
git commit -m "feat: define Drive invoice identity"
```

### Task 3: Rust Drive API Transport

**Files:**

- Create: `src-tauri/src/drive_api/mod.rs`
- Create: `src-tauri/src/drive_api/models.rs`
- Create: `src-tauri/src/drive_api/client.rs`
- Create: `src-tauri/src/drive_api/commands.rs`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**

- Consumes: Bearer access tokens supplied by the frontend and webdriver-only guarded base URLs.
- Produces public `DriveClient` methods and matching Tauri commands: `list_shared_drives`, `list_files`, `get_file`, `download_file`, `generate_file_ids`, `create_folder`, `create_file`, `update_file`, and `patch_metadata`.
- Produces serialized Rust DTOs matching `DriveFileRecord`, plus `DriveListPage<T> { items, nextPageToken }`, `DriveDownload { file, bytes }`, and `DriveApiCommandError { code, message, status, retryable, fileId }`.

- [ ] **Step 1: Write failing Rust transport tests**

```rust
#[tokio::test]
async fn conditional_update_sends_if_match_and_returns_response_etag() {
    let server = MockServer::start();
    let update = server.mock(|when, then| {
        when.method(PATCH)
            .path("/upload/drive/v3/files/file-1")
            .query_param("uploadType", "multipart")
            .query_param("supportsAllDrives", "true")
            .header("authorization", "Bearer token")
            .header("if-match", "\"file-1-v3\"");
        then.status(200)
            .header("etag", "\"file-1-v4\"")
            .json_body(file_json("file-1", "4"));
    });
    let result = test_client(&server)
        .update_file("token", update_request("file-1", "\"file-1-v3\""))
        .await
        .unwrap();
    update.assert();
    assert_eq!(result.etag.as_deref(), Some("\"file-1-v4\""));
}
```

Add tests for list pagination parameters, Shared Drive flags, metadata fields, downloads, multipart metadata/content, generated IDs, 401 mapping, 403 permission mapping, 404 mapping, 412 conflict mapping, three-attempt 429/5xx retry with bounded delay, and redaction of bearer tokens/base URLs from errors.

- [ ] **Step 2: Run Rust tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml drive_api::`

Expected: FAIL because `drive_api` does not exist.

- [ ] **Step 3: Implement the typed client and retry policy**

Enable reqwest features `json`, `multipart`, and `rustls-tls`; add Tokio's `time` feature. Production bases are fixed to `https://www.googleapis.com/drive/v3` and `https://www.googleapis.com/upload/drive/v3`. Only `cfg(test)` constructors and the webdriver feature may accept loopback HTTP bases.

```rust
pub struct DriveClient {
    client: reqwest::Client,
    api_base: url::Url,
    upload_base: url::Url,
}

pub struct DriveFileDto {
    pub id: String,
    pub name: String,
    pub etag: Option<String>,
    pub properties: std::collections::HashMap<String, String>,
}

pub enum DriveApiErrorCode {
    Authorization,
    Offline,
    NotFound,
    Permission,
    Conflict,
    RateLimited,
    Server,
    InvalidResponse,
}

pub struct DriveApiError {
    pub code: DriveApiErrorCode,
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub file_id: Option<String>,
}
```

Retry only 429 and 500/502/503/504, at most three total attempts, honoring `Retry-After` up to five seconds and otherwise using 200 ms, 400 ms, then stop, with up to 100 ms jitter. Never retry 401, 403, 404, or 412. List results use `etag: null`; exact GET, download, create, patch, and update responses capture their HTTP ETag before any conditional mutation.

- [ ] **Step 4: Register commands and guarded webdriver bases**

Add `LOTUS_E2E_DRIVE_API_BASE` and `LOTUS_E2E_DRIVE_UPLOAD_BASE` to `E2eRuntime`. Require both in webdriver mode; reject non-loopback values. Register every Drive command in normal and webdriver handlers. Every list/create/get/update request must carry the explicit Shared Drive flags from its DTO.

- [ ] **Step 5: Run Rust validation**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Run: `cargo test --manifest-path src-tauri/Cargo.toml drive_api::`

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features webdriver -- -D warnings`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/drive_api src-tauri/src/e2e_support.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add guarded Drive API transport"
```

### Task 4: TypeScript Drive API Adapter and Token Retry

**Files:**

- Create: `src/lib/drive/api.ts`
- Create: `src/lib/drive/transport.ts`
- Create: `tests/drive/transport.test.ts`

**Interfaces:**

- Consumes: Task 1 `getAccessToken`/`clearEphemeralAccessToken`, Task 2 Drive types, and Task 3 Tauri commands.
- Produces: `DriveApi` with exact methods `listSharedDrives`, `listFiles`, `getFile`, `downloadFile`, `generateFileIds`, `createFolder`, `createFile`, `updateFile`, and `patchMetadata`; `createTauriDriveApi(dependencies?): DriveApi`; `withDriveTokenRetry(operation): Promise<T>`.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('refreshes authorization exactly once after a 401', async () => {
  const invoke = vi
    .fn()
    .mockRejectedValueOnce({ code: 'authorization', status: 401, message: 'expired' })
    .mockResolvedValueOnce({ items: [], nextPageToken: null });
  const getAccessToken = vi
    .fn()
    .mockResolvedValueOnce('expired-token')
    .mockResolvedValueOnce('fresh-token');
  const api = createTauriDriveApi({ invoke, getAccessToken, clearEphemeralAccessToken: vi.fn() });

  await expect(api.listFiles(listRequest())).resolves.toEqual({
    items: [],
    nextPageToken: null,
  });
  expect(getAccessToken).toHaveBeenNthCalledWith(2, {
    requireDrive: true,
    forceRefresh: true,
    interactive: false,
  });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('does not retry a precondition conflict', async () => {
  const invoke = vi.fn().mockRejectedValue({ code: 'conflict', status: 412 });
  const api = createTauriDriveApi(dependencies({ invoke }));
  await expect(api.updateFile(updateRequest())).rejects.toMatchObject({ code: 'conflict' });
  expect(invoke).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the adapter test and verify failure**

Run: `bunx vitest run tests/drive/transport.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement one typed invocation boundary**

```ts
export interface DriveApi {
  listSharedDrives(request: ListSharedDrivesRequest): Promise<DriveListPage<SharedDrive>>;
  listFiles(request: ListFilesRequest): Promise<DriveListPage<DriveFileRecord>>;
  getFile(request: GetDriveFileRequest): Promise<DriveFileRecord>;
  downloadFile(request: GetDriveFileRequest): Promise<DriveDownload>;
  generateFileIds(count: number): Promise<string[]>;
  createFolder(request: CreateFolderRequest): Promise<DriveFileRecord>;
  createFile(request: CreateDriveFileRequest): Promise<DriveFileRecord>;
  updateFile(request: UpdateDriveFileRequest): Promise<DriveFileRecord>;
  patchMetadata(request: PatchDriveMetadataRequest): Promise<DriveFileRecord>;
}

export interface DriveListPage<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface SharedDrive {
  id: string;
  name: string;
}

export interface DriveDownload {
  file: DriveFileRecord;
  bytes: Uint8Array;
}

export interface ListSharedDrivesRequest {
  pageToken?: string;
  pageSize: number;
}

export interface ListFilesRequest {
  query: string;
  corpora: 'user' | 'drive';
  driveId?: string;
  pageToken?: string;
  pageSize: number;
  includeItemsFromAllDrives: boolean;
  supportsAllDrives: boolean;
}

export interface GetDriveFileRequest {
  fileId: string;
  supportsAllDrives: boolean;
}

export interface CreateFolderRequest {
  name: string;
  parentId: string;
  supportsAllDrives: boolean;
}

export interface CreateDriveFileRequest {
  fileId: string;
  name: string;
  mimeType: string;
  parents: string[];
  properties: Record<string, string>;
  bytes: number[];
  supportsAllDrives: boolean;
}

export interface UpdateDriveFileRequest extends CreateDriveFileRequest {
  ifMatch: string;
}

export interface PatchDriveMetadataRequest {
  fileId: string;
  properties: Record<string, string>;
  ifMatch: string;
  supportsAllDrives: boolean;
}
```

Normalize malformed command errors to `invalidResponse`. A 401 clears Android's ephemeral token, requests one non-interactive forced refresh, and replays exactly once. Authorization UI is never launched from transport retry. Preserve 412 as `conflict` and all Rust retryability fields.

- [ ] **Step 4: Run focused and type validation**

Run: `bunx vitest run tests/drive/transport.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/drive/api.ts src/lib/drive/transport.ts tests/drive/transport.test.ts
git commit -m "feat: expose typed Drive transport"
```

### Task 5: Shared My Drive Control File and Sequence CAS

**Files:**

- Create: `src/lib/drive/controlFile.ts`
- Create: `tests/drive/controlFile.test.ts`

**Interfaces:**

- Consumes: Task 4 `DriveApi`, Task 2 `InvoiceKey`, and standard property marker `lotusConfigSchema=1`.
- Produces: `DriveControl`, `DriveRootPointer`, `InvoiceReservation`, `ControlSnapshot { file, control }`, `ControlDiscovery`, `DriveControlRepository.discover()`, `.create(initial)`, `.replace(snapshot, next)`, `reserveNextInvoice(snapshot, request)`, and `commitReservation(snapshot, operationId)`.

- [ ] **Step 1: Write failing control-file tests**

```ts
it('discovers one owned normal-Drive control file across all pages', async () => {
  const api = pagedControlApi([[sharedControlCandidate()], [ownedMyDriveControlCandidate()]]);
  const result = await new DriveControlRepository(api).discover();
  expect(result).toMatchObject({ kind: 'configured', snapshot: { control: { generation: 4 } } });
});

it('blocks duplicate owned control files', async () => {
  const api = controlApi([ownedControl('a'), ownedControl('b')]);
  await expect(new DriveControlRepository(api).discover()).resolves.toMatchObject({
    kind: 'conflict',
    fileIds: ['a', 'b'],
  });
});

it('reserves the next yearly number without committing the sequence', () => {
  const next = reserveNextInvoice(snapshot({ sequenceByYear: { '2026': 8 } }), {
    operationId: 'op-1',
    year: 2026,
    studioSlug: 'studio-a',
    month: '2026-08',
    fileId: 'generated-id',
    sourceSha256: 'source-hash',
    startedAt: '2026-08-24T12:00:00Z',
  });
  expect(next.control.reservation?.invoiceNumber).toBe('9/2026');
  expect(next.control.sequenceByYear['2026']).toBe(8);
});
```

Cover zero results, wrong name, trashed/shared/not-owned candidates, invalid JSON/schema, file download ETag, first-create pre-generated ID, re-list-before/re-list-after duplicate detection, `If-Match`, 412 conflicts, reservation mismatch, and commit advancing only the matching year/number.

- [ ] **Step 2: Run test and verify failure**

Run: `bunx vitest run tests/drive/controlFile.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement schema and discovery**

```ts
export interface InvoiceReservation {
  operationId: string;
  year: number;
  invoiceNumber: string;
  studioSlug: string;
  month: string;
  fileId: string;
  sourceSha256: string;
  startedAt: string;
}

export interface DriveControl {
  schemaVersion: 1;
  generation: number;
  root: DriveRootPointer;
  finalFolderId: string;
  sequenceByYear: Record<string, number>;
  reservation: InvoiceReservation | null;
}

export interface DriveRootPointer {
  folderId: string;
  driveId: string | null;
  folderName: string;
}

export interface ControlSnapshot {
  file: DriveFileRecord;
  control: DriveControl;
}

export type ControlDiscovery =
  | { kind: 'unconfigured' }
  | { kind: 'configured'; snapshot: ControlSnapshot }
  | { kind: 'conflict'; fileIds: string[] };

export class DriveControlRepository {
  constructor(private readonly api: DriveApi) {}
  discover(): Promise<ControlDiscovery>;
  create(initial: DriveControl): Promise<ControlSnapshot>;
  replace(snapshot: ControlSnapshot, next: DriveControl): Promise<ControlSnapshot>;
}
```

Search all pages with exact name, untrashed state, and `properties has { key='lotusConfigSchema' and value='1' }`. Accept only `ownedByMe === true` and `driveId === null`. GET metadata, then download JSON to obtain exact bytes and ETag; reject a missing ETag, unknown schema versions, and malformed content.

- [ ] **Step 4: Implement create and conditional replace**

`create` generates one ID, re-lists, creates `.lotus-teaching-invoices.json` in parent `root` with MIME `application/json` and property `lotusConfigSchema=1`, then re-lists again. `replace` increments `generation` once and calls `updateFile` with the snapshot ETag. Neither path repairs duplicates automatically.

- [ ] **Step 5: Run control tests and type checks**

Run: `bunx vitest run tests/drive/controlFile.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/drive/controlFile.ts tests/drive/controlFile.test.ts
git commit -m "feat: add shared Drive control file"
```

### Task 6: My Drive and Shared Drive Folder Service

**Files:**

- Create: `src/lib/drive/folders.ts`
- Create: `tests/drive/folders.test.ts`

**Interfaces:**

- Consumes: Task 4 `DriveApi` and Task 5 `DriveRootPointer`.
- Produces: `DriveLocation`, `DriveFolderPage`, `StagedDriveRoot`, and `DriveFolderService` methods `.listLocations()`, `.listChildren(location, parentId, pageToken?)`, `.createChild(location, parentId, name)`, and `.stageRoot(folder)`.

- [ ] **Step 1: Write failing folder-service tests**

```ts
it('uses Shared Drive corpora and flags for child navigation', async () => {
  const api = recordingDriveApi();
  const service = new DriveFolderService(api);
  await service.listChildren(sharedDrive('drive-1'), 'folder-1');
  expect(api.listFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      corpora: 'drive',
      driveId: 'drive-1',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      query:
        "'folder-1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    })
  );
});

it('blocks a root with two direct Final children', async () => {
  const service = new DriveFolderService(folderApi([folder('f1', 'Final'), folder('f2', 'Final')]));
  await expect(service.stageRoot(folder('root-1', 'Invoices'))).rejects.toMatchObject({
    code: 'duplicateFinalFolder',
  });
});
```

Also cover paginated Shared Drive enumeration, My Drive root, folder-only query escaping, child creation, a single existing `Final`, creation when absent, and missing `canListChildren`/`canAddChildren`/`canEdit` capabilities.

- [ ] **Step 2: Run test and verify failure**

Run: `bunx vitest run tests/drive/folders.test.ts`

Expected: FAIL because the folder service does not exist.

- [ ] **Step 3: Implement location-aware browsing**

```ts
export interface StagedDriveRoot {
  root: DriveRootPointer;
  rootFile: DriveFileRecord;
  finalFolder: DriveFileRecord;
}

export type DriveLocation =
  | { kind: 'myDrive'; id: 'root'; name: 'My Drive'; driveId: null }
  | { kind: 'sharedDrive'; id: string; name: string; driveId: string };

export interface DriveFolderPage {
  folders: DriveFileRecord[];
  nextPageToken: string | null;
}

export class DriveFolderService {
  constructor(private readonly api: DriveApi) {}
  listLocations(): Promise<DriveLocation[]>;
  listChildren(
    location: DriveLocation,
    parentId: string,
    pageToken?: string
  ): Promise<DriveFolderPage>;
  createChild(location: DriveLocation, parentId: string, name: string): Promise<DriveFileRecord>;
  stageRoot(folder: DriveFileRecord): Promise<StagedDriveRoot>;
}
```

Use folder IDs as authority and names only as labels. `stageRoot` performs a fresh GET for the root, lists every direct `Final` child page, creates one only when none exists, and GETs the resulting child to verify create/update capability. It does not write the control file.

- [ ] **Step 4: Run tests and type checks**

Run: `bunx vitest run tests/drive/folders.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/drive/folders.ts tests/drive/folders.test.ts
git commit -m "feat: browse and stage Drive invoice roots"
```

### Task 7: Final Folder Scan, Integrity, and Manual PDF Adoption

**Files:**

- Create: `src/lib/drive/invoiceCatalog.ts`
- Create: `tests/drive/invoiceCatalog.test.ts`
- Create: `tests/drive/memoryDriveApi.ts`

**Interfaces:**

- Consumes: Task 2 filename/fingerprint/checksum functions, Task 4 `DriveApi`, and Task 6 `StagedDriveRoot`.
- Produces: `CurrentInvoiceSource`, `DriveInvoiceEntry`, `DriveInvoiceScan`, `scanFinalFolder(api, stagedRoot, sources)`, `verifyDrivePdf(api, file)`, and `adoptManualPdf(api, file, source)`.

- [ ] **Step 1: Write failing catalog tests**

```ts
it('adopts one valid manually copied PDF without changing bytes or identity', async () => {
  const api = new MemoryDriveApi([
    manualPdf({
      id: 'pdf-1',
      name: '8-2026-studio-a-2026-08.pdf',
      bytes: PDF_BYTES,
    }),
  ]);
  const scan = await scanFinalFolder(api, stagedRoot(), [currentSource('studio-a', '2026-08')]);
  expect(scan.entries[0]).toMatchObject({ file: { id: 'pdf-1' }, state: 'fresh' });
  expect(api.file('pdf-1').bytes).toEqual(PDF_BYTES);
  expect(api.file('pdf-1').properties).toMatchObject({
    lotusSchema: '1',
    lotusInvoiceNumber: '8/2026',
    lotusPdfSha256: await sha256Hex(PDF_BYTES),
  });
});

it('blocks two files for one studio and month', async () => {
  const scan = await scanFinalFolder(
    new MemoryDriveApi([managedPdf('a'), managedPdf('b')]),
    stagedRoot(),
    [currentSource('studio-a', '2026-08')]
  );
  expect(
    scan.entries.filter(
      (entry) => entry.key?.studioSlug === 'studio-a' && entry.key.monthKey === '2026-08'
    )
  ).toEqual([
    expect.objectContaining({ state: 'duplicate' }),
    expect.objectContaining({ state: 'duplicate' }),
  ]);
});
```

Define `manualPdf`, `managedPdf`, `stagedRoot`, and `currentSource` in this test as typed fixture builders backed by `MemoryDriveApi`. Cover malformed filenames, unknown studio slugs, invalid/missing properties, property/filename disagreement, unavailable adoption permission, checksum mismatch, download fallback when Drive lacks SHA-256, stale source hash, historical files without current classes, pagination, and maximum sequence per year.

- [ ] **Step 2: Run test and verify failure**

Run: `bunx vitest run tests/drive/invoiceCatalog.test.ts`

Expected: FAIL because catalog scanning and the in-memory fake do not exist.

- [ ] **Step 3: Implement explicit catalog states**

```ts
export type DriveInvoiceState =
  | 'fresh'
  | 'stale'
  | 'unmanaged'
  | 'duplicate'
  | 'malformed'
  | 'corrupt'
  | 'permission';

export interface DriveInvoiceEntry {
  key: InvoiceKey | null;
  file: DriveFileRecord;
  filename: string;
  invoiceNumber: string | null;
  state: DriveInvoiceState;
  sourceSha256: string | null;
  pdfSha256: string | null;
  message: string | null;
}

export interface CurrentInvoiceSource {
  key: InvoiceKey;
  studioName: string;
  invoice: Invoice;
  classes: readonly ParsedClass[];
  config: AppConfig;
  fingerprint: InvoiceSourceFingerprint;
}

export interface DriveInvoiceScan {
  entries: DriveInvoiceEntry[];
  warnings: string[];
  blockingConflicts: string[];
  maxSequenceByYear: Record<string, number>;
}
```

List every direct non-trashed child of `Final`. Use standard properties only. Verify managed checksums against Drive SHA-256 when present; otherwise download and hash. Never classify malformed or duplicate files as safe to open, email, or overwrite.

- [ ] **Step 4: Implement guarded adoption**

Download the exact bytes, hash them, GET the file for a fresh ETag, then patch only the eight Lotus standard properties with `If-Match`. Preserve ID, parent, filename, MIME type, and bytes. If source mapping is unavailable or ambiguous, do not mutate the file.

- [ ] **Step 5: Run catalog tests and type checks**

Run: `bunx vitest run tests/drive/invoiceCatalog.test.ts tests/invoice/sourceFingerprint.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/drive/invoiceCatalog.ts tests/drive/invoiceCatalog.test.ts tests/drive/memoryDriveApi.ts
git commit -m "feat: scan and adopt Drive invoices"
```

### Task 8: Transactional Drive Invoice Store

**Files:**

- Create: `src/lib/drive/invoiceStore.ts`
- Create: `tests/drive/invoiceStore.test.ts`

**Interfaces:**

- Consumes: Task 2 source fingerprints, Task 4 `DriveApi`, Task 5 control repository/CAS helpers, Task 6 staged roots, Task 7 catalog scanning, and injected `renderFinalPdf(invoice, config, invoiceNumber)`.
- Produces: `DriveInvoiceStore.bootstrap(sources)`, `.activateRoot(staged, sources, legacyLastInvoice)`, `.finalize(input)`, `.refinalize(input, expectedEntry)`, `.recoverReservation(sources)`, `.refresh(sources)`, and `.downloadVerified(entry)`.
- Produces: `FinalizationInput { key, invoice, classes, config }`, `DriveStoreSnapshot { control, stagedRoot, scan }`, and explicit `DriveStoreError` variants.

- [ ] **Step 1: Write failing transaction tests**

```ts
it('reserves, uploads, verifies, then commits one new number', async () => {
  const api = new MemoryDriveApi(configuredDrive({ sequence2026: 8 }));
  const store = testInvoiceStore(api, { operationId: 'op-1', now: FIXED_NOW });
  const result = await store.finalize(finalizationInput('studio-a', '2026-08'));

  expect(result.invoiceNumber).toBe('9/2026');
  expect(result.file.id).toBe('generated-file-1');
  expect(api.control().sequenceByYear['2026']).toBe(9);
  expect(api.control().reservation).toBeNull();
  expect(api.mutations()).toEqual([
    'control:reserve:if-match',
    'pdf:create:generated-file-1',
    'pdf:get:generated-file-1',
    'control:commit:if-match',
  ]);
});

it('preserves file ID and number during re-finalization', async () => {
  const api = new MemoryDriveApi(configuredDriveWithStalePdf('pdf-8', '8/2026'));
  const store = testInvoiceStore(api);
  const result = await store.refinalize(refinalizationInput(), staleEntry('pdf-8', '8/2026'));
  expect(result.file.id).toBe('pdf-8');
  expect(result.invoiceNumber).toBe('8/2026');
  expect(api.updateRequest('pdf-8')?.ifMatch).toBe('"pdf-8-v3"');
});
```

Add tests for pre-upload 412, post-upload commit interruption, recovery by reserved file ID, recovery by `lotusOperationId`, no-upload same-source retry, source mismatch blocking, ambiguous upload blocking, duplicate-before-finalize blocking, upload verification mismatch, re-finalization remote-change conflict, Shared Drive parameters, and refresh after every success.

- [ ] **Step 2: Run store tests and verify failure**

Run: `bunx vitest run tests/drive/invoiceStore.test.ts`

Expected: FAIL because `DriveInvoiceStore` does not exist.

- [ ] **Step 3: Implement bootstrap and root activation**

```ts
export class DriveInvoiceStore {
  async bootstrap(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot | null>;
  async activateRoot(
    staged: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[],
    legacyLastInvoice: string | undefined
  ): Promise<DriveStoreSnapshot>;
  async refresh(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot>;
  async finalize(input: FinalizationInput): Promise<DriveInvoiceEntry>;
  async refinalize(
    input: FinalizationInput,
    expectedEntry: DriveInvoiceEntry
  ): Promise<DriveInvoiceEntry>;
  async recoverReservation(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot>;
  async downloadVerified(entry: DriveInvoiceEntry): Promise<Uint8Array>;
}

export interface FinalizationInput {
  key: InvoiceKey;
  invoice: Invoice;
  classes: readonly ParsedClass[];
  config: AppConfig;
}

export interface DriveStoreSnapshot {
  control: ControlSnapshot;
  stagedRoot: StagedDriveRoot;
  scan: DriveInvoiceScan;
}

export type DriveStoreErrorCode =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'offline'
  | 'permission'
  | 'conflict'
  | 'corrupt'
  | 'duplicate'
  | 'recoveryRequired'
  | 'invalidState';

export class DriveStoreError extends Error {
  constructor(
    readonly code: DriveStoreErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}
```

Activation scans before writing the pointer. Seed each discovered year to `max(scan maximum, matching legacy lastInvoice)`; reject malformed legacy values rather than guessing. Create a control file when discovery is unconfigured; otherwise replace the current snapshot conditionally. Do not mutate or delete the previous root. Bootstrap of an already activated pointer GETs the recorded root and `finalFolderId`, verifies that `Final` is still its direct child, and blocks when either is missing; it never recreates an activated folder silently.

- [ ] **Step 4: Implement finalization and reservation recovery**

Refresh the control file and catalog first. Compute the candidate number from the freshly read yearly sequence, build the canonical source with that number, and put its `sourceSha256` in the same conditional reservation write. Generate the file ID and operation ID before reserving. A reservation 412 reloads state and returns a visible retry requirement; it does not reuse the stale candidate. Render only after the reservation is durable. Create the PDF with the reserved ID, `application/pdf`, final parent, and all eight standard properties in the same multipart request. GET and verify ID, parent, filename, size, properties, and SHA-256 before committing the sequence.

Recovery reads the reserved file ID and searches `lotusOperationId`. Exactly one verified upload commits. Zero uploads can resume only when the current source hash equals the reservation hash. Any other state returns a blocking recovery error and leaves the reservation unchanged.

- [ ] **Step 5: Implement guarded re-finalization and verified download**

Re-finalization performs a fresh GET/download, compares ID/ETag/version/checksum to the selected entry, renders with the existing number, and sends `If-Match`. It never retries 412. `downloadVerified` accepts only a unique `fresh` entry and hashes downloaded bytes against `lotusPdfSha256` before returning them.

- [ ] **Step 6: Run store and domain validation**

Run: `bunx vitest run tests/drive/invoiceStore.test.ts tests/drive/controlFile.test.ts tests/drive/invoiceCatalog.test.ts`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/drive/invoiceStore.ts tests/drive/invoiceStore.test.ts
git commit -m "feat: transact finalized invoices on Drive"
```

### Task 9: Disposable PDF Opening and Authoritative Gmail Attachments

**Files:**

- Create: `src-tauri/src/temp_pdfs.rs`
- Create: `src-tauri/src/gmail_api.rs`
- Modify: `src-tauri/plugins/lotus-mobile/android/src/main/java/com/houmus/lotus_mobile/LotusMobilePlugin.kt`
- Modify: `src-tauri/plugins/lotus-mobile/src/lib.rs`
- Modify: `src-tauri/gen/android/app/src/main/res/xml/file_paths.xml`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/pdf/generatePdf.ts`
- Modify: `src/lib/gmail/drafts.ts`
- Modify: `tests/gmail/drafts.test.ts`
- Create: `tests/pdf/tempPdf.test.ts`

**Interfaces:**

- Consumes: Task 1 native plugin, Task 8 verified Drive bytes, existing `renderFinalPdf`, and Gmail compose authorization.
- Produces: Tauri commands `write_and_open_temp_pdf(filename, pdfBytes)` and `gmail_create_draft(accessToken, rawMessage)`; TypeScript `openPdfBytes(filename, bytes, dependencies?): Promise<OpenPdfResult>` and `createGmailDraft(params, dependencies?): Promise<void>`; preview `generateAndOpenPdf(invoice, config)` with no `outputDir` dependency.

- [ ] **Step 1: Write failing temp-file and Gmail tests**

```ts
it('opens preview bytes through the app cache command', async () => {
  const invoke = vi.fn().mockResolvedValue({ status: 'opened' });
  await expect(openPdfBytes('studio-a-2026-08.pdf', PDF_BYTES, { invoke })).resolves.toEqual({
    status: 'opened',
  });
  expect(invoke).toHaveBeenCalledWith('write_and_open_temp_pdf', {
    filename: 'studio-a-2026-08.pdf',
    pdfBytes: Array.from(PDF_BYTES),
  });
});

it('sends the exact supplied Drive bytes in the Gmail MIME attachment', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  await createGmailDraft(draftInput({ pdfBytes: PDF_BYTES }), draftDependencies({ invoke }));
  const raw = invoke.mock.calls[0][1].rawMessage;
  expect(decodeRawMime(raw)).toContain(Buffer.from(PDF_BYTES).toString('base64'));
});
```

Add Rust tests for basename/path traversal rejection, `.pdf` enforcement, app-cache containment, startup cleanup, webdriver open suppression, Gmail status mapping, and production/webdriver base isolation.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run tests/pdf/tempPdf.test.ts tests/gmail/drafts.test.ts`

Run: `cargo test --manifest-path src-tauri/Cargo.toml temp_pdfs::`

Run: `cargo test --manifest-path src-tauri/Cargo.toml gmail_api::`

Expected: FAIL because the new commands do not exist.

- [ ] **Step 3: Implement disposable PDF storage**

Write only beneath `app_cache_dir()/invoice-pdfs`. Accept a filename basename ending in `.pdf`; reject separators, `..`, symlinks, and non-PDF extensions. Write atomically, then open with macOS `open` or the Android plugin. On startup, remove only regular files inside this exact cache directory that are older than 24 hours. Do not inspect or delete the former user-selected invoice directory.

Replace Android `file_paths.xml` with the narrow cache path:

```xml
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <cache-path name="lotus_invoice_pdfs" path="invoice-pdfs/" />
</paths>
```

The native `openPdf` command uses `FileProvider.getUriForFile`, MIME `application/pdf`, `ACTION_VIEW`, and `FLAG_GRANT_READ_URI_PERMISSION`; it returns a visible error when no PDF viewer resolves the intent.

- [ ] **Step 4: Move Gmail draft creation behind Rust HTTP**

Keep MIME construction in TypeScript. Send the base64url raw message to Rust. Production Rust uses fixed `https://gmail.googleapis.com/gmail/v1`; webdriver accepts only `LOTUS_E2E_GMAIL_API_BASE` after loopback validation. Retry once on 401 through `getAccessToken({ forceRefresh: true, interactive: false })`; do not regenerate or reread PDF bytes. Replace `@tauri-apps/plugin-shell` URL opening with `openUrl` from `@tauri-apps/plugin-opener` so the Gmail drafts page remains cross-platform.

- [ ] **Step 5: Run focused tests and compilation**

Run: `bunx vitest run tests/pdf/tempPdf.test.ts tests/gmail/drafts.test.ts`

Run: `cargo test --manifest-path src-tauri/Cargo.toml temp_pdfs::`

Run: `cargo test --manifest-path src-tauri/Cargo.toml gmail_api::`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/temp_pdfs.rs src-tauri/src/gmail_api.rs src-tauri/plugins/lotus-mobile src-tauri/gen/android/app/src/main/res/xml/file_paths.xml src-tauri/src/e2e_support.rs src-tauri/src/lib.rs src/lib/pdf/generatePdf.ts src/lib/gmail/drafts.ts tests/gmail/drafts.test.ts tests/pdf/tempPdf.test.ts
git commit -m "feat: open and attach verified PDF bytes"
```

### Task 10: In-Memory Drive Invoice Controller

**Files:**

- Create: `src/hooks/useDriveInvoices.ts`
- Create: `tests/hooks/useDriveInvoices.test.tsx`

**Interfaces:**

- Consumes: Task 8 `DriveInvoiceStore`, current classes/config, Task 1 `authorizationIncarnation`, active-tab state, `document.visibilitychange`, and window focus.
- Produces: `DriveInvoicesState`, `useDriveInvoices(options)`, `refresh`, `activateRoot`, `finalize`, `refinalize`, `downloadVerified`, and per-row operation state.

- [ ] **Step 1: Write failing lifecycle tests**

```tsx
it('discards a stale refresh after the Google account incarnation changes', async () => {
  const first = deferred<DriveStoreSnapshot>();
  const store = storeDouble().withBootstrap(first.promise);
  const { result, rerender } = renderHook(
    ({ authorizationIncarnation }) =>
      useDriveInvoices(options({ authorizationIncarnation, store })),
    { initialProps: { authorizationIncarnation: 1 } }
  );
  rerender({ authorizationIncarnation: 2 });
  first.resolve(snapshotFor('account-a'));
  await act(async () => first.promise);
  expect(result.current.snapshot).not.toEqual(snapshotFor('account-a'));
});

it('refreshes on invoice-tab activation and foreground resume', async () => {
  const store = storeDouble();
  const { rerender } = renderHook(({ active }) => useDriveInvoices(options({ active, store })), {
    initialProps: { active: false },
  });
  rerender({ active: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => expect(store.refresh).toHaveBeenCalledTimes(2));
});
```

Cover authorization-required, unconfigured, ready, loading, offline, permission, conflict, corruption, retryable error, action serialization, refresh-before-mutation, refresh-after-success, and unmount/request-incarnation races.

- [ ] **Step 2: Run hook tests and verify failure**

Run: `bunx vitest run tests/hooks/useDriveInvoices.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the controller state machine**

```ts
export type DriveInvoicesStatus =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'loading'
  | 'ready'
  | 'offline'
  | 'blocked';

export interface DriveInvoicesState {
  status: DriveInvoicesStatus;
  snapshot: DriveStoreSnapshot | null;
  error: DriveStoreError | null;
  operationKey: string | null;
  refresh(): Promise<void>;
  activateRoot(staged: StagedDriveRoot, legacyLastInvoice?: string): Promise<void>;
  finalize(input: FinalizationInput): Promise<DriveInvoiceEntry>;
  refinalize(input: FinalizationInput, entry: DriveInvoiceEntry): Promise<DriveInvoiceEntry>;
  downloadVerified(entry: DriveInvoiceEntry): Promise<Uint8Array>;
}
```

Keep only the current scan in React state. Do not write Drive results to localStorage, IndexedDB, SQLite, app data, or filesystem. Deduplicate simultaneous refresh triggers and serialize mutations through one promise queue.

- [ ] **Step 4: Run hook tests and type checks**

Run: `bunx vitest run tests/hooks/useDriveInvoices.test.tsx`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDriveInvoices.ts tests/hooks/useDriveInvoices.test.tsx
git commit -m "feat: control Drive invoice lifecycle"
```

### Task 11: Responsive Drive Folder Browser and Activation Flow

**Files:**

- Create: `src/components/InvoicesTab/DriveFolderDialog.tsx`
- Create: `tests/components/DriveFolderDialog.test.tsx`
- Modify: `src/components/InvoicesTab/MobileInvoices.tsx`
- Modify: `src/index.css`

**Interfaces:**

- Consumes: Task 6 `DriveFolderService`, Task 7 staged scan, Task 10 `activateRoot`, layout `desktop | mobile`, and optional legacy `lastInvoice` seed.
- Produces: `DriveFolderDialog` with `open`, `layout`, `currentRoot`, `folderService`, `scanCandidate`, `onConfirm`, and `onClose` props.

- [ ] **Step 1: Write failing browser-flow tests**

```tsx
it('stages a Shared Drive root and requires explicit activation', async () => {
  const onConfirm = vi.fn();
  render(<DriveFolderDialog {...dialogProps({ onConfirm })} />);
  await user.click(screen.getByRole('button', { name: 'Shared Drive A' }));
  await user.click(screen.getByRole('button', { name: '2026 Invoices' }));
  await user.click(screen.getByRole('button', { name: 'Use this folder' }));
  expect(await screen.findByText('3 recognized invoices')).toBeVisible();
  expect(onConfirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Activate for all devices' }));
  expect(onConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ finalFolder: { name: 'Final' } })
  );
});
```

Cover My Drive, Shared Drive pagination, back/breadcrumb navigation, create-folder validation, duplicate `Final`, capability loss, malformed warnings, duplicate invoice blocks, refresh after manual copying, cancellation preserving the prior pointer, and mobile 48-pixel touch targets.

- [ ] **Step 2: Run component test and verify failure**

Run: `bunx vitest run tests/components/DriveFolderDialog.test.tsx`

Expected: FAIL because the dialog does not exist.

- [ ] **Step 3: Implement browsing and staging screens**

Use three explicit phases: `browse`, `scanning`, and `confirm`. The browse phase displays My Drive plus paginated Shared Drives and folders only. The confirmation phase displays recognized, malformed, duplicate, permission, and corrupt counts; it includes a `Refresh scan` action so the user can copy PDFs manually before activation.

Changing an existing root must display: `Activating this folder changes the invoice view on every device signed into this Google account. Files are not moved or deleted.` The confirmation button stays disabled while any blocking conflict exists.

- [ ] **Step 4: Run component and layout tests**

Run: `bunx vitest run tests/components/DriveFolderDialog.test.tsx tests/components/MobileInvoices.test.tsx tests/hooks/useCompactLayout.test.tsx`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Expected: all commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/InvoicesTab/DriveFolderDialog.tsx tests/components/DriveFolderDialog.test.tsx src/components/InvoicesTab/MobileInvoices.tsx src/index.css
git commit -m "feat: select Drive invoice folders"
```

### Task 12: One-Step Invoice UI Cutover and Local Authority Retirement

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/components/InvoicesTab/index.tsx`
- Modify: `src/components/InvoicesTab/MobileInvoices.tsx`
- Modify: `src/components/RatesTab/index.tsx`
- Modify: `src/components/RatesTab/MobileSettings.tsx`
- Modify: `src/lib/invoice/rows.ts`
- Modify: `src/lib/pdf/generatePdf.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `src/lib/config/defaults.ts`
- Modify: `src/lib/calendar/calendar-update.ts`
- Modify: `src/hooks/useCalendarEditing.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `src/e2eBridge.ts`
- Delete: `src/hooks/useInvoiceFreshness.ts`
- Delete: `src/lib/invoice/freshness.ts`
- Delete: `src-tauri/src/invoice_freshness.rs`
- Delete: `src-tauri/src/invoice_files.rs`
- Modify: `config.example.yaml`
- Modify: `tests/fixtures/e2e-config.yaml`
- Modify: `tests/components/InvoicesTab.test.tsx`
- Modify: `tests/components/MobileInvoices.test.tsx`
- Modify: `tests/components/RatesTab.test.ts`
- Modify: `tests/components/MobileSettings.test.tsx`
- Modify: `tests/hooks/useCalendarEditing.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/invoice/rows.test.ts`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/config/serialization.test.ts`
- Modify: `tests/pdf/InvoiceDocument.test.tsx`
- Modify: `package.json`

**Interfaces:**

- Consumes: Tasks 9-11 PDF actions, controller, folder dialog, and Drive catalog.
- Produces: The complete desktop/mobile Drive-backed Invoices tab; `buildInvoiceRows(classes, driveEntries)`; optional legacy config fields used only once as an activation seed; `verify:drive-invoices` package script.

- [ ] **Step 1: Rewrite failing invoice UI acceptance tests**

```tsx
it('keeps Preview available before Drive setup and disables persistent actions', () => {
  render(<InvoicesTab {...props({ drive: driveState('unconfigured') })} />);
  expect(screen.getByRole('button', { name: 'Preview PDF' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Finalize PDF' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Choose Drive folder' })).toBeEnabled();
});

it('uses verified Drive bytes for open and draft', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const drive = driveState('ready', { downloadVerified: vi.fn().mockResolvedValue(bytes) });
  render(<InvoicesTab {...props({ drive })} />);
  await user.click(screen.getByRole('button', { name: 'Open PDF' }));
  await user.click(screen.getByRole('button', { name: 'Draft Email' }));
  expect(openPdfBytes).toHaveBeenCalledWith(expect.any(String), bytes);
  expect(createGmailDraft).toHaveBeenCalledWith(expect.objectContaining({ pdfBytes: bytes }));
});
```

Cover fresh/stale/not-finalized/duplicate/corrupt/offline/permission/conflict states, finalization confirmation, re-finalization preserving number, historical Drive-only rows, refresh, root switching, and per-row operation/error visibility on desktop and mobile.

- [ ] **Step 2: Run the focused suite and verify failure**

Run: `bunx vitest run tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx tests/invoice/rows.test.ts`

Expected: FAIL because the components still depend on local output and freshness state.

- [ ] **Step 3: Integrate the Drive controller into `App` and invoice rows**

Build `CurrentInvoiceSource[]` from classes/config and pass them to `useDriveInvoices`. Refresh when the Invoices tab becomes active. Merge current Calendar rows and historical Drive entries by `InvoiceKey`. A Drive entry is authoritative for invoice number/status; current local business input determines fresh versus stale by source hash.

Preview renders to app cache without Drive. Finalize and re-finalize call the controller and then open the verified returned Drive bytes. Open and Draft Email always call `downloadVerified`; neither path renders a replacement.

- [ ] **Step 4: Replace setup and status UI on both layouts**

Remove the native local-directory dialog. Show `Choose Drive folder` when unconfigured and `Change Drive folder…` plus the remote folder label when configured. Disable persistent actions for offline, unverified, duplicate, malformed, corrupt, permission, and conflict states. Keep exact reason text visible beside the affected row and in the log.

- [ ] **Step 5: Retire local invoice freshness and final-file code**

Remove `outputDir` from calendar edit requests and delete the Rust post-edit freshness writes. Calendar edits still reconcile the Calendar cache; changing `classes` causes source hashes and displayed Drive freshness to recompute. Remove all Tauri local freshness/final-file commands and module initialization. Remove the reserved freshness path/status and `freshnessAfterRemote` webdriver failpoint from `e2e_support.rs`, `e2eBridge.ts`, and Calendar E2E assertions. Delete local final scan/write functions from `generatePdf.ts`. Leave the old SQLite file and old invoice directories untouched on disk.

- [ ] **Step 6: Make legacy config fields activation-only**

```ts
export interface AppConfig {
  teacher: TeacherInfo;
  calendarId?: string;
  calendarName?: string;
  calendarAccessRole?: CalendarAccessRole;
  outputDir?: string;
  lastInvoice?: string;
  studios: Record<string, StudioConfig>;
}

export function withoutLegacyInvoiceStorage(config: AppConfig): AppConfig {
  const { outputDir: _outputDir, lastInvoice: _lastInvoice, ...current } = config;
  return current;
}
```

The schema accepts old optional fields so existing files load. Remove both fields from defaults, examples, and Rates/Settings controls. After the first successful root activation, save `withoutLegacyInvoiceStorage(config)`. Never strip them before the remote control write succeeds.

- [ ] **Step 7: Replace the slice gate and run integrated frontend/Rust tests**

Set `verify:drive-invoices` to run Drive domain/store/hook/components, authorization, Calendar editing regression tests, both TypeScript projects, and focused host Rust Drive/temp/Gmail tests. Remove deleted local-freshness tests from `verify:calendar-editing`; retain that command as a Calendar-only regression gate. The Android target is built in Task 14 through the Tauri Android toolchain.

Run: `bun run verify:drive-invoices`

Run: `bun test`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all commands PASS; `rg -n "useInvoiceFreshness|invoice_freshness|invoice_files|findExistingFinalInvoice|generateAndOpenFinalPdf" src src-tauri tests` returns no production references.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/InvoicesTab/index.tsx src/components/InvoicesTab/MobileInvoices.tsx src/components/RatesTab/index.tsx src/components/RatesTab/MobileSettings.tsx src/lib/invoice/rows.ts src/lib/pdf/generatePdf.ts src/lib/types.ts src/lib/config/schema.ts src/lib/config/defaults.ts src/lib/calendar/calendar-update.ts src/hooks/useCalendarEditing.ts src-tauri/src/lib.rs src-tauri/src/e2e_support.rs src/e2eBridge.ts config.example.yaml tests/fixtures/e2e-config.yaml tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx tests/components/RatesTab.test.ts tests/components/MobileSettings.test.tsx tests/hooks/useCalendarEditing.test.tsx tests/e2e/calendar-editing.e2e.ts tests/e2e/helpers.ts tests/invoice/rows.test.ts tests/config/loader.test.ts tests/config/serialization.test.ts tests/pdf/InvoiceDocument.test.tsx package.json
git add -u src/hooks/useInvoiceFreshness.ts src/lib/invoice/freshness.ts src-tauri/src/invoice_freshness.rs src-tauri/src/invoice_files.rs
git commit -m "feat: cut finalized invoices over to Drive"
```

### Task 13: Fake Google Drive/Gmail and Desktop Cross-Device E2E

**Files:**

- Modify: `tests/e2e/fake-google-calendar.ts`
- Create: `tests/fixtures/e2e-google-drive.json`
- Create: `tests/e2e/drive-invoices.e2e.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/lifecycle-selftest.ts`
- Modify: `tests/e2e/lifecycle-runner.ts`
- Modify: `tests/e2e/calendar-editing.e2e.ts`
- Modify: `tests/e2e/smoke.e2e.ts`
- Modify: `wdio.conf.ts`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `src/e2eBridge.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 3 webdriver base seams, Task 9 Gmail seam/open suppression, and Task 12 complete UI.
- Produces: A stateful fake Google service with Calendar, Drive metadata/download/upload, Gmail drafts, fault injection, request log, and external-device mutation controls; one isolated desktop E2E suite.

- [ ] **Step 1: Add failing fake-service contract tests**

Extend `--self-test` with exact requests for:

```ts
const created = await multipartRequest(
  `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
  { token: ACCESS_TOKEN, metadata: managedPdfMetadata(), bytes: PDF_BYTES }
);
assert.equal(created.headers.get('etag'), '"pdf-1-v1"');

const conflict = await request(
  `${server.driveUploadBaseUrl}/files/pdf-1?uploadType=multipart&supportsAllDrives=true`,
  { method: 'PATCH', headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'If-Match': '"stale"' } }
);
assert.equal(conflict.status, 412);
```

Contract coverage must include control-file search/ownership, list pagination, My Drive and Shared Drives, capabilities, folder creation, standard properties, generated IDs, multipart create/update, download bytes, checksums/version/ETag, conditional metadata patch, `supportsAllDrives` rejection, Gmail raw draft capture, 401, 403, 404, 412, 429, 503, and interrupted upload.

- [ ] **Step 2: Run fake-service self-test and verify failure**

Run: `bun run e2e:fake-server`

Expected: FAIL because Drive and Gmail endpoints are missing.

- [ ] **Step 3: Extend the fake service and lifecycle isolation**

Keep one loopback server and expose `calendarBaseUrl`, `driveApiBaseUrl`, `driveUploadBaseUrl`, `gmailApiBaseUrl`, and `controlUrl`. Model separate `e2e-desktop-token` and `e2e-android-token` OAuth clients belonging to the same fake Google account; both must observe ordinary files and standard properties. Raise the request-body ceiling to 10 MiB only for multipart/PDF and Gmail endpoints. Persist fake Drive state across browser reloads; reset only through the control endpoint. Record method, path, query, `If-Match`, metadata, body checksum, and auth token presence, never the bearer token value or full PDF bytes.

Pass `LOTUS_E2E_DRIVE_API_BASE`, `LOTUS_E2E_DRIVE_UPLOAD_BASE`, and `LOTUS_E2E_GMAIL_API_BASE` only to the webdriver Rust process. Add these names and every E2E-only command to production-artifact exclusion assertions.

- [ ] **Step 4: Add desktop E2E scenarios**

`drive-invoices.e2e.ts` must cover, in order:

1. Seed a token with Drive scope and an unconfigured fake account.
2. Browse My Drive, create/select a root, scan, and activate it.
3. Inject a manually copied valid PDF, refresh, and verify adoption.
4. Finalize a new invoice, verify its number/properties/checksum, and cold-reload the page.
5. Mutate the fake Drive through the control API to emulate Android; refresh and observe the new invoice.
6. Make the desktop snapshot stale, perform an external conditional mutation, and verify visible 412 handling without overwrite.
7. Change Calendar source data and verify stale status; re-finalize and preserve ID/number.
8. Open the PDF through the suppressed viewer and verify the recorded checksum.
9. Draft email and verify the fake Gmail attachment checksum equals the Drive bytes.
10. Switch roots and assert the old root's files remain unchanged.
11. Exercise duplicate, malformed, corrupt, missing, permission-loss, rate-limit, interrupted reservation, and recovery states.

Use two `DriveInvoiceStore` instances sharing `MemoryDriveApi` in `tests/drive/invoiceStore.test.ts` for deterministic simultaneous-device CAS tests; use fake-server external mutations for the real-Tauri boundary.

- [ ] **Step 5: Run E2E validation**

Run: `bun run e2e:fake-server`

Run: `bun run e2e:lifecycle-selftest`

Run: `bun run e2e`

Expected: all commands PASS, including production artifact isolation and all Calendar regression specs.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/fake-google-calendar.ts tests/e2e/drive-invoices.e2e.ts tests/e2e/helpers.ts tests/e2e/lifecycle-selftest.ts tests/e2e/lifecycle-runner.ts tests/e2e/calendar-editing.e2e.ts tests/e2e/smoke.e2e.ts tests/fixtures/e2e-google-drive.json wdio.conf.ts src-tauri/src/e2e_support.rs src/e2eBridge.ts src/vite-env.d.ts package.json
git commit -m "test: cover Drive invoices end to end"
```

### Task 14: Real Drive Seam, Android Build, and Release Readiness

**Files:**

- Create: `src-tauri/tests/drive_live.rs`
- Create: `docs/google-oauth-setup.md`
- Create: `docs/release/google-drive-invoice-storage-checklist.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: The completed desktop/Android feature, a Google Cloud project, explicit desktop-client and Android-client tokens for the same test account, and an explicitly supplied test parent folder.
- Produces: Ignored real-Drive ETag contract test, OAuth registration instructions, cross-device smoke checklist, and final release gates.

- [ ] **Step 1: Add an ignored real-Drive contract test**

```rust
#[tokio::test]
#[ignore = "requires an explicit disposable Google Drive test folder"]
async fn real_drive_honors_etag_preconditions_across_oauth_clients() {
    let desktop_token = required_env("LOTUS_DRIVE_LIVE_DESKTOP_TOKEN");
    let android_token = required_env("LOTUS_DRIVE_LIVE_ANDROID_TOKEN");
    let parent_id = required_env("LOTUS_DRIVE_LIVE_PARENT_ID");
    let client = DriveClient::production();
    let created = client.create_file(&desktop_token, create_request(&parent_id)).await.unwrap();
    let outcome: Result<DriveApiError, String> = async {
        let desktop = client.get_file(&desktop_token, &created.id, true).await.map_err(|e| e.to_string())?;
        let android = client.get_file(&android_token, &created.id, true).await.map_err(|e| e.to_string())?;
        if android.properties.get("lotusSchema").map(String::as_str) != Some("1") {
            return Err("Android client did not observe standard properties".to_string());
        }
        client.patch_metadata(&android_token, property_patch(&created.id, android.etag.as_deref().unwrap(), "android")).await.map_err(|e| e.to_string())?;
        match client.patch_metadata(&desktop_token, property_patch(&created.id, desktop.etag.as_deref().unwrap(), "desktop")).await {
            Ok(_) => Err("stale desktop ETag unexpectedly overwrote Android".to_string()),
            Err(error) => Ok(error),
        }
    }.await;
    let cleanup = client.patch_metadata(&desktop_token, trash_patch(&created.id)).await;
    let conflict = outcome.unwrap();
    cleanup.unwrap();
    assert_eq!(conflict.code, DriveApiErrorCode::Conflict);
}
```

Define `required_env`, `create_request`, `property_patch`, and `trash_patch` locally in the integration test using Task 3's public request DTOs. The helper accepts only a single explicit parent ID, creates a uniquely prefixed test file, and always attempts to trash only that created ID before propagating an assertion error. The Rust client accepts `trashed` only in its internal metadata DTO; the frontend `drive_patch_metadata` command continues to expose Lotus property patches only. Add a second ignored case gated by `LOTUS_DRIVE_LIVE_SHARED_PARENT_ID` to verify Shared Drive flags and multipart replacement. Add package script `verify:drive-live` for `cargo test --manifest-path src-tauri/Cargo.toml --test drive_live -- --ignored --nocapture`.

- [ ] **Step 2: Document exact Google Cloud registration**

`docs/google-oauth-setup.md` must specify:

- one desktop OAuth client for the loopback redirect;
- Android OAuth clients in the same Google Cloud project for package `com.houmus.teaching_invoices` and the SHA-1 fingerprints of debug, release, and Play App Signing certificates;
- enabled Drive, Calendar, and Gmail APIs;
- requested Gmail compose, Calendar read/events, and full Drive scopes;
- restricted-scope consent-screen verification and privacy-policy requirements;
- no Android client secret and no refresh-token storage on Android;
- a warning that `appDataFolder`/`appProperties` cannot be substituted for the normal control file/properties across these clients.

- [ ] **Step 3: Build Android and run automated gates**

Run: `bun run verify:drive-invoices`

Run: `bun test`

Run: `bunx tsc --project tsconfig.app.json --noEmit`

Run: `bunx tsc --project tsconfig.json --noEmit`

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features webdriver -- -D warnings`

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features webdriver`

Run: `bun run e2e`

Run: `bunx tauri android build --debug --apk --target aarch64`

Expected: every automated command PASS and a debug APK is produced. Confirm `git diff -- src-tauri/gen/android/gradle.properties` still contains only the user's pre-existing change.

- [ ] **Step 4: Execute the real Google seam checks with explicit credentials**

Run only against a disposable test folder chosen for this purpose:

```bash
LOTUS_DRIVE_LIVE_DESKTOP_TOKEN='<short-lived-desktop-client-token>' \
LOTUS_DRIVE_LIVE_ANDROID_TOKEN='<short-lived-android-client-token>' \
LOTUS_DRIVE_LIVE_PARENT_ID='<disposable-my-drive-folder-id>' \
cargo test --manifest-path src-tauri/Cargo.toml --test drive_live -- --ignored --nocapture
```

Repeat with `LOTUS_DRIVE_LIVE_SHARED_PARENT_ID` set for a disposable Shared Drive folder. Expected: create/get/update/stale-ETag conflict/download/trash checks PASS. If credentials are not available to the implementer, leave this release gate unchecked and report it as required external validation.

- [ ] **Step 5: Execute the real Android/macOS cross-device checklist**

On a Google Play-enabled Android emulator or physical device and a macOS build signed into the same test account:

1. Grant Drive on Android from the explicit setup action; verify no consent UI appears at passive startup.
2. Select/create a My Drive root on Android; verify macOS loads the same root after refresh.
3. Finalize on macOS; verify Android shows the same file ID, number, and fresh status.
4. Change invoice source data on Android; verify both devices show stale after refresh.
5. Re-finalize on Android; verify macOS sees the same file ID and invoice number with a newer version.
6. Open the PDF on Android through an installed viewer and create a Gmail draft from the verified Drive bytes.
7. Repeat selection/finalization in a disposable Shared Drive with create/update permissions.
8. Revoke Drive access and remove folder update permission; verify explicit disabled/error states while Calendar remains usable.
9. Go offline; verify no local finalized view or finalized action is offered, while Preview still renders locally.

Record device/OS/app build, OAuth client, My Drive result, Shared Drive result, and file IDs in `docs/release/google-drive-invoice-storage-checklist.md`.

- [ ] **Step 6: Update user documentation and commit**

README must explain Drive authority, manual copy into `Final`, the visible `.lotus-teaching-invoices.json` control file, standard-property metadata, online-only finalized actions, local previews, and the fact that old local files are never deleted.

```bash
git add src-tauri/tests/drive_live.rs docs/google-oauth-setup.md docs/release/google-drive-invoice-storage-checklist.md README.md package.json
git commit -m "docs: add Drive invoice release gates"
```

### Final Verification

- [ ] Confirm every requirement in `docs/superpowers/specs/2026-08-24-google-drive-invoice-storage-design.md` maps to Tasks 1-14.
- [ ] Run `rg -n "T[B]D|T[O]DO|implement lat[e]r|simil[a]r to|appropriat[e] error" docs/superpowers/plans/2026-08-24-google-drive-invoice-storage.md` and require no matches.
- [ ] Run `git diff --check`.
- [ ] Run `git status --short` and confirm the plan commits never staged `src-tauri/gen/android/gradle.properties`.
