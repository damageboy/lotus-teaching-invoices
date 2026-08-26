# Google Drive Finalized Invoice Storage Design

**Date:** 2026-08-24
**Status:** Approved design; implementation pending

## Goal

Make Google Drive the authoritative store for finalized invoice PDFs so macOS and Android, when signed into the same Google account, show the same finalized-invoice view.

The user chooses or creates a Drive root folder. The app owns a single `Final` child folder and manages finalized invoices there. Local storage remains only for disposable previews and temporary copies used to open or attach a PDF.

## Success Criteria

- Finalized invoices are listed from Drive on both macOS and Android.
- A finalization performed on one device appears on the other after refresh.
- My Drive and Shared Drives are supported.
- Manually copied existing invoices with valid, unique current-format filenames are recognized.
- Re-finalization preserves both the Drive file ID and the invoice number.
- Duplicate, malformed, stale, corrupt, missing, permission, and concurrent-update states are explicit and never cause a silent overwrite.
- Finalized-invoice actions require network access. There is no persistent local PDF cache or offline fallback.

## Scope

### Included

- Incremental Google authorization for Drive.
- An in-app folder browser for My Drive and Shared Drives.
- Cross-device synchronization of the selected folder pointer through an ordinary app-owned Drive control file.
- Drive-backed list, finalize, re-finalize, open, and email-attachment flows.
- Remote invoice-number sequencing.
- Recognition and adoption of manually copied legacy invoice PDFs.
- Desktop and Android behavior and validation.

### Excluded

- Automatic migration, upload, move, or deletion of existing local invoices.
- Synchronization of the complete app configuration, rates, Calendar cache, or draft state.
- A persistent PDF cache or offline invoice workflow.
- Google Picker. The app uses one custom folder browser on both platforms.
- A Lotus server or other backend.

The user manually copies existing PDFs into the chosen Drive root's `Final` folder before activating it. The app never deletes the old local files.

## Existing Behavior to Preserve

- `Preview` remains a local-only, disposable operation.
- The current invoice PDF layout, filename format, invoice-number format, finalization semantics, opening behavior, and Gmail draft behavior remain unchanged unless this design explicitly changes their storage source.
- Calendar-derived freshness remains conservative: changes to invoice-affecting data make a finalized invoice stale.
- A stale invoice is re-finalized under its existing number, not allocated a new number.

## Authorization and Security

On macOS, the existing Google authorization record and loopback-browser flow are incrementally expanded with:

- `https://www.googleapis.com/auth/drive`

The existing Calendar and Gmail scopes remain requested. The app verifies the scopes actually returned before replacing its durable token record. If the user declines Drive access, existing Calendar and Gmail functionality remains usable, while finalized-invoice actions remain disabled.

Android does not use the desktop loopback redirect or persist a refresh token. It uses a separately registered Android OAuth client and Google Identity Services `AuthorizationClient` through a native Tauri mobile plugin. The native result's granted scopes are verified before its short-lived access token is accepted. The app calls the same native authorization request again in later sessions; Google Play services returns a token without interaction while the grant remains valid. Consent UI is launched only after the user invokes a feature that requires the missing scope.

The broad `drive` scope is intentional. The narrower `drive.file` scope cannot reliably grant access to child PDFs that the user copied manually outside the app. The full Drive scope is classified as restricted and therefore requires the corresponding Google OAuth verification work before release. The app does not request `drive.appdata`: Google makes `appDataFolder` and private `appProperties` specific to the requesting OAuth application, while Google requires separate OAuth clients for desktop and Android. Tokens remain on the device; invoice data is transferred only between the device, Google Drive, and the existing Gmail draft flow.

References:

- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [OAuth 2.0 policies for native apps](https://developers.google.com/identity/protocols/oauth2/policies)
- [Android user authorization](https://developer.android.com/identity/authorization)
- [Drive custom properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [Shared Drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)

## Remote Control File

The app stores one ordinary JSON control file named `.lotus-teaching-invoices.json` in the authenticated user's My Drive. It contains no PDFs. The app creates it in the My Drive root, owns it, and marks it with the standard public Drive property `lotusConfigSchema=1`. It is deliberately not stored inside the selected invoice root, so changing between My Drive and Shared Drive roots never requires a non-atomic config move.

At bootstrap, the app searches the normal `drive` space for the exact filename and marker, follows all result pages, and considers only an untrashed file that is owned by the authenticated user and is not in a Shared Drive. Lookup must return exactly zero or one valid match. Multiple valid matches are a blocking bootstrap conflict rather than an invitation to choose one silently. A file moved elsewhere within My Drive remains discoverable. A trashed, transferred, or Shared-Drive-moved file is not valid control state and requires setup to be restored or repeated.

The file is visible to the user in Drive and readable by other applications that the user authorizes to read it. Standard PDF properties are likewise visible through the Drive API to applications with access to those files. This exposure is the explicit tradeoff that lets distinct desktop and Android OAuth clients share state without a Lotus backend.

```json
{
  "schemaVersion": 1,
  "generation": 4,
  "root": {
    "folderId": "drive-folder-id",
    "driveId": null,
    "folderName": "Lotus Invoices"
  },
  "finalFolderId": "final-folder-id",
  "sequenceByYear": {
    "2026": 8
  },
  "reservation": null
}
```

`driveId` is `null` for My Drive and set for a Shared Drive. Folder IDs, not names or paths, are authoritative. `folderName` is only a display hint.

`sequenceByYear` replaces local `lastInvoice` as the authority once Drive setup is active. At first activation, each known year is initialized to the maximum of:

- the highest valid invoice number found in the selected `Final` folder; and
- the existing local `lastInvoice`, when it belongs to that year.

The local `outputDir` and local `lastInvoice` are then no longer read for invoice behavior. They may be removed from the persisted schema through the normal config migration path.

Creation uses a pre-generated Drive file ID, then re-lists before and after the write so a simultaneous first setup cannot leave an unnoticed duplicate. Every later control-file mutation uses the file's HTTP ETag as an `If-Match` precondition. A failed precondition is treated as a cross-device conflict: reload, recompute, and require the operation to retry.

The Drive transport must expose response ETags and support conditional `If-Match` headers for both control-file and PDF mutations. The implementation must verify those semantics against the fake Drive server and real Drive before release; it must not ship with an unguarded read-modify-write fallback.

## Folder Selection and Layout

The in-app folder browser:

- lists My Drive and accessible Shared Drives;
- supports pagination and navigation;
- allows selection of an existing folder or creation of a new folder;
- sends the required shared-drive flags, including `supportsAllDrives=true` where applicable;
- displays only folders while browsing;
- validates the selected folder's current capabilities before activation.

The selected root must allow child listing and child creation. The app creates or locates exactly one direct child named `Final` and verifies that invoice files in it can be created and updated. Multiple direct `Final` folders are an error; the app never guesses between them.

The activation flow is staged:

1. Choose or create the root.
2. Locate or create its `Final` child.
3. Scan `Final` and show recognized files, warnings, and blocking conflicts.
4. Allow the user to copy existing PDFs manually and refresh the scan.
5. On explicit confirmation, conditionally write the complete pointer to the normal Drive control file.

Until step 5 succeeds, all devices keep using the previous remote pointer. Changing the root uses the same staged flow and warns that confirmation switches every device using the same Google account. It does not move or delete files.

## Drive Invoice Store

A platform-neutral `DriveInvoiceStore` owns all persistent finalized-invoice I/O. UI components and invoice logic do not call Drive directly.

Its responsibilities are:

- discover, load, and conditionally update the remote control file;
- browse, create, validate, and activate folders;
- list and classify finalized invoice PDFs;
- upload a new PDF and its metadata;
- replace an existing PDF while preserving its file ID;
- download and verify exact bytes for opening or attachment;
- adopt a recognized manually copied PDF by adding standard Drive metadata;
- normalize Drive errors into app-level states;
- pass Shared Drive parameters consistently.

The store exposes explicit loading, offline, permission, conflict, corruption, and retryable-error results. It does not silently fall back to local disk.

## File Identity and Metadata

The current filename remains human-readable and is used to recognize manually copied invoices. Drive file IDs are the persistent identity after discovery.

Every app-managed PDF has standard Drive `properties`, which are shared across the desktop and Android OAuth clients:

| Property             | Meaning                                        |
| -------------------- | ---------------------------------------------- |
| `lotusSchema`        | Metadata schema version                        |
| `lotusCalendarHash`  | Calendar identity/version used for the invoice |
| `lotusStudioSlug`    | Stable studio key                              |
| `lotusMonth`         | Invoice month, `YYYY-MM`                       |
| `lotusInvoiceNumber` | Full invoice number                            |
| `lotusSourceSha256`  | Hash of canonical invoice render input         |
| `lotusPdfSha256`     | Expected PDF byte checksum                     |
| `lotusOperationId`   | Idempotency key for the finalization operation |

The canonical source input contains every stable business value capable of changing the PDF or amount: calendar event identities and versions, class dates and times, studio identity and billing details, student counts, manual euro overrides, rates, line items, invoice number, totals, and the relevant rendering configuration. Stable key ordering and normalized dates/numbers are required before hashing. Volatile operation values such as `generatedAt`, `issueDate`, upload IDs, and current wall-clock time are excluded; exact rendered bytes, including the final issue date, are protected separately by `lotusPdfSha256`.

Consequently, devices with different local rates or billing configuration report the Drive invoice as stale instead of silently treating divergent PDFs as equivalent. Complete configuration synchronization is intentionally outside this design.

Drive's returned HTTP ETag, file `version`, `md5Checksum`/`sha256Checksum` where available, `properties`, and `capabilities` are retained with each scan result. The expected SHA-256 stored in `properties` is the app's cross-platform integrity check. Adoption and replacement send the captured ETag as an `If-Match` precondition.

References:

- [Drive file resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [File search](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

## Legacy File Recognition

A PDF without Lotus metadata is eligible for adoption only when:

- its filename parses under the current finalized-invoice filename format;
- it maps unambiguously to one studio and month; and
- no other file maps to the same studio and month.

An eligible file is displayed as finalized and initially fresh. During the same successful online scan, the app computes the current canonical source hash, downloads and hashes the exact PDF bytes, and adds the standard metadata without changing the file content, name, parent, or ID.

If adoption cannot be completed because metadata update or download permission is missing, the invoice remains visible but its finalized actions are blocked with a permission or verification error. A malformed PDF filename is shown as a warning. Duplicate mappings are blocking errors for the affected studio/month.

## Refresh and Derived State

The invoice view refreshes from Drive:

- when the Invoices tab opens;
- when the app resumes;
- on explicit refresh;
- immediately before every mutating invoice operation; and
- after every successful mutation.

For each current studio/month, the app compares the current canonical source hash with `lotusSourceSha256`:

- no matching Drive PDF: not finalized;
- matching hash and verified PDF checksum: finalized and fresh;
- different hash: finalized and stale;
- duplicate, malformed managed metadata, missing file, or checksum mismatch: blocked error.

This state is derived from Drive and current invoice input on every device. The current scan may live in memory for the active app session, but no persistent invoice-file or freshness cache is introduced. The existing SQLite invoice-freshness authority is retired; the unrelated Calendar cache remains unchanged.

## Finalization and Invoice Numbers

New finalization uses a short remote reservation recorded in the control file:

```json
{
  "operationId": "uuid",
  "year": 2026,
  "invoiceNumber": "9/2026",
  "studioSlug": "studio-a",
  "month": "2026-08",
  "fileId": "pre-generated-drive-file-id",
  "sourceSha256": "canonical-source-sha256",
  "startedAt": "2026-08-24T12:00:00Z"
}
```

Only one reservation may exist per Google account config. The sequence is:

1. Refresh the folder and control file.
2. Reject an existing duplicate or conflicting finalization.
3. Pre-generate a Drive file ID, then conditionally reserve the next number, file ID, and unique operation ID.
4. Render locally and upload the PDF with that file ID and all metadata in one multipart request.
5. Re-read the uploaded file and verify ID, parent, size, metadata, and checksum.
6. Conditionally advance `sequenceByYear` and clear the matching reservation.
7. Refresh the invoice view.

If a device encounters an interrupted reservation, it first reads the reserved file ID and also searches `Final` by `lotusOperationId`:

- exactly one verified completed upload: commit that number and clear the reservation;
- no upload: the originating operation may retry idempotently with the same reserved number;
- ambiguous or inconsistent result: block and require explicit recovery.

Numbers are never silently reused or skipped by a competing device.

## Re-finalization

Re-finalization does not allocate a number. It:

1. Refreshes the target file and current invoice input.
2. Captures the file ID, Drive version, remote checksum, and current source hash.
3. Renders the replacement locally using the existing invoice number.
4. Rechecks that the remote file still has the captured ETag/version/checksum.
5. Replaces the content and metadata of that same Drive file ID using the captured ETag as an `If-Match` precondition.
6. Re-reads and verifies the resulting checksum and metadata.

A concurrent change at steps 4-6 produces a visible conflict and no automatic overwrite retry.

## Open and Draft Email

`Open` downloads the selected Drive PDF, verifies its checksum, writes it to an app-specific temporary/cache location, and opens that disposable copy. A later cleanup may remove it.

`Draft Email` downloads and verifies the same authoritative Drive bytes and attaches those bytes to the Gmail draft. It never regenerates the attachment and never uses an older local copy.

Both actions are disabled while offline or while the selected file is unverified, corrupt, missing, duplicated, or inaccessible.

## Error and Retry Behavior

- No configured folder: show `Choose Drive folder`; finalized actions are disabled.
- Offline: preserve the current screen context, mark Drive data unavailable, and disable finalized actions.
- Revoked or insufficient scope: retain Calendar/Gmail access where still valid and request only the missing Drive authorization.
- Missing root or `Final` folder: show a blocking setup error; never recreate silently after activation.
- Permission loss: identify the unavailable capability and provide reselect/retry actions.
- Duplicate `Final` folder or duplicate invoice: block the affected setup or invoice.
- Checksum, metadata, or version mismatch: block open, email, and overwrite.
- Concurrent app-config/file mutation: reload and show a conflict; do not overwrite.
- Expired access token: refresh once, then surface authentication failure.
- Rate limiting and transient Google errors: bounded exponential backoff with jitter; never infinite retry.
- Interrupted upload: reconcile through `lotusOperationId` before any retry.

All errors remain visible in the invoice view and log panel with enough context to identify the Drive item and corrective action.

## Cross-Device Semantics

Devices signed into the same Google account discover the same owned My Drive control file and therefore load the same root pointer, `Final` folder, sequence, and reservations. A successful mutation becomes visible to another device on its next refresh even though desktop and Android use distinct OAuth clients.

The design does not attempt real-time push synchronization. Refresh-before-mutation plus conditional control-file writes and file version/checksum guards prevent a stale device from silently overwriting newer state.

A different Google account has its own owned control file, pointer, and invoice sequence, even if that account can access the same selected Shared Drive folder. Control-file discovery ignores files the current account does not own.

## Validation

### Unit Tests

- control-file discovery, schema parsing, migration, and invalid records;
- current and legacy filename parsing;
- canonical source serialization and hash stability;
- checksum, version, and capability validation;
- yearly sequence allocation and reservation recovery;
- finalization and re-finalization operation ordering;
- Drive-to-domain error mapping.

### Component Tests

- initial setup, folder navigation, selection, creation, scan, and confirmation;
- My Drive and Shared Drive variants;
- scope declined, loading, offline, permission loss, duplicates, and blocked actions;
- stale/fresh state derived from remote metadata;
- manual legacy-file adoption.

### Fake Google Server

Extend the existing fake Google service with ordinary My Drive control-file behavior:

- My Drive and Shared Drive listing with pagination;
- folder creation and capabilities;
- control-file and metadata search using standard `properties`;
- upload, replacement, download, checksums, versions, and ETags;
- `supportsAllDrives` enforcement;
- expired token, rate limit, transient failure, permission loss, interrupted upload, and failed precondition scenarios.

### Desktop E2E

- incremental authorization;
- select/create and activate a root;
- recognize manually copied PDFs;
- finalize, refresh, re-finalize, open, and draft email;
- switch roots without moving/deleting files;
- two independent app states sharing one fake Drive account;
- duplicate, missing, corrupt, concurrent, and permission-loss flows.

### Android Validation

- mobile component tests for the complete folder browser and invoice states;
- Android debug build;
- real emulator/device smoke covering authorization, folder browsing, finalization, open, and cross-device refresh against the same Google account.

### Release Gates

- `bun test`
- `bunx tsc --project tsconfig.app.json --noEmit`
- `bunx tsc --project tsconfig.json --noEmit`
- relevant Rust tests
- fake Google integration suite
- `bun run e2e`
- production OAuth/Drive seam checks
- Android debug build and device/emulator smoke
- OAuth consent-screen and restricted-scope verification readiness

## Manual Transition

The transition is deliberate and user-controlled:

1. Create or choose the intended Drive root.
2. Ensure it contains exactly one `Final` child.
3. Manually copy the existing local finalized PDFs into that `Final` folder.
4. In the app, select the root, refresh the staged scan, resolve any duplicate or malformed entries, and confirm activation.
5. Open the app on the other device and verify that the same root and invoice view load.

Activation is the single cutover point. After it succeeds, Drive is the only authority for finalized invoices. The old local files remain untouched but are ignored by the app.
