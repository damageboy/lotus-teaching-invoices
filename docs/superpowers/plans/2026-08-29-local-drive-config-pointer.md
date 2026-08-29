# Local Drive Configuration Pointer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist only the selected Drive configuration file ID locally, use it for direct normal startup, retain confirmed discovery for initial/recovery runs, and make Drive the first onboarding step so an existing configuration can supply Calendar selection.

**Architecture:** A strict local pointer repository wraps new Tauri app-storage commands. `DriveConfigRepository` and `DriveInvoiceStore` gain explicit direct-load and recovery-discovery APIs; `useDriveInvoices` becomes the stale-safe coordinator that installs pointers only after remote validation. Setup derives readiness from pointer/bootstrap state, presents Drive discovery and folder choice first, validates any recovered Calendar, and creates a new config only after Calendar selection.

**Tech Stack:** Tauri 2/Rust, React 19, TypeScript, Vitest/Testing Library, existing Google Drive and Calendar transports.

**Spec:** `docs/superpowers/specs/2026-08-29-local-drive-config-pointer-design.md`

## Global Constraints

- Store only pointer framing plus `configFileId`; never persist YAML, folder metadata, Calendar fields, Drive snapshots, or onboarding completion.
- Normal startup with a valid pointer must issue no Drive-wide configuration list query.
- Initial/recovery discovery requires confirmation even when exactly one config is found.
- Multiple discovered configs must be directly selectable and must not block devices with a valid pointer.
- Drive is setup step 1; Calendar is step 2 only when the selected configuration has no accessible Calendar.
- Retryable Drive/Calendar failures never clear or replace the local pointer.
- Pointer installation occurs only after full remote validation and uses expected-raw compare-and-write semantics.
- Preserve ETag conflict handling, invoice-number allocation, selected-root derivation from the config's parent, and stale-async/A-to-B-to-A protections.
- Preserve unrelated untracked `docs/superpowers/plans/2026-08-28-drive-setup-races.md` and generated Android directories.
- Use `bun run test`, not Bun's built-in `bun test`, for the configured Vitest suite.

---

### Task 1: Strict Cross-Platform Local Pointer Storage

**Files:**

- Modify: `src-tauri/src/app_storage.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/lib/drive/configPointer.ts`
- Create: `tests/drive/configPointer.test.ts`

**Interfaces:**

- Produces Rust commands `read_drive_config_pointer() -> Option<String>` and `write_drive_config_pointer(raw: String, expected_raw: Option<String>) -> StorageWriteOutcome`.
- Produces TypeScript `DriveConfigPointerRead`, `readDriveConfigPointer()`, and `installDriveConfigPointer(fileId, expectedRaw)`.
- The serialized schema is exactly `{ version: 1, configFileId: string }` with strict keys.

- [ ] **Step 1: Add failing TypeScript parser and command tests**

Create tests covering absent, valid, malformed JSON, unknown version, blank ID, array/null, and extra fields. Define the required result shape in the test:

```ts
expect(parseDriveConfigPointer(null)).toEqual({ kind: 'absent', raw: null });
expect(parseDriveConfigPointer('{"version":1,"configFileId":"file-1"}')).toEqual({
  kind: 'valid',
  raw: '{"version":1,"configFileId":"file-1"}',
  fileId: 'file-1',
});
expect(parseDriveConfigPointer('{"version":1,"configFileId":""}')).toMatchObject({
  kind: 'invalid',
});
```

Mock Tauri `invoke` and prove `installDriveConfigPointer('file-2', oldRaw)` sends strict JSON plus `expectedRaw`, accepts durable/uncertain outcomes, and throws a typed conflict on `{status:'conflict'}`.

- [ ] **Step 2: Run the pointer tests and verify failure**

Run: `bunx vitest run tests/drive/configPointer.test.ts`

Expected: FAIL because `src/lib/drive/configPointer.ts` does not exist.

- [ ] **Step 3: Implement the strict TypeScript pointer repository**

Create these public types and functions:

```ts
export const DRIVE_CONFIG_POINTER_VERSION = 1 as const;

export type DriveConfigPointerRead =
  | { kind: 'absent'; raw: null }
  | { kind: 'valid'; raw: string; fileId: string }
  | { kind: 'invalid'; raw: string; message: string };

export function parseDriveConfigPointer(raw: string | null): DriveConfigPointerRead;
export async function readDriveConfigPointer(): Promise<DriveConfigPointerRead>;
export async function installDriveConfigPointer(
  fileId: string,
  expectedRaw: string | null
): Promise<{ raw: string; fileId: string }>;
```

Use exact-key validation (`version`, `configFileId` only), preserve the original raw string in read results, serialize with `JSON.stringify({version:1, configFileId:fileId}, null, 2)`, and map CAS conflict to a dedicated `DriveConfigPointerConflictError`.

- [ ] **Step 4: Add failing Rust app-storage tests**

In `app_storage.rs`, add tests proving:

- missing pointer returns `None`;
- compare-and-write installs bytes with mode `0600` on Unix;
- wrong expected raw returns `Conflict` without changing bytes;
- replacement is atomic and returns `Durable` or `CommittedButDurabilityUncertain`;
- an unrelated live temp writer is preserved and a stale owned temp writer is cleaned;
- auth and pointer writes use distinct lock files and do not alter each other.

- [ ] **Step 5: Run the Rust tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_storage::tests::drive_config_pointer -- --nocapture`

Expected: FAIL because pointer paths/methods do not exist.

- [ ] **Step 6: Implement Rust pointer persistence and commands**

Add:

```rust
const DRIVE_CONFIG_POINTER_FILE: &str = "drive-config-pointer.json";
const DRIVE_CONFIG_POINTER_LOCK_FILE: &str = ".drive-config-pointer.lock";
static DRIVE_CONFIG_POINTER_WRITE_MUTEX: Mutex<()> = Mutex::new(());
```

Add `drive_config_pointer_path`, `read_drive_config_pointer`, and `compare_and_write_drive_config_pointer` using the existing atomic-write and file-lock pattern. Include pointer temp files in owned-temp cleanup. Expose Tauri commands named `read_drive_config_pointer` and `write_drive_config_pointer` in both production and WebDriver handlers.

- [ ] **Step 7: Run focused tests and type checks**

Run:

```bash
bunx vitest run tests/drive/configPointer.test.ts
cargo test --manifest-path src-tauri/Cargo.toml app_storage
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 8: Commit pointer storage**

```bash
git add src-tauri/src/app_storage.rs src-tauri/src/lib.rs src/lib/drive/configPointer.ts tests/drive/configPointer.test.ts
git commit -m "feat: persist Drive config file pointer"
```

---

### Task 2: Direct Config Lookup and Recovery Candidate Discovery

**Files:**

- Modify: `src/lib/drive/configFile.ts`
- Modify: `src/lib/drive/folders.ts`
- Modify: `src/lib/drive/invoiceStore.ts`
- Modify: `tests/drive/configFile.test.ts`
- Modify: `tests/drive/invoiceStore.test.ts`
- Modify: `tests/drive/memoryDriveApi.ts` if call-history helpers are missing

**Interfaces:**

- Consumes: strict `configFileId` from Task 1.
- Produces `DriveConfigCandidate`, `DriveRecoveryDiscovery`, `DriveInvoiceStore.loadByFileId`, `discoverRecovery`, and `adoptRecoveryCandidate`.
- `DriveInvoiceStore.refresh()` reloads the currently selected file ID directly.

- [ ] **Step 1: Add failing repository direct-load tests**

Prove `loadByFileId('config-1')` performs exact `getFile` plus `downloadFile`, returns the validated snapshot, and performs zero `listFiles` calls. Cover wrong ID response, wrong marker/name/MIME, trashed, missing ETag, invalid YAML, and invalid/multiple parents.

- [ ] **Step 2: Add failing recovery-discovery tests**

Define:

```ts
export interface DriveConfigCandidate {
  fileId: string;
  kind: 'configured' | 'legacy';
  root: DriveRoot;
  rootFile: DriveFileRecord;
  calendarName: string | null;
}

export interface DriveRecoveryDiscovery {
  candidates: DriveConfigCandidate[];
  issues: Array<{ fileId: string; message: string }>;
}
```

Test zero, one, multiple, current-plus-legacy, My Drive/shared Drive, pagination, repeated IDs, deterministic folder-name/file-ID ordering, and corrupt/inaccessible candidates reported as issues rather than silently adopted.

- [ ] **Step 3: Run repository tests and verify failure**

Run: `bunx vitest run tests/drive/configFile.test.ts`

Expected: FAIL because direct load and candidate APIs are absent.

- [ ] **Step 4: Implement repository APIs**

Make current-file exact loading public as:

```ts
async loadByFileId(fileId: string): Promise<DriveConfigSnapshot>;
async discoverCandidates(): Promise<DriveConfigDiscoveryCandidate[]>;
async listDirectChildren(parentId: string): Promise<DriveConfigDiscoveryCandidate[]>;
```

`discoverCandidates` retains the existing current and legacy queries but returns every deduplicated candidate instead of collapsing multiple IDs into a conflict. `listDirectChildren` adds `'<parentId>' in parents` to both exact queries and never scans unrelated folders. Keep `discover()` temporarily for migration callers until Task 3 removes normal-boot dependence.

- [ ] **Step 5: Add failing store identity tests**

Test these exact behaviors:

- `loadByFileId('config-1', sources)` publishes the pointed root and performs no discovery;
- `refresh()` reloads `config-1` directly after unrelated `config-2` appears;
- moving/renaming the parent keeps `config-1` selected;
- `discoverRecovery()` returns validated candidate summaries without selecting one;
- `adoptRecoveryCandidate('config-2', ...)` reloads and validates the candidate before selecting it;
- legacy adoption migrates only the explicitly selected legacy ID using the supplied local YAML;
- root changes move the selected file ID and do not discover another config.

- [ ] **Step 6: Run store tests and verify failure**

Run: `bunx vitest run tests/drive/invoiceStore.test.ts`

Expected: FAIL because the store APIs and selected-ID state do not exist.

- [ ] **Step 7: Implement direct store identity and recovery**

Add:

```ts
async loadByFileId(
  fileId: string,
  sources: readonly CurrentInvoiceSource[]
): Promise<DriveStoreSnapshot>;

async discoverRecovery(legacyLocalYaml?: string): Promise<DriveRecoveryDiscovery>;

async adoptRecoveryCandidate(
  fileId: string,
  sources: readonly CurrentInvoiceSource[],
  legacyLocalYaml?: string
): Promise<DriveStoreSnapshot>;
```

Store `selectedConfigFileId` only in process memory after successful load/adoption/create. Rewrite `refreshInternal` to require and directly reload that ID. Rewrite root changes to move the current snapshot's file rather than running whole-Drive discovery. Add selected-folder inspection that returns candidates from `listDirectChildren` before creating a config.

- [ ] **Step 8: Run focused Drive tests**

Run:

```bash
bunx vitest run tests/drive/configFile.test.ts tests/drive/invoiceStore.test.ts tests/drive/folders.test.ts
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 9: Commit direct Drive identity**

```bash
git add src/lib/drive/configFile.ts src/lib/drive/folders.ts src/lib/drive/invoiceStore.ts tests/drive/configFile.test.ts tests/drive/invoiceStore.test.ts tests/drive/memoryDriveApi.ts
git commit -m "refactor: load selected Drive config by file ID"
```

---

### Task 3: Pointer-Aware Bootstrap and Confirmed Recovery

**Files:**

- Modify: `src/hooks/useDriveInvoices.ts`
- Modify: `src/hooks/useDriveSetupSnapshot.ts`
- Modify: `tests/hooks/useDriveInvoices.test.tsx`
- Modify: `tests/hooks/useDriveSetupSnapshot.test.tsx`

**Interfaces:**

- Consumes: Task 1 `DriveConfigPointerRead` and installer; Task 2 store direct/recovery APIs.
- Produces recovery-aware `DriveInvoicesState` with candidate confirmation and selected-folder inspection.

- [ ] **Step 1: Add failing hook tests for direct bootstrap**

Extend options with:

```ts
pointer: DriveConfigPointerRead;
installPointer(fileId: string, expectedRaw: string | null): Promise<{ raw: string; fileId: string }>;
```

Test valid pointer direct load, no discovery, refresh by selected ID, absent/invalid pointer recovery discovery, retryable direct-load error preserving pointer, and definitive direct-load error exposing recovery without writing/deleting anything.

- [ ] **Step 2: Add failing confirmation tests**

Extend state with:

```ts
export interface DriveRecoveryState {
  candidates: readonly DriveConfigCandidate[];
  issues: readonly DriveRecoveryIssue[];
  previousPointerRaw: string | null;
}

confirmRecoveryCandidate(fileId: string): Promise<DriveStoreSnapshot>;
```

Prove one candidate is not auto-installed, multiple candidates remain ordered, confirmation validates remotely before CAS installation, pointer conflict rejects stale confirmation, failed local installation does not publish ready state, and close/reopen plus authorization A-to-B-to-A cannot install stale IDs.

- [ ] **Step 3: Run hook tests and verify failure**

Run: `bunx vitest run tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx`

Expected: FAIL on the new pointer/recovery contract.

- [ ] **Step 4: Implement recovery-aware machine state**

Add `recovery: DriveRecoveryState | null` to machine/public state and add status `confirmationRequired`. Bootstrap rules:

```ts
pointer.kind === 'valid'
  ? store.loadByFileId(pointer.fileId, sources)
  : store.discoverRecovery(legacyLocalYaml);
```

Classify retryable `DriveStoreError` as `offline`/`blocked` without recovery; classify definitive identity/content errors as recovery with the pointed raw retained. Candidate confirmation runs through the existing serialized mutation queue, adopts the exact ID, CAS-installs the pointer, then publishes the snapshot. It does not perform a post-install global discovery.

- [ ] **Step 5: Make activation install verified new IDs safely**

Change activation to return one of:

```ts
type DriveRootResolution =
  | { kind: 'activated'; snapshot: DriveStoreSnapshot }
  | { kind: 'confirmationRequired'; recovery: DriveRecoveryState }
  | { kind: 'calendarRequired'; stagedRoot: StagedDriveRoot };
```

Existing selected configs keep the same pointer on root move. A selected folder containing existing configs returns confirmation state. A selected empty folder returns session-only staged state. Newly created/verified configs install their ID before ready is published.

- [ ] **Step 6: Preserve snapshot evidence only for pointed ready state**

Update `useDriveSetupSnapshot` so `confirmationRequired` and empty-folder staging are not treated as configured. Retryable errors may retain an already validated pointed snapshot; absent/dead recovery clears it.

- [ ] **Step 7: Run focused hook tests and type checks**

Run:

```bash
bunx vitest run tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 8: Commit pointer-aware bootstrap**

```bash
git add src/hooks/useDriveInvoices.ts src/hooks/useDriveSetupSnapshot.ts tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx
git commit -m "feat: confirm Drive config recovery before adoption"
```

---

### Task 4: Validate Recovered Calendar and Reorder Readiness

**Files:**

- Modify: `src/hooks/useCalendarPicker.ts`
- Modify: `src/lib/setup/readiness.ts`
- Modify: `src/hooks/useSetupOnboarding.ts`
- Modify: `tests/hooks/useCalendarPicker.test.tsx`
- Modify: `tests/lib/setup/readiness.test.ts`
- Modify: `tests/hooks/useSetupOnboarding.test.tsx`

**Interfaces:**

- Consumes: a confirmed remote config from Task 3.
- Produces `CalendarConnectionStatus` and Drive-first `SetupReadiness`.

- [ ] **Step 1: Add failing Calendar validation tests**

Add this controller state:

```ts
export type CalendarConnectionStatus =
  | 'unchecked'
  | 'checking'
  | 'accessible'
  | 'missing'
  | 'unavailable';
```

Test that a confirmed config with `calendarId` lists Calendars non-interactively, marks an exact ID accessible, refreshes changed `calendarName` and `calendarAccessRole` through `saveConfig`, marks absent ID missing without changing config, and maps transient list failure to unavailable with Retry. Add stale ID/account/source and A-to-B-to-A tests.

- [ ] **Step 2: Run Calendar picker tests and verify failure**

Run: `bunx vitest run tests/hooks/useCalendarPicker.test.tsx`

Expected: FAIL because configured Calendar validation state is absent.

- [ ] **Step 3: Implement configured Calendar validation**

Extend `CalendarPickerController` with `connectionStatus` and `retryValidation()`. Validate only when a confirmed Drive snapshot supplies config. Deduplicate validation per Calendar identity and authorization incarnation. If live name/role differs, use the existing serialized config save; ETag conflict follows existing save behavior.

- [ ] **Step 4: Add failing Drive-first readiness/onboarding tests**

Replace Boolean Calendar readiness input with `calendarStatus`. Prove:

- unresolved Drive is always first/checking even when Calendar is absent;
- no confirmed Drive makes `firstIncompleteStep === 'drive'`;
- confirmed Drive plus checking Calendar remains checking;
- confirmed Drive plus accessible Calendar is ready;
- confirmed Drive plus missing Calendar yields Calendar step;
- transient Calendar unavailable keeps Calendar step with Retry;
- wizard session state advances Drive to Calendar only when needed.

- [ ] **Step 5: Implement Drive-first readiness and onboarding**

Derive:

```ts
const driveConfigured = input.hasDrive && input.driveSnapshot !== null;
const calendarConfigured = driveConfigured && input.calendarStatus === 'accessible';
const firstIncompleteStep = !driveConfigured ? 'drive' : !calendarConfigured ? 'calendar' : null;
```

Update onboarding step tracking so Drive is step 1 and Calendar step 2, while dismissal and completion-origin behavior remain session-only.

- [ ] **Step 6: Run focused tests and type checks**

Run:

```bash
bunx vitest run tests/hooks/useCalendarPicker.test.tsx tests/lib/setup/readiness.test.ts tests/hooks/useSetupOnboarding.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit Calendar-second readiness**

```bash
git add src/hooks/useCalendarPicker.ts src/lib/setup/readiness.ts src/hooks/useSetupOnboarding.ts tests/hooks/useCalendarPicker.test.tsx tests/lib/setup/readiness.test.ts tests/hooks/useSetupOnboarding.test.tsx
git commit -m "feat: validate Calendar after Drive recovery"
```

---

### Task 5: Drive-First Recovery and Candidate UI

**Files:**

- Modify: `src/components/setup/SetupWizard.tsx`
- Modify: `src/hooks/useDriveFolderController.ts`
- Modify: `src/components/setup/DriveFolderDialog.tsx` only if direct-folder config inspection needs a presentation seam
- Modify: `tests/components/SetupWizard.test.tsx`
- Modify: `tests/hooks/useDriveFolderController.test.tsx`
- Modify: `tests/components/DriveFolderDialog.test.tsx`

**Interfaces:**

- Consumes: Task 3 recovery candidates/actions and Task 4 Drive-first step order.
- Produces confirmation UI, multiple candidate selection, and session-only empty-folder staging.

- [ ] **Step 1: Add failing wizard presentation tests**

Prove the progress indicator and copy show Drive as `Step 1 of 2` and Calendar as step 2. For one candidate, require exact copy `Found existing configuration in “LotusInvoices”` and no pointer installation before `Use this configuration`. For many candidates, render each folder and stored Calendar name plus `Choose another folder`.

- [ ] **Step 2: Add failing interaction/stale-session tests**

Cover candidate confirmation busy/error behavior, choosing another folder, desktop Escape/focus, Android Back, candidate changes while confirmation is pending, close/reopen, and authorization incarnation changes. Old completions must not close or advance a new wizard session.

- [ ] **Step 3: Run wizard tests and verify failure**

Run: `bunx vitest run tests/components/SetupWizard.test.tsx`

Expected: FAIL on Drive-first copy and candidate controls.

- [ ] **Step 4: Implement candidate confirmation UI**

Replace `detectedDriveFolderName`/`driveAcknowledgementRequired` with typed recovery props from `DriveInvoicesState`. Each candidate button invokes `confirmRecoveryCandidate(candidate.fileId)`. One candidate still renders a confirmation card; many render a list. Keep `Choose another folder…` in both states.

- [ ] **Step 5: Add failing folder-controller tests**

Prove selected-folder behavior:

- direct child config produces candidate confirmation and does not create/move anything;
- multiple direct child configs produce the localized list;
- empty folder is retained only in controller memory and advances to Calendar;
- closing/reopening discards staged empty-folder state;
- existing ready config root change moves the same ID;
- stale scan/confirm results cannot publish candidates or staged roots.

- [ ] **Step 6: Implement folder inspection and staging**

Extend `DriveFolderController` with `pendingNewRoot`, `clearPendingNewRoot`, and `completePendingNewRoot(config)`. Confirming an empty root stages it; after Calendar selection, completion calls config creation once, verifies it, installs its pointer through Task 3, and clears staging. Existing-config roots flow into recovery confirmation instead.

- [ ] **Step 7: Run setup UI tests and type checks**

Run:

```bash
bunx vitest run tests/components/SetupWizard.test.tsx tests/hooks/useDriveFolderController.test.tsx tests/components/DriveFolderDialog.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 8: Commit Drive-first UI**

```bash
git add src/components/setup/SetupWizard.tsx src/hooks/useDriveFolderController.ts src/components/setup/DriveFolderDialog.tsx tests/components/SetupWizard.test.tsx tests/hooks/useDriveFolderController.test.tsx tests/components/DriveFolderDialog.test.tsx
git commit -m "feat: make Drive the first setup step"
```

---

### Task 6: Integrate App Bootstrap, Pointer Loading, and New-Config Completion

**Files:**

- Modify: `src/App.tsx`
- Modify: `tests/components/App-setup.test.tsx`
- Modify: `tests/components/App-drive-setup.test.tsx`
- Modify: `tests/components/ConnectionsSection.test.tsx` if props change
- Modify: `tests/components/RatesTab-calendar-picker.test.tsx` if props change

**Interfaces:**

- Consumes all Tasks 1-5 interfaces.
- Produces complete application startup and onboarding behavior.

- [ ] **Step 1: Add failing App startup tests**

Test these integrated states:

- pointer read resolves before Drive bootstrap;
- valid pointer loads exact file and bypasses discovery;
- pointerless one-candidate discovery shows confirmation;
- pointerless multi-candidate discovery shows folder choices;
- no candidate starts Drive folder selection before Calendar;
- recovered accessible Calendar skips Calendar UI;
- recovered missing Calendar opens Calendar second;
- empty-folder staging plus Calendar selection creates one config and stores its verified ID;
- transient Drive/Calendar failures show Retry and preserve pointer/staging correctly;
- definitive dead pointer enters recovery without overwriting old raw storage.

- [ ] **Step 2: Run App tests and verify failure**

Run: `bunx vitest run tests/components/App-setup.test.tsx tests/components/App-drive-setup.test.tsx`

Expected: FAIL because App does not read/pass pointer state or new recovery actions.

- [ ] **Step 3: Integrate pointer loading and direct bootstrap**

Load the pointer once through `readDriveConfigPointer`, include its load completion in startup checking, and pass it plus CAS installer into `useDriveInvoices`. Remove the old assumption that discovery always establishes remote config. Keep legacy local YAML loading only for one-time legacy candidate migration.

- [ ] **Step 4: Integrate Drive-first setup and Calendar validation**

Pass Calendar connection status to readiness. Drive recovery confirmation sets remote config; Calendar validation then either completes setup or opens Calendar. For a pending empty root, successful Calendar selection triggers exactly one `completePendingNewRoot(config)` operation before readiness can become ready.

- [ ] **Step 5: Preserve post-setup settings behavior**

Changing Calendar from Connections updates the pointed config. Changing Drive root moves the same pointed config and leaves local pointer unchanged. Existing navigation gating, completion-origin navigation, migration cleanup, and invoice-source suppression continue to work.

- [ ] **Step 6: Run integrated component tests**

Run:

```bash
bunx vitest run tests/components/App-setup.test.tsx tests/components/App-drive-setup.test.tsx tests/components/ConnectionsSection.test.tsx tests/components/RatesTab-calendar-picker.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit App integration**

```bash
git add src/App.tsx tests/components/App-setup.test.tsx tests/components/App-drive-setup.test.tsx tests/components/ConnectionsSection.test.tsx tests/components/RatesTab-calendar-picker.test.tsx
git commit -m "feat: bootstrap Lotus from local Drive config pointer"
```

---

### Task 7: Desktop and Android E2E Recovery Coverage

**Files:**

- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `src/e2eBridge.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/fake-google-calendar.ts`
- Modify: `tests/e2e/drive-invoices.e2e.ts`
- Modify: `tests/fixtures/e2e-google-drive.json` only when fixture fields are required

**Interfaces:**

- Consumes completed app behavior.
- Produces isolated E2E seeding/inspection for pointer raw state and Drive API call history.

- [ ] **Step 1: Add failing E2E bridge tests/seams**

Extend runtime seed/status with optional pointer raw and expose only pointer file ID/status—not Google tokens or config contents. Add fake Drive call counters for global list, exact get/download, and create/update.

- [ ] **Step 2: Implement isolated pointer seeding and status**

Write pointer bytes only inside the existing E2E data root, validate the same direct-child/run-marker constraints, and include the pointer path in cleanup verification. Production builds must not expose these commands.

- [ ] **Step 3: Add E2E scenarios**

Cover:

1. Existing pointer: direct config load, zero global config discovery, app opens Calendar.
2. First run with one config: confirmation appears; restart after confirmation uses direct lookup.
3. First run with two configs: choose one folder; restart ignores the other duplicate.
4. No config: Drive folder first, Calendar second, one config created, pointer installed.
5. Dead pointer: recovery confirmation replaces it only after user action.
6. Retryable Drive failure: pointer remains and onboarding does not claim unconfigured.
7. Recovered config with deleted Calendar: Calendar step updates the same config ID.
8. Folder rename/move: direct ID remains usable and current parent name is shown.

- [ ] **Step 4: Run focused E2E**

Run: `bun run e2e -- tests/e2e/drive-invoices.e2e.ts`

Expected: all Drive setup scenarios pass in an isolated runtime.

- [ ] **Step 5: Build and smoke Android**

Run the repository's Android debug build/emulator command against `Lotus_API_36`. Verify first-run discovery confirmation, multiple-config choice, Back cancellation, config adoption, restart direct lookup, and Calendar-second fallback. Do not log access tokens.

- [ ] **Step 6: Commit E2E coverage**

```bash
git add src-tauri/src/e2e_support.rs src/e2eBridge.ts tests/e2e/helpers.ts tests/e2e/fake-google-calendar.ts tests/e2e/drive-invoices.e2e.ts tests/fixtures/e2e-google-drive.json
git commit -m "test: cover Drive config pointer recovery"
```

---

### Task 8: Full Verification and Documentation Consistency

**Files:**

- Modify: `docs/superpowers/specs/2026-08-26-google-setup-onboarding-design.md`
- Modify: `docs/superpowers/specs/2026-08-27-cloud-config-unification-design.md`
- Modify: `docs/superpowers/plans/2026-08-26-google-setup-onboarding.md` only if it is presented as current behavior
- Modify: `docs/superpowers/plans/2026-08-27-cloud-config-unification.md` only if it is presented as current behavior

**Interfaces:**

- Produces truthful current architecture documentation and verified release evidence.

- [ ] **Step 1: Update superseded architecture statements**

Replace statements that prohibit a local selected-root pointer or require whole-Drive discovery every startup. State that only the config file ID is cached locally, Drive YAML remains sole configuration authority, discovery is initial/recovery only, and setup is Drive-first/Calendar-second.

- [ ] **Step 2: Run focused feature gates**

Run:

```bash
bun run verify:drive-invoices
bun run verify:calendar-editing
cargo test --manifest-path src-tauri/Cargo.toml app_storage
```

Expected: all pass.

- [ ] **Step 3: Run complete tests and type checks**

Run:

```bash
bun run test
bunx tsc --project tsconfig.app.json --noEmit
bunx tsc --project tsconfig.json --noEmit
```

Expected: all pass with no test-count regressions.

- [ ] **Step 4: Run integrated desktop E2E**

Run: `bun run e2e`

Expected: all existing and new desktop scenarios pass.

- [ ] **Step 5: Verify source/storage boundaries**

Run:

```bash
rg -n "localStorage|sessionStorage|indexedDB" src
rg -n "configFileId|drive-config-pointer" src src-tauri/src
git diff --check
git status --short
```

Expected: no browser-storage implementation, no YAML/config fields in pointer serialization, clean diff, and only known unrelated untracked Android artifacts/plan remain.

- [ ] **Step 6: Commit documentation updates**

```bash
git add docs/superpowers/specs/2026-08-26-google-setup-onboarding-design.md docs/superpowers/specs/2026-08-27-cloud-config-unification-design.md docs/superpowers/plans/2026-08-26-google-setup-onboarding.md docs/superpowers/plans/2026-08-27-cloud-config-unification.md
git commit -m "docs: document pointed Drive config startup"
```

- [ ] **Step 7: Review final branch scope**

Inspect `git log --oneline` and `git diff HEAD~8..HEAD --stat`. Confirm every commit belongs to the approved pointer/onboarding change, no unrelated file was staged, and the embedded OAuth-secret regression remains explicitly outside this implementation rather than being silently modified.
