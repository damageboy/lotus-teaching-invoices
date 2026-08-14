# Calendar Event Editing Vertical-Slice Plan

> **For agentic workers:** Work on one milestone only. Checkpoint after 10 minutes and stop after 20 minutes if the milestone is not ready for focused verification. Do not broaden the milestone to unrelated hardening.

**Goal:** Deliver the approved calendar editing portal as visible, end-to-end increments instead of completing every backend layer before the UI.

**Starting point:** `d2b96505a51ac906a21770c8c7e2bca8e9a26d0e` on `codex/calendar-event-editing`. Tasks 1-8 from the original plan are committed. The incomplete stale-invoice implementation is preserved separately at `codex/calendar-event-editing-stage9-wip` (`f960454`) and must not be cherry-picked wholesale.

**Architecture:** Each milestone starts at a clicked calendar event, crosses the typed Rust/Google boundary, updates authoritative cache state, and ends in visible UI. Reuse the committed identity, OAuth, capability, E2E, finalized-file, and freshness foundations. Add invoice re-finalization only after the three calendar edit actions work.

## Execution rules

- One implementation agent at a time; no parallel edits in the shared worktree.
- One checkpoint after 10 minutes. If blocked or above roughly 500 changed production lines, stop and split the milestone.
- Focused tests during implementation. Run the full Node 24 Tauri E2E suite once, at the end of each milestone.
- One spec review followed by one quality review. Allow one focused correction round. A second blocker round is surfaced to the user instead of starting another open-ended loop.
- Blocking findings are limited to approved behavior, data loss, authorization, incorrect Google writes, invoice-number corruption, or touching live user state. Record unrelated harness hardening separately.
- Every milestone ends with a working user-visible result and a commit.
- Use the Stage 9 WIP branch only as a reference. Restore individual ideas/tests deliberately; do not cherry-pick its 2,651-line snapshot.

---

## Milestone 1: Reassign one calendar occurrence

**User-visible result:** Clicking a lesson opens the anchored event card. `Fix Studio` changes this occurrence in Google Calendar, refreshes the cache, and updates the calendar chip.

**Primary files:**

- Create: `src-tauri/src/calendar_edit.rs`
- Create: `src/lib/calendar/calendar-update.ts`
- Create: `src/components/CalendarTab/EventDetailsCard.tsx`
- Create: `tests/components/CalendarEventEditing.test.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/hooks/useCalendarEditing.ts`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/components/CalendarTab/CalendarGrid.tsx`
- Modify: `src/components/CalendarTab/EventChip.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] Add a failing Rust occurrence-studio preflight/apply test using event ID and exact ETag.
- [ ] Implement only occurrence studio summary rewriting, authoritative writer/owner check, `If-Match`, returned-instance cache upsert, and typed conflict/permission failures.
- [ ] Add failing component tests for click, anchored card, configured-studio selection, saving, conflict, and focus return.
- [ ] Implement the smallest anchored card using existing styles and buttons.
- [ ] Add one real-Tauri test that reassigns a seeded occurrence and observes the refreshed chip.
- [ ] Run focused Rust/component tests, TypeScript, then one exact Node 24 `bun run e2e`.
- [ ] Review once and commit `feat: reassign calendar occurrences`.

**Explicitly deferred:** students, euros, recurrence scope, combined confirmations, stale-invoice UI, and re-finalization.

---

## Milestone 2: Set students and euro override for one lesson

**User-visible result:** The same event card can set a positive student count, then set/clear the euro override. `Set Euros` stays disabled until a valid student count exists.

**Primary files:**

- Create: `src/components/CalendarTab/ModalDialog.tsx`
- Create: `src/components/CalendarTab/StudentCountDialog.tsx`
- Create: `src/components/CalendarTab/EuroOverrideDialog.tsx`
- Modify: `src-tauri/src/calendar_edit.rs`
- Modify: `src/lib/calendar/calendar-update.ts`
- Modify: `src/hooks/useCalendarEditing.ts`
- Modify: `src/components/CalendarTab/EventDetailsCard.tsx`
- Modify: `tests/components/CalendarEventEditing.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] Add failing occurrence-only description tests for students, euro override, configured rate, unsupported-description warning, and exact canonical output.
- [ ] Extend the existing Rust preflight/apply path with description-only PATCH and exact ETag; reject series scope.
- [ ] Add accessible modal tests, numeric validation, focus trap/return, and per-action feedback.
- [ ] Implement students first; gate euro actions on a valid positive count.
- [ ] Add real-Tauri student/euro save and cache-refresh checks.
- [ ] Run `bun run verify:calendar-editing`; defer the cold E2E build to the final integrated checkpoint.
- [ ] Review once and commit `feat: edit calendar lesson values`.

---

## Milestone 3: Reassign an entire recurring series

**User-visible result:** A recurring lesson offers `This event` or `Entire series`; series reassignment shows the affected count and title exceptions, confirms once, patches the master, and reconciles expanded instances.

**Primary files:**

- Create: `src/components/CalendarTab/RecurrenceScopeDialog.tsx`
- Create: `src/components/CalendarTab/CalendarEditConfirmationDialog.tsx`
- Modify: `src-tauri/src/calendar_edit.rs`
- Modify: `src-tauri/src/calendar_api.rs`
- Modify: `src-tauri/src/calendar_store.rs`
- Modify: `src/lib/calendar/calendar-update.ts`
- Modify: `src/hooks/useCalendarEditing.ts`
- Modify: `src/components/CalendarTab/EventDetailsCard.tsx`
- Modify: `tests/components/CalendarEventEditing.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] Add failing master-ID/master-ETag, title-exception, impact-count, and reconcile-pending tests.
- [ ] Implement authoritative series preflight, exact confirmed ETag apply, incremental reconciliation, and staged-full-sync fallback.
- [ ] Add recurrence scope and confirmation UI tests.
- [ ] Add real-Tauri series reassignment and conflict tests.
- [ ] Run `bun run verify:calendar-editing`; defer the cold E2E build to the final integrated checkpoint.
- [ ] Review once and commit `feat: reassign recurring calendar series`.

---

## Milestone 4: Make affected invoices visibly out of date

**User-visible result:** A successful calendar edit marks only finalized affected invoices stale. The Invoices tab retains stale-only rows, shows `Out of date`, and disables email with `Re-finalize the invoice first.`

**Primary files:**

- Create: `src/lib/invoice/rows.ts`
- Create: `tests/invoice/rows.test.ts`
- Create: `tests/components/InvoicesTab.test.tsx`
- Modify: `src-tauri/src/calendar_edit.rs`
- Modify: `src-tauri/src/invoice_freshness.rs`
- Modify: `src/hooks/useInvoiceFreshness.ts`
- Modify: `src/components/InvoicesTab/index.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/gmail/drafts.ts`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] Add failing affected-key tests for occurrence and series edits; mark only keys with a strict finalized PDF.
- [ ] Add row-union tests for current/stale dedupe and stale-only zero-class/zero-total rows.
- [ ] Add fail-closed loading/error tests and an immediate local clear/mark acknowledgement API.
- [ ] Add the stale label and guarded email action; use verified PDF bytes from Rust.
- [ ] Add one real-Tauri edit-to-stale-row test.
- [ ] Run focused tests, TypeScript, and one exact Node 24 E2E run.
- [ ] Review once and commit `feat: show out-of-date invoices`.

**Explicitly deferred:** writing/replacing a finalized PDF.

---

## Milestone 5: Guarded same-number re-finalization

**User-visible result:** `Re-finalize Invoice...` regenerates the current invoice with the recorded number and filename, never increments the counter, clears stale state after a verified write, and treats open failure as a written invoice.

**Primary files:**

- Create: `tests/pdf/generatePdf.test.ts`
- Modify: `src-tauri/src/invoice_files.rs`
- Modify: `src-tauri/src/invoice_freshness.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/invoice/freshness.ts`
- Modify: `src/lib/pdf/generatePdf.ts`
- Modify: `src/components/InvoicesTab/index.tsx`
- Modify: `src/hooks/useConfig.ts`
- Modify: `tests/components/InvoicesTab.test.tsx`
- Modify: `tests/e2e/calendar-editing.e2e.ts`

- [ ] Add failing cross-year, zero-class, counter-failure, config-concurrency, directory/target race, concurrent-write, reload-failure, and open-failure tests.
- [ ] Split PDF generation from opening.
- [ ] Implement a guarded Rust write through the verified no-follow file descriptor; fsync, revalidate visible target/directory, then CAS-clear freshness. At most one expected-revision write succeeds.
- [ ] Persist only `lastInvoice` against the latest config state. Never overwrite newer settings or report success after counter persistence failure.
- [ ] Reuse the exact recorded invoice number/filename; never touch the counter for stale re-finalization.
- [ ] Add one real-Tauri same-number overwrite/open-failure test.
- [ ] Run focused tests, TypeScript, full Rust, and one exact Node 24 E2E run.
- [ ] Review once and commit `feat: re-finalize out-of-date invoices`.

---

## Final verification

- [ ] Run `bun test`.
- [ ] Run `bunx tsc --project tsconfig.app.json --noEmit` and CLI TypeScript.
- [ ] Run full Cargo tests for default and `webdriver`.
- [ ] Run one exact Node 24 `bun run e2e`.
- [ ] Perform one whole-feature review against the approved design, limited to Critical/Important product or data-safety defects.
- [ ] Present the working calendar portal for user inspection.
