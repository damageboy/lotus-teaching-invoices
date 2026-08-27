# Google Drive Configuration Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop application's local `config.yaml` and Drive `.lotus-teaching-invoices.json` with one ETag-protected `lotus-invoices-config.yaml` in the invoice root, while renaming the local desktop token record to `google-tokens.json`.

**Architecture:** The Drive configuration file becomes the only durable application authority. `DriveConfigRepository` discovers, validates, creates, conditionally replaces, moves, and migrates that file. `DriveInvoiceStore` owns the current configuration snapshot together with the derived root and invoice scan. The React configuration hook keeps only an in-memory edit draft and writes through the store. Invoice finalization increments `invoiceSequenceByYear` with `If-Match` before rendering/uploading, allowing deliberate gaps and eliminating reservations and recovery.

**Tech Stack:** React 19, TypeScript 5.6, YAML 2.6, Zod 3.22, Vitest, Testing Library, Tauri 2/Rust, Google Drive API v2 ETags plus v3 metadata/media, WebdriverIO.

**Spec:** `docs/superpowers/specs/2026-08-27-cloud-config-unification-design.md`

## Global Constraints

- The remote filename is exactly `lotus-invoices-config.yaml`, MIME type is `application/yaml`, and the existing property `lotusConfigSchema=1` remains the marker.
- The file has exactly one parent; that actual parent is the invoice root. Do not persist root ID, Drive ID, folder name, or `Final` folder ID in YAML or locally.
- Preserve the current teacher, Calendar, studio, rate, email, and color YAML structure. Add only `invoiceSequenceByYear`.
- The unified YAML must not contain `outputDir`, `lastInvoice`, `schemaVersion`, `generation`, `root`, `finalFolderId`, `sequenceByYear`, or `reservation`.
- Every configuration write, counter increment, migration, and root move uses the currently held ETag. Never merge after a 412 response.
- A new invoice number is consumed before render/upload. A later failure leaves a gap and no recovery state.
- Re-finalization preserves the existing file ID and invoice number and never changes `invoiceSequenceByYear`.
- Migration updates the existing `.lotus-teaching-invoices.json` file ID in place and verifies the downloaded result before deleting the local configuration.
- If both legacy and unified remote files exist, or both old and new desktop token files exist, block explicitly.
- The standalone CLI keeps accepting an explicit local `--config`; it does not become application authority.
- Calendar cache, logs, prompt preferences, temporary PDFs, and test/runtime caches remain local and are out of scope.
- Preserve authorization-incarnation and source-incarnation checks after every asynchronous boundary.
- Use focused tests and TypeScript checks after each task. Run `bun run e2e` only at the final integrated checkpoint.

## File Structure

### New files

- `src/lib/drive/configFile.ts` — unified YAML repository, exact discovery, ETag writes, sequence allocation, and legacy JSON migration.
- `tests/drive/configFile.test.ts` — repository, schema, ETag, move, allocation, and migration coverage.
- `docs/release/cloud-config-migration.md` — repeatable backup, migration, verification, additional-profile, and rollback instructions.

### Deleted files

- `src/lib/drive/controlFile.ts` — replaced by `configFile.ts`; reservation/control state no longer exists.
- `tests/drive/controlFile.test.ts` — replaced by `configFile.test.ts`.

### Existing files changed

- `src/lib/types.ts` — make `invoiceSequenceByYear` part of `AppConfig`; remove legacy local fields.
- `src/lib/config/schema.ts` — validate the unified exact schema and expose a separate legacy-local migration parser.
- `src/lib/config/defaults.ts`, `config.example.yaml`, `tests/fixtures/e2e-config.yaml` — include an empty sequence map and no legacy storage fields.
- `src/lib/config/loader.ts`, `src/cli/main.ts`, `tests/config/loader.test.ts`, `tests/config/serialization.test.ts` — keep explicit CLI config loading separate from cloud application loading.
- `src/lib/drive/folders.ts`, `tests/drive/folders.test.ts` — own the operational root type and resolve the single direct `Final` child from the config file parent.
- `src/lib/drive/invoiceStore.ts`, `tests/drive/invoiceStore.test.ts` — use configuration snapshots, allocate before upload, and delete reservation/recovery logic.
- `src/hooks/useDriveInvoices.ts`, `tests/hooks/useDriveInvoices.test.tsx` — expose cloud-config saves, accept migrated/created config, and remove recovery operations.
- `src/hooks/useConfig.ts`, `tests/hooks/useConfig.test.tsx` — retain only an in-memory draft and save through Drive using the snapshot ETag.
- `src/hooks/useDriveFolderController.ts`, `tests/hooks/useDriveFolderController.test.tsx` — create/move the same config file instead of writing and cleaning a local root seed.
- `src/hooks/useDriveSetupSnapshot.ts`, `tests/hooks/useDriveSetupSnapshot.test.tsx` — preserve the last current cloud snapshot only for transient presentation states.
- `src/App.tsx` and App/component tests — authorize and discover Drive before exposing config-dependent behavior.
- `src/components/InvoicesTab/index.tsx`, `src/components/InvoicesTab/MobileInvoices.tsx`, and their tests — remove reservation recovery UI.
- `src/lib/invoice/rows.ts` and fingerprint/row tests — hash the unified config directly without legacy-field stripping.
- `src-tauri/src/app_storage.rs` — atomically migrate token filenames and provide verified legacy-config read/removal commands.
- `src-tauri/src/lib.rs` — register the legacy-config migration commands.
- `src/lib/gmail/constants.ts` and auth/build tests — rename the desktop token constant.
- `tests/drive/memoryDriveApi.ts` — model rename/MIME/parent/media ETag updates used by config migration and root moves.
- `tests/e2e/fake-google-calendar.ts`, `tests/fixtures/e2e-google-drive.json`, `tests/e2e/helpers.ts`, `tests/e2e/drive-invoices.e2e.ts`, `tests/e2e/smoke.e2e.ts` — seed and verify unified Drive config, migration, fresh-device boot, conflicts, and sequence gaps.
- `README.md`, `docs/release/google-drive-invoice-storage-checklist.md`, `package.json` — document cloud authority and include the new focused tests in the Drive gate.

---

### Task 1: Unified Configuration Schema and YAML Codec

**Files:**

- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `src/lib/config/loader.ts`
- Modify: `src/lib/config/defaults.ts`
- Modify: `src/lib/invoice/rows.ts`
- Modify: `config.example.yaml`
- Modify: `tests/fixtures/e2e-config.yaml`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/config/serialization.test.ts`
- Modify: `tests/invoice/sourceFingerprint.test.ts`
- Modify: `tests/invoice/rows.test.ts`

**Interfaces:**

- `AppConfig.invoiceSequenceByYear: Record<string, number>` is always present.
- `parseConfigYaml(raw: string): AppConfig` and `serializeConfigYaml(config: AppConfig): string` are the single cloud codec.
- `parseLegacyLocalConfigYaml(raw: string): { config: AppConfig; lastInvoice?: string }` accepts the old local-only fields for migration, removes them, and seeds an empty sequence map.
- `loadConfig(path)` remains the CLI file loader and returns the normalized `AppConfig` without creating application authority.

- [ ] **Step 1: Replace legacy-field expectations with failing unified-schema tests**

Add exact assertions:

```ts
const config = parseConfigYaml(`
teacher: {}
studios:
  Studio:
    fullName: Studio
    address: ''
    rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }]
invoiceSequenceByYear:
  '2026': 9
`);

expect(config.invoiceSequenceByYear).toEqual({ '2026': 9 });
expect(parseConfigYaml(serializeConfigYaml(config))).toEqual(config);
expect(() => parseConfigYaml(`${serializeConfigYaml(config)}\nreservation: null\n`)).toThrow(
  /reservation/
);
expect(parseLegacyLocalConfigYaml(legacyYaml)).toEqual({
  config: { ...expectedBehaviorConfig, invoiceSequenceByYear: {} },
  lastInvoice: '8/2026',
});
```

Cover invalid years, negative/fractional/unsafe values, omitted sequence map defaulting to `{}`, sorted studio tiers, legacy Calendar URL conversion, and rejection of all former control fields in remote YAML.

- [ ] **Step 2: Run the schema tests and verify they fail on missing codec/field behavior**

Run: `bunx vitest run tests/config/loader.test.ts tests/config/serialization.test.ts tests/invoice/sourceFingerprint.test.ts tests/invoice/rows.test.ts`

Expected: FAIL because the unified codec and `invoiceSequenceByYear` do not exist and legacy fields still survive validation.

- [ ] **Step 3: Implement the exact schema split**

Use one strict behavior schema and a migration-only wrapper:

```ts
const InvoiceSequenceByYearSchema = z.record(
  z.string().regex(/^[1-9]\d{3}$/),
  z.number().int().nonnegative().safe()
);

const ConfigSchema = z
  .object({
    teacher: TeacherInfoSchema,
    calendarId: z.string().optional(),
    calendarName: z.string().optional(),
    calendarAccessRole: z.enum(['owner', 'writer', 'reader', 'freeBusyReader']).optional(),
    calendarUrl: z.string().optional(),
    studios: StudioMapSchema,
    invoiceSequenceByYear: InvoiceSequenceByYearSchema.default({}),
  })
  .strict();

const LegacyLocalConfigSchema = ConfigSchema.omit({ invoiceSequenceByYear: true })
  .extend({ outputDir: z.string().optional(), lastInvoice: LegacyInvoiceNumberSchema.optional() })
  .strip();
```

Serialize only the normalized `AppConfig`; remove `withoutLegacyInvoiceStorage`. Update invoice source hashing to hash `config` directly.

- [ ] **Step 4: Run focused tests and both TypeScript projects**

Run: `bunx vitest run tests/config/loader.test.ts tests/config/serialization.test.ts tests/invoice/sourceFingerprint.test.ts tests/invoice/rows.test.ts && bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit`

Expected: all selected tests PASS and both type checks exit 0.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add src/lib/types.ts src/lib/config src/lib/invoice/rows.ts config.example.yaml tests/fixtures/e2e-config.yaml tests/config tests/invoice/sourceFingerprint.test.ts tests/invoice/rows.test.ts
git commit -m "refactor: define unified cloud configuration schema"
```

### Task 2: Unified Drive Configuration Repository

**Files:**

- Create: `src/lib/drive/configFile.ts`
- Create: `tests/drive/configFile.test.ts`
- Delete: `src/lib/drive/controlFile.ts`
- Delete: `tests/drive/controlFile.test.ts`
- Modify: `src/lib/drive/folders.ts`
- Modify: `tests/drive/folders.test.ts`
- Modify: `tests/drive/memoryDriveApi.ts`

**Interfaces:**

```ts
export interface DriveConfigSnapshot {
  file: DriveFileRecord;
  config: AppConfig;
}

export interface LegacyControlSnapshot {
  file: DriveFileRecord;
  sequenceByYear: Record<string, number>;
}

export type DriveConfigDiscovery =
  | { kind: 'unconfigured' }
  | { kind: 'configured'; snapshot: DriveConfigSnapshot }
  | { kind: 'legacy'; snapshot: LegacyControlSnapshot }
  | { kind: 'conflict'; fileIds: string[] };

export class DriveConfigRepository {
  discover(): Promise<DriveConfigDiscovery>;
  create(parentId: string, config: AppConfig): Promise<DriveConfigSnapshot>;
  replace(snapshot: DriveConfigSnapshot, config: AppConfig): Promise<DriveConfigSnapshot>;
  move(snapshot: DriveConfigSnapshot, parentId: string): Promise<DriveConfigSnapshot>;
  migrate(snapshot: LegacyControlSnapshot, config: AppConfig): Promise<DriveConfigSnapshot>;
}

export function nextInvoiceConfig(
  snapshot: DriveConfigSnapshot,
  year: number
): { invoiceNumber: string; config: AppConfig };
```

- [ ] **Step 1: Write failing repository tests**

Prove exact-name/property discovery across My Drive/shared drives, duplicate unified files, unified-plus-legacy conflict, exact YAML media validation, one-parent requirement, ETag presence, create, replace, move with unchanged ID/content, 412 preservation, and in-place legacy migration.

The migration assertion is exact:

```ts
expect(api.updateRequest(LEGACY_ID)).toMatchObject({
  fileId: LEGACY_ID,
  name: 'lotus-invoices-config.yaml',
  mimeType: 'application/yaml',
  parents: [ROOT_ID],
  properties: { lotusConfigSchema: '1' },
  ifMatch: legacy.file.etag,
});
expect(result.file.id).toBe(LEGACY_ID);
expect(result.config.invoiceSequenceByYear).toEqual({ '2026': 8 });
```

- [ ] **Step 2: Run the repository tests and verify the missing-module failure**

Run: `bunx vitest run tests/drive/configFile.test.ts tests/drive/folders.test.ts`

Expected: FAIL because `configFile.ts` does not exist and `folders.ts` imports the obsolete control type.

- [ ] **Step 3: Implement exact discovery and verified media loading**

Use these constants and two queries:

```ts
export const DRIVE_CONFIG_NAME = 'lotus-invoices-config.yaml';
export const DRIVE_CONFIG_MIME_TYPE = 'application/yaml';
export const DRIVE_CONFIG_PROPERTY = { lotusConfigSchema: '1' } as const;
const LEGACY_CONTROL_NAME = '.lotus-teaching-invoices.json';
```

Require editable/downloadable, non-trashed candidates. After `getFile` plus `downloadFile`, require coherent IDs, ETags, parents, MIME, properties, capabilities, and metadata before parsing bytes. Treat any combination with more than one authority candidate as `conflict`.

- [ ] **Step 4: Implement conditional create/replace/move/migrate**

All writes call `updateFile`/`createFile` once, then `getFile` plus `downloadFile` to verify exact ID, parent, marker, YAML, and content. `move` resends the current serialized bytes and changes only `parents`; `migrate` uses the legacy ETag and file ID and changes name, MIME, bytes, and no parent.

Move the non-durable `DriveRootPointer` shape into `folders.ts` as `DriveRoot`, keeping `StagedDriveRoot` as an operational value only.

- [ ] **Step 5: Run focused repository/folder tests and frontend TypeScript**

Run: `bunx vitest run tests/drive/configFile.test.ts tests/drive/folders.test.ts && bunx tsc --project tsconfig.app.json --noEmit`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the repository replacement**

```bash
git add src/lib/drive/configFile.ts src/lib/drive/controlFile.ts src/lib/drive/folders.ts tests/drive/configFile.test.ts tests/drive/controlFile.test.ts tests/drive/folders.test.ts tests/drive/memoryDriveApi.ts
git commit -m "refactor: replace Drive control JSON with cloud YAML"
```

### Task 3: Safe Local Migration Inputs and Desktop Token Rename

**Files:**

- Modify: `src-tauri/src/app_storage.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/gmail/constants.ts`
- Modify: `tests/gmail/auth.test.ts`
- Modify: `tests/gmail/auth-record.test.ts`
- Modify: `tests/hooks/useGoogleAuthorization.test.tsx`
- Modify: `tests/build/oauth-source-scan.test.ts`

**Interfaces:**

- Desktop auth storage becomes `google-tokens.json` guarded by `.google-tokens.lock`.
- `AppStorage::new` performs a byte-preserving old-to-new rename under the new lock before reads/writes.
- `read_legacy_config() -> Result<Option<String>, String>` reads the exact configured local file.
- `remove_verified_legacy_config(expected_raw: String) -> Result<StorageWriteOutcome, String>` removes it only if its current bytes still equal the migrated bytes.

- [ ] **Step 1: Add failing Rust tests for token migration and verified config removal**

Cover:

```rust
// old only: renamed byte-for-byte
assert_eq!(storage.read_auth_tokens().unwrap().as_deref(), Some(raw));
assert!(!root.path().join("gmail-tokens.json").exists());
assert_eq!(std::fs::read(root.path().join("google-tokens.json")).unwrap(), raw.as_bytes());

// both: explicit startup error
assert!(AppStorage::new(root.path().to_path_buf()).unwrap_err().to_string().contains("both"));

// changed legacy config: no deletion
assert_eq!(storage.remove_verified_legacy_config(old_raw).unwrap(), StorageWriteOutcome::Conflict);
```

Also prove old/new lock handling, permissions, dead temp cleanup for both historical and current names, no Android token-file dependency, and no token content rewrite.

- [ ] **Step 2: Run the focused Rust tests and confirm failures**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_storage::tests`

Expected: FAIL on old filenames and missing legacy-config commands.

- [ ] **Step 3: Implement startup rename and compare-before-delete**

Use explicit constants:

```rust
const AUTH_TOKENS_FILE: &str = "google-tokens.json";
const LEGACY_AUTH_TOKENS_FILE: &str = "gmail-tokens.json";
const AUTH_LOCK_FILE: &str = ".google-tokens.lock";
const LEGACY_AUTH_LOCK_FILE: &str = ".gmail-tokens.lock";
```

Resolve `ConfigPath` exactly as the existing `get_config_path` command does. The delete command must lock its operation, read current bytes, return `Conflict` if they differ, remove only the exact file, sync the parent directory, and never remove an arbitrary fallback path.

- [ ] **Step 4: Register commands and rename the TypeScript constant**

Register `read_legacy_config` and `remove_verified_legacy_config` in both production and webdriver handlers. Set `TOKEN_FILE = 'google-tokens.json'`; keep command names `read_auth_tokens`/`write_auth_tokens` because they describe content, not a provider-specific filename.

- [ ] **Step 5: Run auth/storage/source tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_storage::tests && bunx vitest run tests/gmail tests/hooks/useGoogleAuthorization.test.tsx tests/build/oauth-source-scan.test.ts && bun run verify:oauth-source`

Expected: all tests and the secret/source scan PASS.

- [ ] **Step 6: Commit local migration plumbing**

```bash
git add src-tauri/src/app_storage.rs src-tauri/src/lib.rs src/lib/gmail/constants.ts tests/gmail tests/hooks/useGoogleAuthorization.test.tsx tests/build/oauth-source-scan.test.ts
git commit -m "refactor: rename local Google token storage"
```

### Task 4: Simplify Invoice Storage Around the Config ETag

**Files:**

- Modify: `src/lib/drive/invoiceStore.ts`
- Modify: `tests/drive/invoiceStore.test.ts`
- Modify: `src/lib/drive/invoiceCatalog.ts`
- Modify: `tests/drive/invoiceCatalog.test.ts`

**Interfaces:**

```ts
export interface DriveStoreSnapshot {
  config: DriveConfigSnapshot;
  stagedRoot: StagedDriveRoot;
  scan: DriveInvoiceScan;
}

bootstrap(sources, legacyLocalYaml?): Promise<DriveStoreSnapshot | null>;
saveConfig(snapshot, nextConfig, sources): Promise<DriveStoreSnapshot>;
activateRoot(staged, sources, initialConfig?): Promise<DriveStoreSnapshot>;
finalize(input): Promise<{ entry: DriveInvoiceEntry; snapshot: DriveStoreSnapshot }>;
refinalize(input, entry): Promise<{ entry: DriveInvoiceEntry; snapshot: DriveStoreSnapshot }>;
```

- [ ] **Step 1: Rewrite invoice-store tests around allocation-before-upload**

Delete reservation/recovery test cases. Add exact mutation-order assertions:

```ts
expect(api.mutations()).toEqual([
  'config:sequence:if-match',
  'pdf:create:generated-1',
  'pdf:get:generated-1',
]);
expect(result.snapshot.config.config.invoiceSequenceByYear['2026']).toBe(9);
```

Cover two stale devices (one 412, reload, then number 10), upload/render/verification failure after allocation leaving 9 stored, process restart requiring no recovery, duplicate studio/month check before increment, and re-finalization preserving number/counter/file ID.

- [ ] **Step 2: Run the store tests and confirm failures against reservation behavior**

Run: `bunx vitest run tests/drive/invoiceStore.test.ts tests/drive/invoiceCatalog.test.ts`

Expected: FAIL because snapshots still expose `control`, finalization reserves first, and recovery APIs remain.

- [ ] **Step 3: Replace control loading with parent-derived configuration loading**

`loadConfigured` must:

1. require exactly one config-file parent;
2. fetch that parent as an editable/listable/addable folder;
3. call the folder service to locate exactly one direct `Final` child by name without creating it during ordinary startup;
4. scan that folder;
5. return `{ config, stagedRoot, scan }`.

Split folder behavior into `resolveRootFromConfigParent(parentId)` for startup and `stageRoot(folder)` for user-confirmed setup/root changes, where only `stageRoot` may create a missing `Final` folder.

- [ ] **Step 4: Implement counter-first finalization**

Use a bounded conflict loop only around number allocation:

```ts
for (let attempt = 0; attempt < 3; attempt += 1) {
  const current = await this.refreshInternal(this.currentSources);
  this.requireNoExistingInvoice(current.scan, input.key);
  const allocated = nextInvoiceConfig(current.config, year);
  try {
    const saved = await this.repository.replace(current.config, allocated.config);
    return this.uploadAllocated(input, current.stagedRoot, saved, allocated.invoiceNumber);
  } catch (error) {
    if (!isEtagConflict(error) || attempt === 2) throw error;
  }
}
```

Do not catch a post-save render/upload failure as recoverable. Report the real mapped error and retain the saved sequence. Remove `InvoiceReservation`, `reserveNextInvoice`, `reserveExistingInvoice`, `commitReservation`, `recoverReservation`, lease cleanup, reconciliation, `recoveryRequired`, `now`, and reservation timestamp logic.

- [ ] **Step 5: Implement config saves, root moves, and in-place legacy migration**

- `bootstrap`: if legacy control is found, require supplied local YAML, parse it through `parseLegacyLocalConfigYaml`, set the sequence map from the JSON `sequenceByYear`, call `repository.migrate`, reload/verify, and only then return the raw local bytes as a deletion receipt.
- `saveConfig`: replace with the caller's snapshot ETag; on 412 reload and throw a non-merging `conflict` containing the fresh snapshot.
- `activateRoot`: create a new config only when unconfigured; otherwise move the same config file ID with its ETag.
- On an ambiguous move response, rediscover; accept only exactly one matching file with the same ID and intended parent.

- [ ] **Step 6: Run store/catalog tests and TypeScript**

Run: `bunx vitest run tests/drive/invoiceStore.test.ts tests/drive/invoiceCatalog.test.ts && bunx tsc --project tsconfig.app.json --noEmit`

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit the simplified store**

```bash
git add src/lib/drive/invoiceStore.ts src/lib/drive/invoiceCatalog.ts tests/drive/invoiceStore.test.ts tests/drive/invoiceCatalog.test.ts
git commit -m "refactor: allocate invoice numbers through cloud config"
```

### Task 5: Make React Configuration an In-Memory Draft of Drive State

**Files:**

- Modify: `src/hooks/useConfig.ts`
- Modify: `tests/hooks/useConfig.test.tsx`
- Modify: `src/hooks/useDriveInvoices.ts`
- Modify: `tests/hooks/useDriveInvoices.test.tsx`
- Modify: `src/hooks/useDriveSetupSnapshot.ts`
- Modify: `tests/hooks/useDriveSetupSnapshot.test.tsx`
- Modify: `src/App.tsx`
- Modify: `tests/components/App-drive-setup.test.tsx`
- Modify: `tests/components/App-setup.test.tsx`
- Modify: `tests/components/App-mobile-calendar.test.tsx`

**Interfaces:**

```ts
useConfig({
  remote: DriveConfigSnapshot | null,
  unconfigured: boolean,
  saveRemote(next: AppConfig): Promise<DriveConfigSnapshot>,
}): {
  config: AppConfig | null;
  isDirty: boolean;
  isLoading: boolean;
  loadError: string | null;
  saveError: string | null;
  updateConfig(next: AppConfig): void;
  save(): Promise<void>;
  saveUpdateOrThrow(update: (current: AppConfig) => AppConfig | null): Promise<void>;
}
```

`UseDriveInvoicesState` adds `saveConfig(next)` and removes `recoverReservation`. Its snapshot is the sole remote configuration snapshot.

- [ ] **Step 1: Replace filesystem-hook tests with remote-draft tests**

Prove clean remote adoption, dirty draft retention, serialized saves through the exact base ETag, queued saves, remote 412 behavior (reload snapshot, clear the rejected draft, show “changed elsewhere”, require user repeat), authorization A-to-B-to-A stale completion rejection, and no calls to Tauri filesystem APIs.

- [ ] **Step 2: Run hook/App tests and verify old local-loading expectations fail**

Run: `bunx vitest run tests/hooks/useConfig.test.tsx tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx tests/components/App-drive-setup.test.tsx tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx`

Expected: FAIL because `useConfig` still loads/writes `config.yaml`, snapshots still expose `control`, and recovery remains public.

- [ ] **Step 3: Rebuild `useConfig` as a remote-backed draft controller**

Never parse, read, or write a local file in this hook. A clean new remote snapshot replaces the draft. A dirty draft retains its base ETag until saved or rejected. Serialize writes through `useDriveInvoices.saveConfig`; do not merge fields after conflicts.

- [ ] **Step 4: Update the Drive hook state machine**

Remove reservation-derived errors and `recoverReservation`. Add `saveConfig` to the same mutation queue as finalization/root activation. Every awaited result must verify store, authorization incarnation, and source signature before publication. When store methods return a new snapshot, publish it atomically.

- [ ] **Step 5: Reorder App startup around authorization and cloud discovery**

Create authorization, Drive API, store, and Drive discovery before config-dependent Calendar/source hooks. Until a cloud config exists, pass no behavior-defining config into Calendar, invoice, income, or normal Rates content. For confirmed unconfigured setup, use `DEFAULT_CONFIG` only as an in-memory draft that becomes durable solely when the user confirms a Drive root.

After a successful legacy migration snapshot is published, call `remove_verified_legacy_config` with the exact migration receipt. A failure to remove shows a cleanup warning but must not revert cloud authority.

- [ ] **Step 6: Run hook/App tests and frontend TypeScript**

Run: `bunx vitest run tests/hooks/useConfig.test.tsx tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx tests/components/App-drive-setup.test.tsx tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: selected tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit cloud-backed React state**

```bash
git add src/hooks/useConfig.ts src/hooks/useDriveInvoices.ts src/hooks/useDriveSetupSnapshot.ts src/App.tsx tests/hooks/useConfig.test.tsx tests/hooks/useDriveInvoices.test.tsx tests/hooks/useDriveSetupSnapshot.test.tsx tests/components/App-drive-setup.test.tsx tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx
git commit -m "refactor: load application configuration from Drive"
```

### Task 6: Simplify Root Selection and Remove Recovery UI

**Files:**

- Modify: `src/hooks/useDriveFolderController.ts`
- Modify: `tests/hooks/useDriveFolderController.test.tsx`
- Modify: `src/components/setup/ConnectionsSection.tsx`
- Modify: `tests/components/ConnectionsSection.test.tsx`
- Modify: `src/components/setup/SetupWizard.tsx`
- Modify: `tests/components/SetupWizard.test.tsx`
- Modify: `src/components/InvoicesTab/index.tsx`
- Modify: `src/components/InvoicesTab/MobileInvoices.tsx`
- Modify: `tests/components/InvoicesTab.test.tsx`
- Modify: `tests/components/MobileInvoices.test.tsx`
- Modify: `src/components/RatesTab/index.tsx`
- Modify: `src/components/RatesTab/MobileSettings.tsx`
- Modify: `tests/components/RatesTab.test.ts`
- Modify: `tests/components/MobileSettings.test.tsx`

**Interfaces:**

- Root activation receives the current cloud config/draft, not `legacyLastInvoice` and not a local cleanup callback.
- Invoice views have no `recoveryRequired` or `onRecoverReservation` props.

- [ ] **Step 1: Write failing controller and UI simplification tests**

Assert that selecting a replacement root calls `activateRoot(staged)` once, keeps the same config file ID, and never calls `saveConfig` to strip local fields. Assert no “Recover invoice reservation” action or reservation copy renders on desktop/mobile.

- [ ] **Step 2: Run focused component/controller tests and confirm failures**

Run: `bunx vitest run tests/hooks/useDriveFolderController.test.tsx tests/components/ConnectionsSection.test.tsx tests/components/SetupWizard.test.tsx tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx tests/components/RatesTab.test.ts tests/components/MobileSettings.test.tsx`

Expected: FAIL on obsolete activation arguments, cleanup retries, and recovery UI.

- [ ] **Step 3: Remove local cleanup and reservation presentation paths**

Delete `withoutLegacyInvoiceStorage`, cleanup retry state, `legacyLastInvoice`, `recoveryRequired`, and recovery handlers. Keep existing confirmation, candidate scan, dialog session isolation, and busy/error states. For initial setup, pass the validated in-memory default draft to `activateRoot`; for replacement, move the loaded snapshot.

- [ ] **Step 4: Run focused UI tests and frontend TypeScript**

Run: `bunx vitest run tests/hooks/useDriveFolderController.test.tsx tests/components/ConnectionsSection.test.tsx tests/components/SetupWizard.test.tsx tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx tests/components/RatesTab.test.ts tests/components/MobileSettings.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit simplified setup/UI behavior**

```bash
git add src/hooks/useDriveFolderController.ts src/components/setup src/components/InvoicesTab src/components/RatesTab tests/hooks/useDriveFolderController.test.tsx tests/components
git commit -m "refactor: simplify cloud configuration setup"
```

### Task 7: End-to-End Migration and Cross-Device Authority

**Files:**

- Modify: `tests/fixtures/e2e-google-drive.json`
- Modify: `tests/e2e/fake-google-calendar.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/drive-invoices.e2e.ts`
- Modify: `tests/e2e/smoke.e2e.ts`
- Modify: `tests/e2e/lifecycle-selftest.ts`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `package.json`

**Interfaces:**

- The fake Drive accepts and reports filename, MIME, parent, bytes, properties, and v2 ETag changes for the same file ID.
- E2E seeding can choose `legacy`, `unified`, `duplicate`, or `unconfigured` cloud configuration state and can inspect the persisted YAML bytes.

- [ ] **Step 1: Add failing E2E/fake-server contract coverage**

Cover:

- legacy JSON plus local YAML migrates the same file ID and deletes local YAML only after verification;
- stale migration ETag leaves both sources untouched;
- fresh desktop and Android-style boot read the same unified configuration;
- a Rates save on one client makes a stale second-client save fail and reload;
- two stale finalizers obtain distinct numbers through ETag retry;
- an upload failure after sequence save leaves a gap and next restart allocates the following number;
- root replacement moves the config file ID and derives the new `Final` child;
- duplicate unified files and invalid YAML block startup.

- [ ] **Step 2: Run fake-server/self-tests and confirm legacy assumptions fail**

Run: `bun run e2e:fake-server && bun run e2e:lifecycle-selftest && bunx vitest run tests/e2e/wdio-config.test.ts`

Expected: FAIL until fixtures and fake-server assertions use the unified filename/content.

- [ ] **Step 3: Update fixtures and fake Drive observability**

Seed YAML bytes as UTF-8 arrays, retain `lotusConfigSchema=1`, and expose exact file ID/parent/ETag/content through the existing E2E control endpoint. Keep generic Drive multipart semantics unchanged.

- [ ] **Step 4: Update isolated desktop E2E flows**

Remove assumptions that app config is durably read from `LOTUS_E2E_CONFIG_PATH` after migration. Use that path only as a legacy migration input. Add a clean data directory with the same Drive fixture to prove fresh-device bootstrap without `config.yaml`.

- [ ] **Step 5: Add the new config tests to the Drive gate**

Ensure `verify:drive-invoices` includes `tests/drive/configFile.test.ts`, the rewritten config/hook tests, focused `app_storage` Rust tests, and existing OAuth leakage checks.

- [ ] **Step 6: Run pre-E2E integrated gates**

Run: `bun run verify:drive-invoices && bun test && bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit`

Expected: all tests and type checks PASS.

- [ ] **Step 7: Run full isolated E2E**

Run: `bun run e2e`

Expected: all desktop E2E tests PASS, including migration, fresh boot, root move, configuration save, invoice gap, re-finalization, Gmail draft, PDF, and income regression coverage.

- [ ] **Step 8: Commit E2E coverage**

```bash
git add tests/fixtures/e2e-google-drive.json tests/e2e src-tauri/src/e2e_support.rs package.json
git commit -m "test: verify unified Drive configuration lifecycle"
```

### Task 8: Repeatable Migration and Rollback Documentation

**Files:**

- Create: `docs/release/cloud-config-migration.md`
- Modify: `README.md`
- Modify: `docs/release/google-drive-invoice-storage-checklist.md`

**Interfaces:**

- Documentation provides literal before/after field mapping and repeat instructions for each additional local config/control-file pair.
- No instruction deletes a local file before same-ID remote verification.

- [ ] **Step 1: Write the migration runbook with exact checkpoints**

Include:

1. close every desktop/Android client and upgrade all clients;
2. copy the local `config.yaml` and download `.lotus-teaching-invoices.json` while recording Drive file ID, parent ID, ETag, MIME, and `lotusConfigSchema`;
3. map JSON `sequenceByYear` to YAML `invoiceSequenceByYear` and discard JSON `schemaVersion`, `generation`, `root`, `finalFolderId`, and `reservation`;
4. start the upgraded desktop against that exact local YAML/account pair;
5. verify same Drive file ID, filename, MIME, parent, marker, teacher, Calendar, every studio/rate/email/color, existing invoices, and next number;
6. confirm local `config.yaml` is gone only after verification;
7. close the app, switch to the next local YAML/account pair, and repeat from step 2;
8. state the rollback procedure and the first config save/number allocation as the point after which rollback is unsafe.

- [ ] **Step 2: Update README and old Drive checklist**

State plainly that only `google-tokens.json` and disposable operational data remain local, while desktop and Android load the same Drive YAML. Remove `.lotus-teaching-invoices.json`, reservation recovery, and local application `config.yaml` from current-operation instructions. Retain explicit-local-config CLI documentation.

- [ ] **Step 3: Validate documentation names and obsolete-state removal**

Run:

```bash
rg -n "lotus-invoices-config.yaml|invoiceSequenceByYear|google-tokens.json" README.md docs/release/cloud-config-migration.md docs/release/google-drive-invoice-storage-checklist.md
rg -n "reservation|generation|finalFolderId|sequenceByYear|gmail-tokens.json|\.lotus-teaching-invoices\.json" README.md docs/release/google-drive-invoice-storage-checklist.md
```

Expected: first command finds the new authority names. Second command has no current-operation matches; legacy names occur only inside the migration/rollback runbook where explicitly labeled.

- [ ] **Step 4: Run final repository gates**

Run: `bun run verify:oauth-source && bun test && bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit && cargo test --manifest-path src-tauri/Cargo.toml && bun run e2e`

Expected: every command exits 0.

- [ ] **Step 5: Inspect the final diff for exact scope**

Run: `git status --short && git diff --check && git diff --stat master...HEAD`

Expected: only files listed in this plan are changed, no generated Android build output is staged, and `git diff --check` is silent.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/release/cloud-config-migration.md docs/release/google-drive-invoice-storage-checklist.md
git commit -m "docs: add cloud configuration migration runbook"
```

## Plan Self-Review

- [ ] Every design-spec section has an implementation task: remote file/schema (Tasks 1–2), ETag authority/root (Tasks 2, 4–6), allocation (Task 4), startup/migration (Tasks 3–5, 7), token rename (Task 3), rollback/docs (Task 8), and integrated coverage (Task 7–8).
- [ ] Run a placeholder/filler-language scan; it must return no matches.
- [ ] Confirm the shared type chain is consistent: `DriveConfigSnapshot` → `DriveStoreSnapshot.config` → `useDriveInvoices.snapshot` → `useConfig.remote` → `AppConfig` consumers.
- [ ] Confirm there is no durable local config fallback, no config merge, no reservation/recovery state, and no second remote configuration file.
- [ ] Confirm migration and root moves preserve the same Drive file ID and use `If-Match`.
