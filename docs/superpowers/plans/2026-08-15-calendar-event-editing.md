# Calendar Event Editing Implementation Plan

> **Execution update:** Tasks 1-8 are complete. The remaining horizontal Tasks 9-16 are superseded by [the vertical-slice plan](2026-08-15-calendar-event-editing-vertical-slices.md), approved after the original ordering delayed the user-visible calendar portal.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a clicked Calendar lesson into a safe portal for reassigning its studio, setting students, and setting or clearing its euro override, with Google-first writes and finalized-invoice freshness tracking.

**Architecture:** Preserve the existing Google -> Rust sync -> SQLite -> parser pipeline. Add explicit event identity, a typed Rust preflight/apply boundary with `If-Match`, staged full-sync recovery, versioned write authorization, and a separate invoice-freshness store. React owns only intent construction, confirmation, accessible presentation, and reloading authoritative cached data after Rust finishes.

**Tech Stack:** TypeScript, React 19, Tailwind CSS 4, Tauri 2, Rust, reqwest, rusqlite/SQLite, Vitest, Testing Library/JSDOM, WebdriverIO, local fake Google Calendar HTTP server

---

## File map

### Create

- `src/lib/calendar/edit-format.ts` — strict legacy-description recognition, canonical serialization, input validation, and studio-prefix rewriting.
- `src/lib/calendar/calendar-update.ts` — typed Tauri preflight/apply/reconcile client and one-time `401` token refresh.
- `src/lib/gmail/auth-record.ts` — pure legacy/versioned token parsing, grant acceptance, refresh merging, and prompt decisions.
- `src/hooks/useGoogleAuthorization.ts` — startup write-permission state and upgrade flow.
- `src/hooks/useCalendarEditing.ts` — fresh access-role state plus preflight/apply/reconcile orchestration.
- `src/hooks/useInvoiceFreshness.ts` — active stale-invoice loader and refresh API.
- `src/lib/invoice/freshness.ts` — typed invoice-freshness Tauri wrappers.
- `src/lib/invoice/rows.ts` — pure union of current class rows and active stale records.
- `src/components/CalendarPermissionPrompt.tsx` — one-time in-app write-permission explanation.
- `src/components/CalendarTab/anchoredPosition.ts` — pure viewport-aware card placement.
- `src/components/CalendarTab/useAnchoredPosition.ts` — resize/scroll/month-layout repositioning.
- `src/components/CalendarTab/ModalDialog.tsx` — accessible focus-trapped modal primitive.
- `src/components/CalendarTab/EventDetailsCard.tsx` — anchored read/edit card and per-row save feedback.
- `src/components/CalendarTab/StudioMenu.tsx` — configured-studio menu with roving keyboard focus.
- `src/components/CalendarTab/RecurrenceScopeDialog.tsx` — `This event` / `Entire series` selection.
- `src/components/CalendarTab/StudentCountDialog.tsx` — positive-integer lesson-only editor.
- `src/components/CalendarTab/EuroOverrideDialog.tsx` — non-negative euro editor and configured-rate action.
- `src/components/CalendarTab/CalendarEditConfirmationDialog.tsx` — combined replacement, series, and finalized-invoice confirmation.
- `src-tauri/src/app_storage.rs` — managed application-data paths and versioned auth-record persistence.
- `src-tauri/src/calendar_api.rs` — shared typed Google Calendar transport and error mapping.
- `src-tauri/src/calendar_edit.rs` — edit preflight, apply, reconciliation, and pending-local recovery.
- `src-tauri/src/invoice_files.rs` — strict finalized-PDF lookup and guarded email/re-finalization preparation.
- `src-tauri/src/invoice_freshness.rs` — persisted stale-invoice store.
- `src-tauri/src/e2e_support.rs` — webdriver-only state seeding and test path/base overrides.
- `src/e2eBridge.ts` — webdriver-only browser bridge to the Tauri E2E seed commands.
- `tests/helpers/react-test-env.ts` — explicit JSDOM/global React setup used by Bun component tests.
- `tests/calendar/edit-format.test.ts`
- `tests/calendar/calendar-update.test.ts`
- `tests/hooks/useCalendarData.test.tsx`
- `tests/hooks/useCalendarEditing.test.tsx`
- `tests/gmail/auth-record.test.ts`
- `tests/components/CalendarPermissionPrompt.test.tsx`
- `tests/components/CalendarEventEditing.test.tsx`
- `tests/components/InvoicesTab.test.tsx`
- `tests/components/anchoredPosition.test.ts`
- `tests/invoice/rows.test.ts`
- `tests/pdf/generatePdf.test.ts`
- `tests/e2e/fake-google-calendar.ts`
- `tests/e2e/calendar-editing.e2e.ts`
- `tests/fixtures/e2e-google-calendar.json`

### Modify

- `package.json`, `bun.lock` — add component-test dependencies and `lucide-react`; build the webdriver frontend with its test bridge.
- `src/lib/types.ts` — calendar access role, explicit event identity, and raw source values on parsed classes.
- `src/lib/calendar/parser.ts` — use the centralized description parser and retain raw identity/source data.
- `src/lib/calendar/cache.ts` — map the nested Rust identity DTO.
- `src/lib/calendar/calendar-api.ts` — preserve `accessRole` and route active CalendarList reads through Rust.
- `src/lib/gmail/constants.ts`, `src/lib/gmail/auth.ts` — add `calendar.events` upgrade flow without sacrificing old grants.
- `src/lib/config/schema.ts`, `src/components/RatesTab/index.tsx` — persist the selected calendar's last observed access role.
- `src/hooks/useCalendarData.ts` — load cache before sync and expose authoritative reload.
- `src/App.tsx` — compose authorization, editing, calendar refresh, freshness, and prompt state.
- `src/components/CalendarTab/index.tsx`, `CalendarGrid.tsx`, `EventChip.tsx` — stable selection, native button chips, and portal card.
- `src/components/InvoicesTab/index.tsx` — stale rows, guarded email, and same-number re-finalization.
- `src/lib/invoice/finalization.ts` — keep filename rules shared with strict lookup tests.
- `src/lib/pdf/generatePdf.ts` — separate final PDF writing from opening.
- `src-tauri/src/calendar_store.rs` — identity migration and staged full-sync primitives.
- `src-tauri/src/calendar_sync.rs` — shared client, identity mapping, atomic full replacement, and safe `410` recovery.
- `src-tauri/src/oauth.rs` — distinguish success, denial, malformed callback, and timeout.
- `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — register services/commands and test-only dependencies.
- `src/vite-env.d.ts`, `wdio.conf.ts`, `tests/e2e/helpers.ts`, `tests/fixtures/e2e-config.yaml` — isolated deterministic Tauri E2E runtime.
- Existing calendar, parser, Gmail, config, invoice, PDF, Calendar, and Rates tests — update contracts and add regressions.

## Non-negotiable contracts

Use one identity authority and remove `CalendarEvent.uid`:

```ts
export type CalendarAccessRole = 'owner' | 'writer' | 'reader' | 'freeBusyReader';

export interface CalendarEventIdentity {
  calendarId: string;
  eventId: string;
  recurringEventId?: string;
  originalStartTime?: string;
  etag?: string;
}

export interface CalendarEvent {
  identity: CalendarEventIdentity;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  status?: string;
  updated?: string;
}

export interface ParsedClass {
  eventIdentity: CalendarEventIdentity;
  sourceSummary: string;
  sourceDescription: string;
  // existing parsed invoice fields remain unchanged
}
```

Every Google-derived `ParsedClass` has those fields. Tests that intentionally build invoice-only classes should use a fixture builder with inert identity; production code must never reconstruct identity from date, time, title, index, or a React key.

The edit boundary is two-phase:

```ts
type CalendarEditScope = 'occurrence' | 'series';

type CalendarEditChange =
  | { kind: 'studio'; studioName: string }
  | { kind: 'description'; description: string };

interface CalendarEditPreflightRequest {
  identity: CalendarEventIdentity;
  scope: CalendarEditScope;
  change: CalendarEditChange;
  outputDir: string;
}
```

Preflight returns the exact target ID/ETag, current/proposed field values, cached source fingerprint, affected instance snapshots, title-exception count, all strict finalized-file snapshots, finalized invoice impact, access role, and required confirmations. Apply carries that exact preflight. It never substitutes a new ETag or silently expands the confirmed impact.

Only these remote patches are legal:

```rust
enum CalendarEventPatch {
    Summary(String),
    Description(String),
}
```

Student/euro changes always use occurrence scope. Series scope is accepted only for studio reassignment. Every PATCH sends one property and the confirmed ETag as `If-Match`.

The active invoice-freshness key is:

```ts
interface InvoiceFreshnessKey {
  calendarId: string;
  outputDir: string; // canonical path returned by Rust
  studioName: string;
  monthKey: string; // YYYY-MM
}
```

## Task 1: Centralize safe legacy formats and edit proposals

**Files:**

- Create: `src/lib/calendar/edit-format.ts`
- Create: `tests/calendar/edit-format.test.ts`
- Modify: `src/lib/calendar/parser.ts:16-38,73-121`
- Modify: `tests/calendar/parser.test.ts`

- [ ] **Step 1: Write failing strict-recognition and display-compatibility tests**

Cover exact `N` and `N/PEUR`, outer/slash whitespace, case-insensitive `EUR`, zero as a parseable but non-positive count, prose with one number, multiple-number ambiguity, and an existing complete override with more than two decimals. Assert that the broad parser can still display compatible old data and that every complete legacy `N/PEUR` value—including more than two decimals—is safe to replace without an unsupported-description warning.

- [ ] **Step 2: Write failing proposal and validation tests**

Test this public contract:

```ts
parseStudentDescription(raw): {
  studentCount: number | null;
  rateOverride?: number;
  ambiguous: boolean;
  safeToReplace: boolean;
};

rewriteStudioSummary(summary, studioName):
  | { ok: true; value: string; changed: boolean }
  | { ok: false; reason: 'unsupportedStructure' };

proposeStudentCount(current, students): DescriptionProposal;
proposeEuroOverride(current, students, euros): DescriptionProposal;
proposeConfiguredRate(current, students): DescriptionProposal;
```

Prove `9/30EUR -> 12/30EUR`, clearing the override produces `9`, unsupported prose includes the complete old/proposed values and requires confirmation, and current supported values do not.

- [ ] **Step 3: Test exact input and summary rules**

Students accept only integer `>= 1`. New values entered in the euro dialog accept `0`, `.`, and at most two decimals; reject blank, comma, exponent, negative, and three-decimal input. Serialization emits `30`, `30.5`, or `30.25` without whitespace/trailing zeroes and with uppercase `EUR`. A student-only change preserves and canonicalizes an already-recognized legacy override at its existing precision—for example `9 / 30.123 eur -> 12/30.123EUR`—without warning. Summary rewriting accepts exactly two or three non-empty slash-separated parts, replaces only the trimmed first segment, and preserves trailing separator whitespace plus every character from the first `/` onward.

- [ ] **Step 4: Run the focused tests and verify RED**

Run: `bunx vitest run tests/calendar/edit-format.test.ts tests/calendar/parser.test.ts`

Expected: helper imports fail and parser safety/proposal assertions fail.

- [ ] **Step 5: Implement the pure helper and route parser logic through it**

Keep backward-compatible display parsing separate from `safeToReplace`. Do not alter calculator behavior. Do not mutate the original summary/description.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `bunx vitest run tests/calendar/edit-format.test.ts tests/calendar/parser.test.ts`

Expected: both files pass.

- [ ] **Step 7: Commit the pure contracts**

```bash
git add src/lib/calendar/edit-format.ts src/lib/calendar/parser.ts tests/calendar/edit-format.test.ts tests/calendar/parser.test.ts
git commit -m "feat: add calendar edit value helpers"
```

## Task 2: Migrate the calendar cache and add atomic staged full sync

**Files:**

- Modify: `src-tauri/src/calendar_store.rs`

- [ ] **Step 1: Write failing in-place migration tests**

Create a legacy database using the current schema and rows. Reopen it through `CalendarStore::open` and assert:

- `recurring_event_id`, `original_start_time`, and `etag` exist without data loss;
- `calendar_sync_state.identity_schema_version` defaults to `0` for old rows;
- identity fields round-trip for new rows; and
- repeated migration is idempotent.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_store::tests::migration_`

Expected: missing-column/field failures.

- [ ] **Step 3: Implement explicit idempotent migration**

Use `PRAGMA user_version` plus `PRAGMA table_info` checks before each `ALTER TABLE`; do not rely on editing `CREATE TABLE IF NOT EXISTS` alone. Extend:

```rust
pub struct StoredCalendarEvent {
    pub calendar_id: String,
    pub event_id: String,
    pub recurring_event_id: Option<String>,
    pub original_start_time: Option<String>,
    pub etag: Option<String>,
    // existing raw/timed fields
}

pub struct CalendarSyncState {
    // existing fields
    pub identity_schema_version: i64,
}
```

- [ ] **Step 4: Write failing staging/atomicity tests**

Cover `begin_staged_full_sync`, `stage_event`, `discard_staged_full_sync`, and one-transaction `commit_staged_full_sync`. Inject a failure before commit and prove old events/sync token remain readable; prove successful commit replaces only the selected calendar and deletes its staging rows.

- [ ] **Step 5: Implement staging tables and methods**

Add durable `calendar_full_sync_stages` and `calendar_events_staging` tables. Add `event(calendar_id,event_id)`, `list_series_instances`, and transaction-scoped commit. A stage must never be visible through `list_events`.

- [ ] **Step 6: Run the complete store tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_store::tests`

Expected: legacy migration, identity, idempotency, discard, failure preservation, and atomic replacement tests pass.

- [ ] **Step 7: Commit the persistence migration**

```bash
git add src-tauri/src/calendar_store.rs
git commit -m "feat: preserve calendar event identity"
```

## Task 3: Extract a typed Google client and make sync failure-safe

**Files:**

- Create: `src-tauri/src/calendar_api.rs`
- Modify: `src-tauri/src/calendar_sync.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: Add deterministic Rust HTTP-test dependencies**

Add `async-trait` to dependencies and `tokio` plus `httpmock` to dev-dependencies. Keep production API base fixed; permit a base override only under `cfg(test)` or `feature = "webdriver"`.

- [ ] **Step 2: Write failing transport tests**

Cover URL encoding/pagination, CalendarList `accessRole`, master GET, summary-only PATCH, description-only PATCH, exact `If-Match`, and error mapping:

```text
401 -> unauthorized
403 rate/quota reason or 429 -> rateLimited (capability retained)
403 permission reason -> permissionDenied
403 forbiddenForNonOrganizer -> its own code
404 -> notFound
409/412 -> conflict
410 incremental list -> syncTokenExpired
transport failure -> network
```

Assert ambiguous network/conflict failures are not retried. Only explicit rate/quota responses receive bounded backoff.

- [ ] **Step 3: Run the transport tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_api::tests`

Expected: module/API trait does not exist.

- [ ] **Step 4: Implement the shared client**

Move reqwest, base URL, response structs, Google error-body parsing, CalendarList, event-page GET, event GET, and field-restricted PATCH into `calendar_api.rs`. Support both `dateTime` and `date` in `originalStartTime`; continue skipping all-day lessons for start/end.

- [ ] **Step 5: Write failing identity-sync and staged-recovery tests**

Test recurrence/ETag mapping, multipage commit only after final `nextSyncToken`, first identity-schema upgrade forcing one full staged sync, successful return to incremental sync, failed upgrade retaining old cache/token, and a `410` retaining live cache until replacement succeeds.

- [ ] **Step 6: Refactor sync onto the client and staging store**

Full staging is mandatory when no sync state exists, identity schema is old, Google returns `410`, or later series reconciliation cannot prove authority. Never call `clear_calendar` before a replacement sync succeeds. Incremental upserts remain idempotent.

- [ ] **Step 7: Run Rust calendar tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calendar_api::tests
cargo test --manifest-path src-tauri/Cargo.toml calendar_sync::tests
```

Expected: request-shape, typed-error, identity, staging, pagination, and `410` tests pass.

- [ ] **Step 8: Commit the shared transport and safe sync**

```bash
git add src-tauri/src/calendar_api.rs src-tauri/src/calendar_sync.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: make calendar sync identity aware"
```

## Task 4: Carry identity through Tauri, parsing, and cache-first startup

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/calendar/cache.ts`
- Modify: `src/lib/calendar/calendar-api.ts`
- Modify: `src/lib/calendar/parser.ts`
- Modify: `src/hooks/useCalendarData.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `tests/helpers/react-test-env.ts`
- Create: `tests/hooks/useCalendarData.test.tsx`
- Modify: `tests/calendar/cache.test.ts`
- Modify: `tests/calendar/calendar-api.test.ts`
- Modify: `tests/calendar/parser.test.ts`
- Modify: invoice/income/component ParsedClass fixtures as needed

- [ ] **Step 1: Add the component/hook test harness**

Run: `bun add --dev @testing-library/react @testing-library/user-event jsdom`

Create explicit JSDOM setup/teardown and assign `globalThis.React`; do not rely only on Vitest's environment directive because Bun has previously ignored it in this repository.

- [ ] **Step 2: Write failing DTO/mapper/parser identity tests**

Change the Rust DTO and TypeScript cache DTO to one nested `identity`. Assert configured and unconfigured classes retain identical `eventIdentity`, `sourceSummary`, and `sourceDescription`; legacy migrated rows with missing ETag remain visible. Update `mapEventsResponse(data, calendarId)` to preserve `recurringEventId`, `originalStartTime`, and `etag` for its retained tests.

- [ ] **Step 3: Remove the dual `uid` authority**

Update all CalendarEvent fixtures and consumers to `identity.eventId`. Update ParsedClass fixture builders once rather than scattering invented IDs through assertions. The write path may use only `eventIdentity`.

- [ ] **Step 4: Write failing cache-first hook tests**

Prove cached lessons render while sync is unresolved, sync failure retains cached lessons, a successful sync reloads cache once, calendar ID changes load only that cache, and studio-key changes still reparse the same events without losing current refresh behavior.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
bunx vitest run tests/calendar/cache.test.ts tests/calendar/calendar-api.test.ts tests/calendar/parser.test.ts
bunx vitest run tests/hooks/useCalendarData.test.tsx
```

Expected: nested identity/source assertions and cache-first timing fail.

- [ ] **Step 6: Implement DTO mapping and cache-first reload**

Expose an idempotent `reloadCache()` from `useCalendarData`. On refresh: load/parse SQLite first, then attempt remote sync, then reload only after successful sync. A remote failure sets the error but preserves the already-rendered cache and parsed classes.

- [ ] **Step 7: Run focused tests, typecheck, and verify GREEN**

Run:

```bash
bunx vitest run tests/calendar/cache.test.ts tests/calendar/calendar-api.test.ts tests/calendar/parser.test.ts tests/hooks/useCalendarData.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all identity/cache tests pass with no type errors.

- [ ] **Step 8: Commit the end-to-end identity bridge**

```bash
git add package.json bun.lock src-tauri/src/lib.rs src/lib/types.ts src/lib/calendar/cache.ts src/lib/calendar/calendar-api.ts src/lib/calendar/parser.ts src/hooks/useCalendarData.ts tests/helpers/react-test-env.ts tests/hooks/useCalendarData.test.tsx tests/calendar/cache.test.ts tests/calendar/calendar-api.test.ts tests/calendar/parser.test.ts tests/invoice/calculator.test.ts tests/invoice/generator.test.ts tests/invoice/grouper.test.ts tests/income/report.test.ts tests/components/CalendarTab.test.tsx tests/components/IncomeTab.test.tsx
git commit -m "feat: expose calendar edit identity to the UI"
```

## Task 5: Version authorization without sacrificing existing access

**Files:**

- Create: `src-tauri/src/app_storage.rs`
- Create: `src/lib/gmail/auth-record.ts`
- Create: `tests/gmail/auth-record.test.ts`
- Modify: `src-tauri/src/oauth.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/gmail/constants.ts`
- Modify: `src/lib/gmail/auth.ts`
- Modify: `tests/gmail/auth.test.ts`

- [ ] **Step 1: Write failing pure authorization-record tests**

Cover legacy record readability/write-disabled state, complete grant acceptance, rejection without replacing the old record when any Gmail/read/write scope is absent, actual space-delimited scope storage, missing new refresh token preserving the old one, refresh preserving scopes/version, and `Not now` suppression only for the current authorization schema version.

- [ ] **Step 2: Define versioned storage contracts**

```ts
interface VersionedStoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  authorization_version: number;
  granted_scopes: string[];
}

interface CalendarEditPromptPreference {
  dismissed_authorization_version: number;
}
```

Legacy records stay usable for existing read/Gmail calls but never imply `calendar.events`.

- [ ] **Step 3: Move auth persistence behind managed Tauri storage**

Production commands read/write the same `gmail-tokens.json` under the real AppData directory. Keep prompt preference separate. `app_storage.rs` owns the root so webdriver tests can later select an isolated root; no frontend test may touch the developer's AppData.

- [ ] **Step 4: Write failing OAuth flow tests**

Assert the upgrade URL retains `gmail.compose` and `calendar.readonly`, adds `calendar.events`, and includes `include_granted_scopes=true`. Assert access denial, close/timeout, malformed callback, partial grant, and token-exchange failure retain the previous record byte-for-byte.

- [ ] **Step 5: Implement the grant/refresh rules**

Split constants into base and edit scopes. Extend:

```ts
getAccessToken(options?: {
  requireCalendarWrite?: boolean;
  forceRefresh?: boolean;
}): Promise<string>;
```

`forceRefresh` refreshes once. Refresh never invents scopes. Reauthorization after refresh failure requests the record's known scopes so it cannot silently downgrade. Accept upgrade exchange only after checking the token response's actual `scope`.

- [ ] **Step 6: Make OAuth callback outcomes explicit**

In Rust, parse and return success code versus `access_denied`; keep timeout and malformed callback distinct. Do not delete existing credentials before any outcome.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
bunx vitest run tests/gmail/auth-record.test.ts tests/gmail/auth.test.ts
cargo test --manifest-path src-tauri/Cargo.toml oauth::tests
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: complete/partial/legacy/refresh/decline cases pass.

- [ ] **Step 8: Commit safe authorization migration**

```bash
git add src-tauri/src/app_storage.rs src-tauri/src/oauth.rs src-tauri/src/lib.rs src/lib/gmail/auth-record.ts src/lib/gmail/constants.ts src/lib/gmail/auth.ts tests/gmail/auth-record.test.ts tests/gmail/auth.test.ts
git commit -m "feat: add calendar write authorization"
```

## Task 6: Build an isolated real-Tauri E2E runtime

**Files:**

- Create: `src-tauri/src/e2e_support.rs`
- Create: `src/e2eBridge.ts`
- Create: `tests/e2e/fake-google-calendar.ts`
- Create: `tests/e2e/calendar-editing.e2e.ts`
- Create: `tests/fixtures/e2e-google-calendar.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/calendar_api.rs`
- Modify: `src/main.tsx`
- Modify: `src/vite-env.d.ts`
- Modify: `wdio.conf.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/fixtures/e2e-config.yaml`
- Modify: `package.json`

- [ ] **Step 1: Write failing webdriver-only isolation tests**

Under `feature = "webdriver"`, assert `--e2e-data-dir` redirects calendar cache, auth record, prompt preference, pending-edit journal, and invoice freshness paths. In a normal build, assert the E2E data-dir/base-URL overrides, failpoints, and seed commands are unavailable.

- [ ] **Step 2: Add the guarded runtime state**

Resolve production AppData normally. Only the webdriver build may honor:

```text
--e2e-data-dir <absolute temp path>
LOTUS_E2E_CALENDAR_API_BASE=http://127.0.0.1:<port>/calendar/v3
LOTUS_E2E_SUPPRESS_OPEN_FILE=1
```

The test path must be a validated child of the unique run temp directory. Never override `HOME`, `CODEX_HOME`, or the user's real AppData.

- [ ] **Step 3: Implement the fake Google server**

Use a Node HTTP server on port `0`. Implement CalendarList, expanded event pages/sync tokens, recurring-master GET, instance/master PATCH, `If-Match` conflicts, title-exception preservation, configurable Google error bodies, request log, reset, and remote-mutation control endpoints. Seed deterministic non-recurring, recurring, and title-exception data from JSON.

- [ ] **Step 4: Add webdriver-only seed commands and browser bridge**

Seed selected calendar/config role, versioned token capability, and cache/sync state. Add one-shot, webdriver-only Rust failpoints for `freshnessAfterRemote` and `cacheReconcileAfterRemote`; triggering one must fail exactly the next matching local phase after Google returns success and then clear itself. Register seed/failpoint commands only with `#[cfg(feature = "webdriver")]`. Expose them to WebdriverIO only when `VITE_LOTUS_E2E=1`; production Vite builds must tree-shake the bridge. Invoice-file/freshness seeding is added only after those modules exist in Tasks 8-9.

- [ ] **Step 5: Isolate the WDIO lifecycle**

In `wdio.conf.ts`, create one unique temp root, start the fake server, copy/patch the disposable config, spawn Vite preview and Tauri with the guarded overrides, and remove only that explicit temp root on completion. Keep `maxInstances: 1`. Keep the existing empty smoke fixture independent of editing scenarios, and create an initial editing-spec bootstrap test that proves seeded cache/auth state is isolated.

- [ ] **Step 6: Make the E2E build explicit**

Update `bun run e2e` so the Vite build receives `VITE_LOTUS_E2E=1` and Rust builds with `webdriver`. Suppress OS file opening only in that build.

- [ ] **Step 7: Run isolation checks and the unchanged smoke suite**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --features webdriver e2e_support
bun run e2e
```

Expected: path/base guards pass and the existing smoke tests still pass without reading live Google credentials or developer cache.

- [ ] **Step 8: Commit the deterministic harness**

```bash
git add package.json src-tauri/src/e2e_support.rs src-tauri/src/lib.rs src-tauri/src/calendar_api.rs src/e2eBridge.ts src/main.tsx src/vite-env.d.ts wdio.conf.ts tests/e2e/fake-google-calendar.ts tests/e2e/calendar-editing.e2e.ts tests/e2e/helpers.ts tests/e2e/smoke.e2e.ts tests/fixtures/e2e-config.yaml tests/fixtures/e2e-google-calendar.json
git commit -m "test: isolate calendar editing e2e"
```

## Task 7: Add fresh calendar capability and the one-time permission prompt

**Files:**

- Create: `src/hooks/useGoogleAuthorization.ts`
- Create: `src/hooks/useCalendarEditing.ts`
- Create: `src/components/CalendarPermissionPrompt.tsx`
- Create: `tests/hooks/useCalendarEditing.test.tsx`
- Create: `tests/components/CalendarPermissionPrompt.test.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/calendar/calendar-api.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `src/components/RatesTab/index.tsx`
- Modify: `tests/calendar/calendar-api.test.ts`
- Modify: config and Rates tests
- Modify: `src/App.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] **Step 1: Write failing access-role mapping and persistence tests**

Retain `owner`, `writer`, `reader`, and `freeBusyReader`. Selecting a calendar saves `calendarId`, `calendarName`, and `calendarAccessRole`. Older configs without the role remain valid but session editing starts read-only until CalendarList refresh succeeds.

- [ ] **Step 2: Route active CalendarList reads through Rust**

Register `list_calendars(accessToken)`. Replace the frontend direct CalendarList fetch so sync, picker, preflight, and fake E2E use one Rust client/error model.

- [ ] **Step 3: Write failing capability-hook tests**

Cover:

```text
complete write grant + fresh owner/writer -> enabled
missing write grant -> scopeMissing
missing/stale role -> read-only until refreshed
fresh reader/freeBusyReader -> calendarReadOnly
rate/quota failure -> retryable, do not erase capability
confirmed lost role/scope -> disable
```

The persisted role is only an early display hint. The hook must mark it stale on every app session and refresh it before enabling edits.

- [ ] **Step 4: Write failing prompt component tests**

Assert the explanation appears immediately for an existing legacy/base-only grant, `Allow calendar editing` starts upgrade, and `Not now`, close, denial, or timeout retain read-only app/cache state and persist only the current-version dismissal. A disabled scope-missing action can reopen this explanation.

- [ ] **Step 5: Implement authorization/capability hooks and prompt**

Do not block config rendering or cache load on the prompt. Use `aria-modal`, initial focus, Escape, focus return, and plain actions. Missing scope uses `Allow calendar editing to make changes`; non-writable/unknown role uses `You only have read access to this calendar` until a fresh writer/owner result exists.

- [ ] **Step 6: Add the real-Tauri decline regression**

Seed cached lessons plus a base-only token, choose `Not now`, and assert lessons remain visible, refresh remains usable, no write command occurs, and the prompt does not reappear after WebView reload for the same authorization version.

- [ ] **Step 7: Run focused tests, typecheck, and mandatory E2E**

Run:

```bash
bunx vitest run tests/calendar/calendar-api.test.ts tests/hooks/useCalendarEditing.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
bun run e2e
```

Expected: capability/prompt tests and all Tauri E2E tests pass.

- [ ] **Step 8: Commit capability and permission UX**

```bash
git add src-tauri/src/lib.rs src/lib/calendar/calendar-api.ts src/lib/types.ts src/lib/config/schema.ts src/hooks/useGoogleAuthorization.ts src/hooks/useCalendarEditing.ts src/components/CalendarPermissionPrompt.tsx src/components/RatesTab/index.tsx src/App.tsx tests/calendar/calendar-api.test.ts tests/hooks/useCalendarEditing.test.tsx tests/components/CalendarPermissionPrompt.test.tsx tests/components/RatesTab.test.ts tests/config/loader.test.ts tests/config/serialization.test.ts tests/e2e/calendar-editing.e2e.ts
git commit -m "feat: gate calendar editing by Google access"
```

## Task 8: Add strict finalized-file lookup and persisted freshness

**Files:**

- Create: `src-tauri/src/invoice_files.rs`
- Create: `src-tauri/src/invoice_freshness.rs`
- Create: `src/lib/invoice/freshness.ts`
- Create: `src/hooks/useInvoiceFreshness.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/invoice/finalization.ts`
- Modify: `tests/invoice/finalization.test.ts`

- [ ] **Step 1: Write failing strict lookup tests**

Test missing output folder/`Final` directory, exactly one regular matching PDF, multiple matches, unreadable enumeration/entry, matching directory ignored, malformed filename, and slug suffix collision. Results must be deterministic and sorted.

- [ ] **Step 2: Define the authoritative lookup result**

```rust
enum FinalizedInvoiceLookup {
    NotFound,
    OneMatch {
        canonical_output_dir: String,
        final_filename: String,
        invoice_number: String,
        pdf_path: String,
        file_revision: FileRevision,
    },
    Ambiguous { filenames: Vec<String> },
    Unreadable { message: String },
}
```

Empty/nonexistent output means `NotFound`; an unreadable existing location is not `NotFound`. Mirror the existing TypeScript slug/filename rules with cross-language fixtures. Ambiguous/unreadable blocks an edit.

- [ ] **Step 3: Run lookup tests and verify RED, then implement GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml invoice_files::tests`

Expected before implementation: module failures. After implementation: all four outcomes and filename edge cases pass.

- [ ] **Step 4: Write failing freshness-store tests**

Use a separate `invoice-freshness.sqlite` and this table:

```sql
CREATE TABLE invoice_freshness (
  calendar_id TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  studio_name TEXT NOT NULL,
  month_key TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  final_filename TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  cleared_at TEXT,
  revision INTEGER NOT NULL,
  last_operation_id TEXT,
  PRIMARY KEY (calendar_id, output_dir, studio_name, month_key)
);
```

Prove calendar/output/studio/month isolation, canonical output path, stale re-upsert for a new operation resets `cleared_at` and increments revision, replaying the same `operation_id` is a no-op, compare-and-set clear rejects an older revision, and clearing a calendar cache cannot touch freshness.

- [ ] **Step 5: Implement store and typed commands**

Add list active, strict preparation for re-finalization, guarded email preparation, mark stale, and compare-and-set clear. `prepare_invoice_email` must atomically confirm no active stale record and exactly one finalized PDF immediately before Gmail drafting.

- [ ] **Step 6: Add TypeScript wrappers and loader hook**

Expose:

```ts
listActiveInvoiceFreshness(calendarId, outputDir);
prepareReFinalization(key, expectedRevision);
clearInvoiceFreshness(key, expectedRevision);
prepareInvoiceEmail(key);
```

The hook preserves previous rows on load error and refreshes after calendar apply/reconciliation or successful re-finalization.

- [ ] **Step 7: Run focused Rust/TS tests and typecheck**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml invoice_files
cargo test --manifest-path src-tauri/Cargo.toml invoice_freshness
bunx vitest run tests/invoice/finalization.test.ts
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: strict lookup and freshness lifecycle pass.

- [ ] **Step 8: Commit freshness persistence**

```bash
git add src-tauri/src/invoice_files.rs src-tauri/src/invoice_freshness.rs src-tauri/src/lib.rs src/lib/invoice/finalization.ts src/lib/invoice/freshness.ts src/hooks/useInvoiceFreshness.ts tests/invoice/finalization.test.ts
git commit -m "feat: track finalized invoice freshness"
```

## Task 9: Make stale invoices visible, guarded, and re-finalizable

**Files:**

- Create: `src/lib/invoice/rows.ts`
- Create: `tests/invoice/rows.test.ts`
- Create: `tests/components/InvoicesTab.test.tsx`
- Create: `tests/pdf/generatePdf.test.ts`
- Modify: `src/lib/pdf/generatePdf.ts`
- Modify: `src/components/InvoicesTab/index.tsx`
- Modify: `src/App.tsx`
- Modify: `src-tauri/src/e2e_support.rs`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] **Step 1: Write failing row-union tests**

`buildInvoiceRows(classes, activeFreshness)` must deduplicate current/stale keys and retain a stale-only row with `classes: []`, `classCount: 0`, and total `€0.00`. Sort with the existing month/studio order.

- [ ] **Step 2: Write failing final-PDF separation tests**

Replace combined final write/open with:

```ts
writeFinalPdf(...): Promise<{ outputPath: string; filename: string }>;
openPdf(path): Promise<{ status: 'opened' } | { status: 'failed'; message: string }>;
```

Prove successful write followed by open failure remains a successful persisted finalization.

- [ ] **Step 3: Write failing InvoicesTab tests**

Cover `Out of date`, `Re-finalize Invoice...`, disabled `Draft Email...` with `Re-finalize the invoice first.`, stale-only zero lesson/total, and preview availability. Invoke the draft handler directly with stale service state to prove the second guard prevents `createGmailDraft` even if UI state is stale.

- [ ] **Step 4: Test cross-year same-number re-finalization**

Seed stale invoice `42/2025` while `lastInvoice` is invalid or `11/2026`. Resolve the stale record and strict file before global counter validation, reuse `42/2025` and recorded filename, never increment the counter, clear the expected freshness revision immediately after PDF write, then attempt open.

- [ ] **Step 5: Run component/unit tests and verify RED**

Run:

```bash
bunx vitest run tests/invoice/rows.test.ts tests/components/InvoicesTab.test.tsx tests/pdf/generatePdf.test.ts
```

Expected: row union, stale actions, and write/open split fail.

- [ ] **Step 6: Implement row union and reordered finalization**

For a new invoice, validate/allocate `lastInvoice`, write the PDF, persist the new counter, then open. For a stale invoice, prepare/confirm recorded PDF first, generate current zero-or-more-class invoice, write exact same number, clear revision, never touch counter, then open. Report `Invoice written but could not be opened` without restoring stale state.

- [ ] **Step 7: Add real-Tauri stale-row coverage and run mandatory checks**

Extend the webdriver seed command with finalized files/freshness now that those modules exist. Seed a stale-only row and a matching final file; assert the row remains actionable, email is disabled, re-finalization overwrites the same filename/number, and an open suppression/failure does not keep it stale.

Run:

```bash
bunx vitest run tests/invoice/rows.test.ts tests/components/InvoicesTab.test.tsx tests/pdf/generatePdf.test.ts
bunx tsc --project tsconfig.app.json --noEmit
bun run e2e
```

Expected: unit/component and real-Tauri flows pass.

- [ ] **Step 8: Commit stale invoice behavior**

```bash
git add src/lib/invoice/rows.ts src/lib/pdf/generatePdf.ts src/components/InvoicesTab/index.tsx src/App.tsx src-tauri/src/e2e_support.rs tests/invoice/rows.test.ts tests/components/InvoicesTab.test.tsx tests/pdf/generatePdf.test.ts tests/e2e/helpers.ts tests/e2e/calendar-editing.e2e.ts
git commit -m "feat: re-finalize out-of-date invoices"
```

## Task 10: Implement authoritative calendar-edit preflight

**Files:**

- Create: `src-tauri/src/calendar_edit.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/calendar_store.rs`
- Modify: `src-tauri/src/calendar_api.rs`
- Modify: `src-tauri/src/invoice_files.rs`

- [ ] **Step 1: Write failing scope/payload policy tests**

Reject missing event/ETag identity, recurring instance without recurring master/original start identity, series description changes, no-op changes, unsupported summary structures, and noncanonical proposed descriptions. Rust independently permits only positive `N` or positive `N` plus a non-negative decimal `P` as canonical `N/PEUR`; the frontend euro-input path separately enforces at most two decimals, while student-only edits may preserve a higher-precision recognized legacy override.

- [ ] **Step 2: Write failing occurrence preflight tests**

Assert occurrence studio edits target the instance ETag and preserve the selected summary suffix; student/euro changes target only the selected occurrence. Derive affected invoice keys as current studio/month for descriptions and old+new studio/month for reassignment, with exact-key deduplication.

- [ ] **Step 3: Write failing series preflight tests**

GET `recurringEventId`, rewrite the master summary, and bind confirmation to the master ETag. Classify a cached instance as affected only when its summary exactly equals the confirmed master; count/exclude title exceptions. Return affected cached count, title-exception count, old/new invoice keys, and complete current/proposed master summaries.

- [ ] **Step 4: Write failing authorization and file-snapshot tests**

Preflight must obtain an authoritative CalendarList role and allow only owner/writer. Rate/quota errors remain retryable and do not downgrade. For every unique affected key, include a strict lookup snapshot—even `NotFound`. Ambiguous/unreadable results block before PATCH.

- [ ] **Step 5: Run preflight tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_edit::tests::preflight_`

Expected: command/policy module failures.

- [ ] **Step 6: Implement typed preflight**

Return a serializable preflight containing target ID/ETag, source cache fingerprint, exact proposed field, affected instance snapshots, strict lookup snapshots, finalized matches/number/filename, cached counts, access role, and `requiresDescriptionReplacementConfirmation`. Do not make any local or remote mutation.

- [ ] **Step 7: Run all preflight/policy tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_edit::tests`

Expected: occurrence, series, exception, role, canonical-description, and strict-file tests pass.

- [ ] **Step 8: Commit preflight**

```bash
git add src-tauri/src/calendar_edit.rs src-tauri/src/lib.rs src-tauri/src/calendar_store.rs src-tauri/src/calendar_api.rs src-tauri/src/invoice_files.rs
git commit -m "feat: preflight calendar event edits"
```

## Task 11: Apply with `If-Match` and reconcile without double PATCH

**Files:**

- Modify: `src-tauri/src/calendar_edit.rs`
- Modify: `src-tauri/src/calendar_sync.rs`
- Modify: `src-tauri/src/calendar_store.rs`
- Modify: `src-tauri/src/invoice_freshness.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing preflight-expiry tests**

Before remote I/O, mutate the cached target, an affected instance, a prior `NotFound` file state, or a matched finalized file revision. Assert apply returns `preflightExpired`, sends zero PATCH requests, and writes no freshness rows.

- [ ] **Step 2: Write failing occurrence-apply tests**

Assert the selected event ID receives one summary-or-description-only PATCH with the exact confirmed ETag. Google response is authoritative. On success, stale finalized impacts are upserted, the returned timed instance is upserted, and the refreshed cache is returned. Remote failure leaves cache/freshness unchanged.

- [ ] **Step 3: Write failing series-apply tests**

Assert apply PATCHes the master with the exact preflight ETag and does not GET/substitute a newer one. After success, run authoritative incremental reconciliation; if expected expanded instances cannot be proven changed, use staged full replacement. Preserve title exceptions. Compare before/after membership and mark any additional affected finalized keys stale.

- [ ] **Step 4: Write failing conflict/error tests**

Cover master/occurrence `412`, `404`, permission `403`, non-organizer `403`, rate/quota `403`, `401`, and network errors. Conflict never overwrites or auto-retries. Only a refreshed role/scope result can disable capability; status code alone cannot.

- [ ] **Step 5: Write failing remote-success/local-failure tests**

Inject freshness and cache-reconciliation failures after Google accepts the PATCH. Persist/reopen the store between phases and prove the same operation resumes after restart. Replay a partially written multi-key freshness phase and assert already-applied keys do not increment revision. Cover `prepared` operations whose remote field/ETag proves the PATCH did not occur, plus proposed or later-changed remote values that cannot be conclusively attributed and therefore remain ambiguous. Return:

```ts
type ApplyCalendarEditResult =
  | { status: 'saved'; events: CachedCalendarEventDto[]; staleInvoices: FinalizedInvoiceImpact[] }
  | {
      status: 'remoteSavedReconcilePending';
      pending: ReconciliationContext;
      message: string;
    };
```

`ReconciliationContext` contains a durable `operationId`; the authoritative Google response and all invoice impact live in the persisted operation journal. Calling `reconcile_calendar_edit(operationId)` repeatedly is idempotent and never calls PATCH.

- [ ] **Step 6: Run apply tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml calendar_edit::tests::apply_`

Expected: apply/reconcile behavior is missing.

- [ ] **Step 7: Implement apply and local-only reconciliation**

Add a `calendar_edit_operations` journal with `operation_id`, selected target/change/preflight JSON, authoritative remote-event JSON, phase (`prepared`, `remoteApplied`, `freshnessApplied`, `cacheReconciled`, `complete`), timestamps, and last error. Order work as: revalidate preflight -> insert `prepared` -> PATCH once -> persist `remoteApplied` plus the Google response -> idempotently mark stale using `last_operation_id` -> checkpoint `freshnessApplied` -> reconcile cache -> checkpoint/complete. Once PATCH succeeds, never report a generic save failure and never ask a retry path to PATCH again.

On startup, list unfinished operations. Resume only GET/sync/freshness/cache work; never PATCH. If a crash leaves an operation at `prepared`, refresh Google and compare the authoritative target against the old/proposed field and ETag. Complete a provably unchanged value without claiming a save. Treat an observed proposed value as `remoteOutcomeUnknown` unless the operation can conclusively attribute it to its own PATCH; a matching value alone is insufficient. Conservatively refresh/mark affected finalized keys and require user review before any new edit.

- [ ] **Step 8: Run complete Rust edit tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml calendar_edit::tests
cargo test --manifest-path src-tauri/Cargo.toml calendar_sync::tests
```

Expected: expiry, occurrence, series, conflict, title exception, additional impact, durable restart recovery, idempotent freshness replay, ambiguous remote outcome, pending, and no-double-PATCH tests pass.

- [ ] **Step 9: Commit safe apply/reconciliation**

```bash
git add src-tauri/src/calendar_edit.rs src-tauri/src/calendar_sync.rs src-tauri/src/calendar_store.rs src-tauri/src/invoice_freshness.rs src-tauri/src/lib.rs
git commit -m "feat: apply and reconcile calendar edits"
```

## Task 12: Add the typed edit client and authoritative hook flow

**Files:**

- Create: `src/lib/calendar/calendar-update.ts`
- Create: `tests/calendar/calendar-update.test.ts`
- Modify: `src/hooks/useCalendarEditing.ts`
- Modify: `src/hooks/useCalendarData.ts`
- Modify: `tests/hooks/useCalendarEditing.test.tsx`
- Modify: `tests/hooks/useCalendarData.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing client serialization/error tests**

Assert preflight/apply payloads carry nested identity, selected scope/change, output directory, and the exact complete preflight. Map Rust codes to one typed `CalendarEditError` union. On `401`, force-refresh the token exactly once and retry that command once; never auto-retry conflict, network, permission, or preflight expiry.

- [ ] **Step 2: Write failing no-optimism hook tests**

Classes remain unchanged while preflight/apply is pending or fails. A saved result reloads SQLite once and refreshes invoice freshness. A conflict runs sync/reload for latest values but does not resubmit apply. Old classes remain if refresh fails.

- [ ] **Step 3: Write failing pending-reconciliation tests**

`remoteSavedReconcilePending` exposes `Saved to Google; refreshing...`, calls only `reconcile_calendar_edit(operationId)`, and then reloads cache/freshness. On hook startup, list and resume unfinished operations before enabling a new edit for the same target. If reconciliation remains unavailable, preserve old display and durable pending state; a user retry calls reconcile/refresh, never apply/PATCH.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
bunx vitest run tests/calendar/calendar-update.test.ts tests/hooks/useCalendarEditing.test.tsx tests/hooks/useCalendarData.test.tsx
```

Expected: typed wrappers and orchestration assertions fail.

- [ ] **Step 5: Implement the client and extend the hook**

Expose capability, `preflightEdit`, `applyEdit`, and `reconcileEdit`. Keep requested intent separate from confirmed preflight; Retry always starts a fresh preflight. Compose `reloadCache` and `refreshFreshness` in `App`, not inside presentation components.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
bunx vitest run tests/calendar/calendar-update.test.ts tests/hooks/useCalendarEditing.test.tsx tests/hooks/useCalendarData.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: typed command, one-time refresh, no optimism, conflict, saved, and pending paths pass.

- [ ] **Step 7: Commit frontend orchestration**

```bash
git add src/lib/calendar/calendar-update.ts src/hooks/useCalendarEditing.ts src/hooks/useCalendarData.ts src/App.tsx tests/calendar/calendar-update.test.ts tests/hooks/useCalendarEditing.test.tsx tests/hooks/useCalendarData.test.tsx
git commit -m "feat: orchestrate calendar event updates"
```

## Task 13: Build the accessible anchored event card foundation

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/components/CalendarTab/anchoredPosition.ts`
- Create: `src/components/CalendarTab/useAnchoredPosition.ts`
- Create: `src/components/CalendarTab/ModalDialog.tsx`
- Create: `src/components/CalendarTab/EventDetailsCard.tsx`
- Create: `tests/components/anchoredPosition.test.ts`
- Create: `tests/components/CalendarEventEditing.test.tsx`
- Modify: `src/components/CalendarTab/EventChip.tsx`
- Modify: `src/components/CalendarTab/CalendarGrid.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/App.tsx`
- Modify: `tests/components/CalendarTab.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] **Step 1: Add the icon dependency**

Run: `bun add lucide-react`

Use library icons for new actions/statuses; do not draw SVG/CSS/emoji placeholders.

- [ ] **Step 2: Write failing pure anchoring tests**

`computeAnchoredPosition(anchorRect, cardRect, viewport, gap)` prefers the side with space, falls back right/left appropriately, and clamps both axes. Include narrow viewport, bottom edge, oversized card, and zoomed dimensions.

- [ ] **Step 3: Write failing chip/card interaction tests**

Click, Enter, and Space open the card. Convert every chip state—normal, missing students, ambiguous, and unconfigured—to one native `<button type="button">` with visible focus, complete accessible name, `aria-haspopup="dialog"`, and `aria-expanded`.

- [ ] **Step 4: Test stable selection and card details**

`CalendarTab` stores `selectedEventId`, not a ParsedClass snapshot, and re-resolves from refreshed classes. Grid keys use `eventIdentity.eventId`. The card shows title, date/time, recurrence label, studio, students or `Not set`, euro override or `Configured studio rate`, and the three action rows.

- [ ] **Step 5: Test portal/focus/closing behavior**

Card is fixed-position under `document.body`, labelled as a dialog, closes on outside pointer/Escape when no child overlay is open, returns focus to the connected chip, and closes safely if month navigation disconnects the anchor. Recalculate on scroll capture, resize, `ResizeObserver`, and month layout version.

- [ ] **Step 6: Implement minimal card shell and read-only gating**

Only owner/writer + write grant + complete event identity enables action invocation. Missing scope rows use `aria-disabled` while still opening the permission explanation; reader/unknown-role or incomplete-identity rows invoke no update and show the approved explanation.

- [ ] **Step 7: Run component tests, typecheck, and mandatory E2E**

Run:

```bash
bunx vitest run tests/components/anchoredPosition.test.ts tests/components/CalendarTab.test.tsx tests/components/CalendarEventEditing.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
bun run e2e
```

Expected: keyboard, stable ID, positioning, focus, read-only, and real-Tauri open-card tests pass.

- [ ] **Step 8: Commit the card foundation**

```bash
git add package.json bun.lock src/components/CalendarTab/anchoredPosition.ts src/components/CalendarTab/useAnchoredPosition.ts src/components/CalendarTab/ModalDialog.tsx src/components/CalendarTab/EventDetailsCard.tsx src/components/CalendarTab/EventChip.tsx src/components/CalendarTab/CalendarGrid.tsx src/components/CalendarTab/index.tsx src/App.tsx tests/components/anchoredPosition.test.ts tests/components/CalendarTab.test.tsx tests/components/CalendarEventEditing.test.tsx tests/e2e/calendar-editing.e2e.ts
git commit -m "feat: open calendar lesson details"
```

## Task 14: Implement studio, student, euro, and confirmation flows

**Files:**

- Create: `src/components/CalendarTab/StudioMenu.tsx`
- Create: `src/components/CalendarTab/RecurrenceScopeDialog.tsx`
- Create: `src/components/CalendarTab/StudentCountDialog.tsx`
- Create: `src/components/CalendarTab/EuroOverrideDialog.tsx`
- Create: `src/components/CalendarTab/CalendarEditConfirmationDialog.tsx`
- Modify: `src/components/CalendarTab/ModalDialog.tsx`
- Modify: `src/components/CalendarTab/EventDetailsCard.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `tests/components/CalendarEventEditing.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] **Step 1: Write failing studio-menu keyboard tests**

Configured studios only, using each studio's existing configured color; current studio marked/non-activating; `role="menu"`/`menuitemradio`; Arrow Up/Down, Home/End, and Escape use roving focus. Unsupported source summary disables Fix Studio without guessing.

- [ ] **Step 2: Write failing recurrence-scope tests**

Non-recurring selection proceeds as occurrence. Recurring studio selection shows exactly `This event` and `Entire series`; no `This and following`. Entire series renders complete master current/proposed summaries, past/future warning, affected cached lessons, title exceptions unchanged, and finalized rows becoming stale.

- [ ] **Step 3: Write failing student/euro dialog tests**

Student input is integer `>=1`, starts blank for missing/zero/ambiguous, preserves a valid override, and always submits occurrence. Set Euros is unavailable until positive unambiguous students and shows `Set students first.` Euro input accepts `0`, step `0.01`, max two decimals; `Use configured studio rate` writes only `N`.

- [ ] **Step 4: Write failing replacement/finalized warning tests**

Unsupported descriptions show the complete current and proposed descriptions with only `Cancel` and `Replace`; Cancel sends no apply. Supported descriptions skip that warning. Merge description, series, and finalized-invoice conditions into one confirmation sequence so the exact preflight is applied once after all required consent.

- [ ] **Step 5: Write failing save/error-state tests**

Only the active row is disabled with spinner/`Saving...`; card remains open. Cover `Saved to Google`, retryable error with new-preflight Retry, conflict with latest refresh and no overwrite, `Saved to Google; refreshing...` with no PATCH retry, removed event, permission loss, rate limit, and non-organizer error. Save and error feedback must be announced through a polite live region.

- [ ] **Step 6: Test overlay ordering and focus**

Shared modal traps Tab/Shift+Tab, Escape closes the topmost menu/modal/card only, outside click cannot close the card while a modal is open, and focus returns to the action that opened the modal.

- [ ] **Step 7: Run interaction tests and verify RED**

Run: `bunx vitest run tests/components/CalendarEventEditing.test.tsx`

Expected: menu/dialog/confirmation/save flows fail.

- [ ] **Step 8: Implement the minimal approved flows**

Frontend builds an intent with pure helpers, requests preflight, renders returned impact, and applies the exact preflight. It never mutates local event/class data optimistically. On success, keep selection by stable ID so the open card shows reloaded values.

- [ ] **Step 9: Run component, type, and mandatory real-Tauri checks**

Run:

```bash
bunx vitest run tests/components/CalendarEventEditing.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
bun run e2e
```

Expected: all component flows and implemented real-Tauri save scenarios pass.

- [ ] **Step 10: Commit complete editing UI**

```bash
git add src/components/CalendarTab/StudioMenu.tsx src/components/CalendarTab/RecurrenceScopeDialog.tsx src/components/CalendarTab/StudentCountDialog.tsx src/components/CalendarTab/EuroOverrideDialog.tsx src/components/CalendarTab/CalendarEditConfirmationDialog.tsx src/components/CalendarTab/ModalDialog.tsx src/components/CalendarTab/EventDetailsCard.tsx src/components/CalendarTab/index.tsx tests/components/CalendarEventEditing.test.tsx tests/e2e/calendar-editing.e2e.ts
git commit -m "feat: edit invoice calendar lessons"
```

## Task 15: Complete deterministic end-to-end acceptance coverage

**Files:**

- Modify: `tests/e2e/fake-google-calendar.ts`
- Modify: `tests/e2e/calendar-editing.e2e.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/fixtures/e2e-google-calendar.json`

- [ ] **Step 1: Cover existing behavior and non-recurring reassignment**

Assert sync/navigation still work. Click a lesson, reassign it, and inspect fake-server log: exact instance URL, one PATCH, summary-only body, original suffix preserved, exact `If-Match`, and refreshed Calendar/Invoice/Income totals.

- [ ] **Step 2: Cover recurring occurrence versus series**

`This event` targets the instance. `Entire series` targets the master, reports cached impact/title exceptions, preserves master suffix, leaves title exceptions unchanged, and uses the confirmed master ETag.

- [ ] **Step 3: Cover legacy descriptions exactly**

Assert Set Students, Set Euros `0`/decimal, and configured-rate clearing write exact canonical descriptions. Unsupported-description Cancel logs zero PATCH; Replace logs exactly one. Students/euros never target a master.

- [ ] **Step 4: Cover conflict and authorization safety**

Use the control endpoint to mutate an occurrence/master after preflight. Assert `412`, no overwrite, latest value refresh, and no silent retry. Seed reader, missing write scope, and declined upgrade states; all stay readable and send zero PATCHes.

- [ ] **Step 5: Cover finalized-invoice lifecycle**

Edit a finalized occurrence and a series affecting multiple old/new studio-month keys. Assert warning details, active stale rows, disabled/guarded email, same-number re-finalization, counter unchanged, and stale clear after write. Reassign the last lesson away and prove the old stale-only row remains visible at zero lessons/€0.

- [ ] **Step 6: Cover remote-saved/local-pending safety**

Arm each one-shot Rust failpoint before saving so freshness or cache reconciliation fails only after fake Google accepts the PATCH. Assert UI says `Saved to Google; refreshing...`; reload the WebView to prove the journal survives restart; recovery calls local reconcile/sync, replays freshness without a revision bump, and fake request log remains at one PATCH.

- [ ] **Step 7: Run the complete E2E suite twice**

Run:

```bash
bun run e2e
bun run e2e
```

Expected: both runs pass independently with unique temp roots, no ordering dependence, no live OAuth/Google access, and deterministic PATCH counts.

- [ ] **Step 8: Commit acceptance coverage**

```bash
git add tests/e2e/fake-google-calendar.ts tests/e2e/calendar-editing.e2e.ts tests/e2e/helpers.ts tests/fixtures/e2e-google-calendar.json
git commit -m "test: cover calendar editing end to end"
```

## Task 16: Run complete verification and review

**Files:**

- Verify all files changed by Tasks 1-15.

- [ ] **Step 1: Format and run static checks**

Run:

```bash
bunx prettier --check "src/**/*.{ts,tsx}" "tests/**/*.{ts,tsx}" "docs/**/*.md"
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
bunx tsc --project tsconfig.app.json --noEmit
bunx tsc --project tsconfig.json --noEmit
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features webdriver -- -D warnings
```

Expected: no formatting, type, or lint errors.

- [ ] **Step 2: Run every test layer**

Run:

```bash
bun test
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features webdriver
bun run e2e
```

Expected: zero failures. Run from the implementation worktree so a separate user-owned `.worktrees/` checkout is not discovered as part of this suite; do not alter or delete that checkout.

- [ ] **Step 3: Verify scope and patch shape**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -15
```

Inspect the diff and fake-server assertions to confirm no create/delete/time/date/attendee/recurrence-rule/arbitrary-title or series-student/euro functionality entered scope.

- [ ] **Step 4: Request independent code review**

Use `superpowers:requesting-code-review`. Address only evidence-backed findings, rerun the affected focused tests after each fix, then rerun Step 2 before claiming completion.

## Explicitly out of scope

- Creating or deleting events.
- Editing date, time, duration, location, class text, arbitrary title, attendees, notes, reminders, or recurrence rules.
- `This and following`.
- Series-scoped students or euros.
- Batch/multi-calendar editing.
- Reassigning to an unconfigured studio.
- Modifying or retracting previously created Gmail drafts.
