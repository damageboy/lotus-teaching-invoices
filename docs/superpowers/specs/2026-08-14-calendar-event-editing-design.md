# Calendar Event Editing Design

**Date:** 2026-08-14
**Status:** Approved

## Goal

Turn the Calendar tab into a safe editing portal for correcting invoice-relevant Google Calendar data without changing the existing read/sync behavior.

From a clicked lesson, the user can:

- reassign the event to a configured studio;
- set the participating student count; and
- set or clear a per-lesson euro override.

Every successful edit updates Google Calendar first. The local cache, calendar totals, invoice totals, and invoice status update only after Google accepts the change.

## Success criteria

- Existing calendar synchronization and invoice calculation continue unchanged when the user does not edit an event.
- A lesson chip opens an anchored, keyboard-accessible detail card.
- Studio reassignment changes only the studio prefix in the Google event summary.
- Student and euro edits use the existing description formats: `N` and `N/PEUR`.
- Recurring studio reassignment offers `This event` and `Entire series`.
- Student and euro edits always affect only the selected lesson, including when it belongs to a recurring series.
- The app never claims an edit succeeded before Google has accepted it.
- Editing a lesson covered by a finalized invoice is allowed after a warning, marks the invoice `Out of date`, disables email drafting, and requires re-finalization with the same invoice number.
- Users who decline the new Google Calendar write permission retain the current read-only application behavior.

## Existing behavior to preserve

The current application reads Google Calendar API v3 events through the Rust incremental sync service, stores expanded event instances in SQLite, maps them to `CalendarEvent`, and parses them into `ParsedClass`. The Calendar, Invoices, and Income views consume the same parsed classes. The older TypeScript `fetchEvents` helper is not the active read path.

The write feature extends that path; it does not create a parallel frontend-only event store and does not return to ICS fetching.

```text
Google Calendar
      |
      v
Rust incremental sync -> SQLite event cache -> parser -> Calendar / Invoices / Income
```

## User experience

### Event detail card

`EventChip` becomes a real button. Clicking it opens a portal-rendered card anchored to the chip, similar to the compact Google Calendar event card. Positioning chooses the available side of the chip and keeps the complete card within the application viewport.

The card shows:

- the event title;
- date and time;
- `Recurring event` when recurrence metadata is present;
- the current studio;
- the current student count, or `Not set`;
- the current euro override, or `Configured studio rate`; and
- inline save success or failure state.

The three action rows are:

1. `Fix Studio`
2. `Set Students`
3. `Set Euros`

When calendar editing is unavailable, the card remains useful as a read-only detail card. Editing rows are disabled with one specific explanation:

- `Allow calendar editing to make changes` when the write scope was not granted; or
- `You only have read access to this calendar` when the selected calendar is not writable.

### Fix Studio

`Fix Studio` opens a submenu containing the configured studio keys, using the existing studio colors. The current studio is marked and cannot produce a no-op save.

The operation replaces only the summary text before the first `/`. Everything after the first `/`, including the location, class type, spelling, and spacing, remains unchanged.

Example:

```text
Before: Wrong Studio / Kreuzberg / Pilates
After:  Correct Studio / Kreuzberg / Pilates
```

Fix Studio is available only when the title has one of the parser's supported structures:

- `Studio / Class`
- `Studio / Location / Class`

The current Calendar view renders parsed lessons, so events with an unsupported title structure remain skipped and are not clickable. Unknown-but-well-formed studio names remain visible and can be reassigned. If stale or newly refreshed data makes an unsupported structure reach the card, Fix Studio is disabled and explains that the title must be corrected in Google Calendar. Editing arbitrary title, location, or class text is outside this scope.

For a non-recurring event, selecting a studio targets that event. For a recurring event, selecting a studio presents exactly two scope choices:

- `This event` — patch the selected expanded instance.
- `Entire series` — patch the recurring master, affecting the Google series in the past and future.

There is no `This and following` option.

`This event` preserves the selected occurrence's suffix. `Entire series` runs a preflight that loads the master and preserves the master's location/class suffix. Its confirmation shows the complete current and proposed master summaries and is tied to the master's preflight `etag`.

Existing per-occurrence title exceptions remain exceptions under Google's recurrence semantics; the feature does not fan out PATCH requests across detached exceptions. For preflight and invoice impact, a cached instance is considered affected only when its current summary exactly matches the confirmed master summary. An instance with a different summary is classified as a title exception, excluded from affected lesson/invoice counts, and reported separately as remaining unchanged.

Before an entire-series save, the confirmation states that past and future lessons are affected and shows:

- the number of currently cached, non-title-exception lesson instances that will change;
- the number of cached title exceptions that will remain unchanged; and
- the number of finalized invoice rows that will become out of date.

These counts describe locally cached lessons and finalized invoices; they are not presented as the total number of all future Google occurrences.

### Set Students

`Set Students` opens a modal dialog containing an integer number input with spinner controls.

- Minimum: `1`
- Step: `1`
- Initial value: the parsed student count when it is valid
- Scope: selected lesson only

Saving serializes the description to the legacy format:

- without an existing euro override: `N`
- with an existing euro override: `N/PEUR`

Changing students preserves an existing valid euro override. For example, changing `9/30EUR` to 12 students writes `12/30EUR`.

### Set Euros

`Set Euros` is disabled when the selected lesson has no unambiguous positive student count. Its helper text is `Set students first.`

The modal contains a non-negative euro number input with spinner controls:

- Minimum: `0`
- Step: `0.01`
- At most two decimal places
- Scope: selected lesson only

Saving an override writes `N/PEUR`, using `.` as the decimal separator and removing unnecessary trailing zeroes. Examples: `9/30EUR`, `9/30.5EUR`, `9/30.25EUR`.

The dialog also offers `Use configured studio rate`. This removes the override and writes only `N`.

### Description replacement warning

The two supported description forms are:

```text
N
N/PEUR
```

Whitespace around the complete value and around `/` is accepted when recognizing existing legacy data, and existing `EUR` matching is case-insensitive. New writes are canonical, contain no whitespace, and use uppercase `EUR`.

This replacement-safety grammar is deliberately narrower than the existing display parser. A description such as `students: 9` may still produce a student count for backward-compatible invoice display, but it is not one of the two safe replacement forms and therefore requires the warning.

If the existing description does not match either complete supported form, `Set Students`, `Set Euros`, and `Use configured studio rate` must warn before replacing it. The confirmation shows both complete values:

```text
Current description:  <old value>
New description:      <proposed value>
```

The available actions are `Cancel` and `Replace`. `Cancel` makes no local or remote change. The warning is not shown for a supported legacy description.

### Saving feedback

Only the row being saved is disabled. The card remains open so the user can see the result.

- During the request: show a spinner and `Saving...` on the affected row.
- Success: update the displayed value and briefly show `Saved to Google`.
- Recoverable failure: retain the old value and show the specific error with `Retry`.
- Remote success followed by local reconciliation failure: show `Saved to Google; refreshing...`; do not offer another PATCH as the immediate retry.

## Accessibility and interaction rules

- Event chips and all card/menu rows are native buttons with visible focus styles.
- `Enter` and `Space` open the card or activate the focused action.
- Arrow keys move through an open studio menu; `Home` and `End` jump to its bounds.
- `Escape` closes the topmost menu, dialog, or card.
- Clicking outside closes the card when no modal is open.
- Modals trap focus and return focus to the action that opened them.
- Closing the card returns focus to its event chip.
- The card uses appropriate dialog/menu relationships and accessible names; save and error messages use a polite live region.
- Portal positioning is recalculated on scroll, resize, and calendar month navigation.

## Data model

### Event identity

The complete identity needed for safe writes must survive Google mapping, SQLite storage, TypeScript mapping, and class parsing:

```text
calendarId
eventId
recurringEventId?    // recurring master ID
originalStartTime?   // stable occurrence identity supplied by Google
etag?                // optimistic-concurrency version
```

`CalendarEvent.uid` currently holds the Google event ID, but `ParsedClass` drops it. Introduce one explicit event-identity value and attach it to every parsed class. The UI must never reconstruct an event ID from date, time, studio, array position, or React key.

The SQLite `calendar_events` migration adds nullable `recurring_event_id`, `original_start_time`, and `etag` columns. Because the current migration only creates missing tables, this change requires an explicit, idempotent schema-version/column migration rather than only editing the existing `CREATE TABLE IF NOT EXISTS` statement.

An incremental sync token cannot backfill unchanged events. Record an event-identity schema version in calendar sync state. On the first refresh after migration, perform a one-time full resync for the selected calendar into staging storage while continuing to serve the old cache read-only. Only after every page and the new sync token succeed does one SQLite transaction replace that calendar's old event rows and sync state. On failure, discard staging data and retain the old readable cache; events lacking complete identity remain read-only until a later successful full resync.

The Google response mappers on both the Rust sync path and the retained TypeScript mapper preserve the same fields. Expanded recurring events continue to be requested with `singleEvents=true`.

### Calendar write capability

Calendar-list entries retain Google's `accessRole`. The selected calendar keeps the last observed role for early UI gating:

```text
canEdit = granted calendar write scope
       && accessRole is owner or writer
```

The cached role is a usability hint, not an authorization boundary. Google remains authoritative. An explicit permission denial followed by a calendar-list result below `writer` disables editing for the selected calendar. HTTP status alone is insufficient because Google can also use `403` for rate and quota limits.

If the access role is missing or stale, editing remains disabled until the calendar list is refreshed. `reader` and `freeBusyReader` calendars are always read-only.

### Finalized-invoice freshness

Finalized invoice existence and number continue to come from the PDF in the `Final` folder. Add persisted freshness metadata keyed by selected calendar, canonical output folder, studio, and month:

```text
calendar_id
output_dir
studio_name
month_key          // YYYY-MM
invoice_number
final_filename
stale_at
reason
cleared_at?
```

Only finalized invoices receive a stale record. A later edit resets `cleared_at` to null and updates the reason. Successful re-finalization sets `cleared_at`; it does not allocate a new invoice number.

Including the output folder prevents status from leaking when the user switches invoice destinations. The freshness store must be available to both the calendar edit policy and `InvoicesTab`. It may share the existing application SQLite database, but it is separate from the Google event cache lifecycle: clearing an expired calendar sync token must not erase invoice freshness records.

## Authentication migration

The current token can contain `gmail.compose` and `calendar.readonly`, which cannot authorize event updates. The update retains those scopes and additionally requests `calendar.events`. It introduces a versioned token record containing the actual granted scopes and authorization schema version.

On the first launch after installing this version:

1. Show an immediate in-app explanation that calendar editing needs additional Google permission.
2. `Allow calendar editing` starts a new OAuth consent flow requesting the existing Gmail/read scopes and Google Calendar event write access, with incremental authorization enabled so prior grants can be returned.
3. Do not delete or overwrite the existing token until the new code exchange succeeds.
4. Inspect the token response's actual space-delimited `scope` value; never assume every requested permission was granted.
5. Replace the existing token only when the new grant preserves `gmail.compose` and `calendar.readonly`. Enable editing only when that accepted grant also contains `calendar.events`.
6. If the grant is partial and omits a required existing scope or the write scope, discard the new token, retain the old token, explain that calendar editing was not enabled, and remain read-only.
7. On a complete grant, persist the new token, actual granted scopes, and authorization version; enable editing for writer/owner calendars. If the successful incremental token response omits `refresh_token`, preserve the existing refresh token rather than storing an empty value.
8. If the user chooses `Not now`, closes the consent flow, denies it, or it times out, retain the existing token and continue in read-only mode.

Declining write access never blocks calendar sync, invoice generation, or the rest of the app. A disabled edit action can reopen the permission explanation later.

Refreshing an old token must not be treated as acquiring the new scope. Capability is determined from the stored granted scopes/version, not from whether an access token exists.

On startup, `useCalendarData` loads and parses the existing SQLite cache independently before attempting remote synchronization. The permission prompt does not block that cache load. A declined or timed-out scope upgrade therefore cannot make previously cached lessons disappear.

## Edit architecture

```text
Anchored event card
        |
        v
Pure input and legacy-format helpers
        |
        v
Tauri preflight (policy and impact)
        |
        v
User confirmation when required
        |
        v
Tauri apply command
        |
        v
Google Calendar PATCH with If-Match
        |
        v
SQLite reconcile -> parse -> recalculate Calendar / Invoices / Income
```

### Frontend responsibilities

The frontend owns presentation and pure intent construction:

- validate spinner input;
- build the proposed summary or description with pure helpers;
- choose occurrence or series scope where permitted;
- request preflight and render its affected lesson/finalized-invoice impact;
- request unsupported-description and finalized-invoice confirmations;
- obtain a valid access token; and
- render the typed command result.

The UI does not mutate the cached event or parsed class optimistically.

### Rust update service

Add one focused calendar-update service behind typed Tauri preflight/apply commands. The preflight request contains the selected event identity, requested change, and scope. It returns the exact target version, proposed field value, affected cached instances, finalized-invoice impact, and any required confirmation data.

The apply request contains:

- selected calendar ID;
- selected instance identity;
- target scope (`occurrence` or `series`);
- a discriminated change: `{ kind: studio, studioName }` or `{ kind: description, description }`;
- the exact target `etag` and proposed value returned by preflight; and
- the precomputed finalized-invoice impact needed for post-success freshness updates.

The service rejects any request that attempts to change date/time, attendees, recurrence rules, location, or another unapproved event field.

Before any remote PATCH, apply revalidates that the selected cached target and the strict finalized-PDF result still match preflight. If either changed, return `preflightExpired` and require a fresh confirmation rather than silently changing the warning's scope.

For an occurrence edit, preflight derives the allowed field value from the selected cached event and targets the selected `eventId`. For an entire-series studio edit, preflight GETs the `recurringEventId` master and derives the new summary from that master and requested studio key. The selected instance `etag` must not be reused for the master.

The confirmation renders the master summary and `etag` returned by preflight. Apply PATCHes the exact proposed master summary with `If-Match` set to that confirmed `etag`; it must not silently substitute an `etag` from a newer GET. A master change between confirmation and apply therefore returns the normal concurrency conflict and requires a new preflight/confirmation.

Every PATCH:

- addresses the configured calendar and exact Google event ID;
- sends only `summary` or `description`;
- uses `If-Match` with the target event's `etag`; and
- treats Google's returned event as authoritative.

Student and euro requests are rejected if they ask for series scope. Series scope is accepted only for studio reassignment with a valid `recurringEventId`.

### Reconciliation

After Google accepts an occurrence PATCH, upsert the returned expanded instance into SQLite, then re-list and reparse cached events. The ordinary incremental sync may safely see the same update later because event upserts are idempotent.

After Google accepts a master PATCH, run an authoritative sync before returning the refreshed class data. If the incremental response cannot reconcile the cached series instances, perform the same staged full-sync replacement for only the selected calendar. Compare before/after series membership during reconciliation; if Google changed an additional cached instance beyond the preflight classification, also mark that instance's affected finalized invoice keys stale.

Persist the precomputed invoice freshness changes immediately after remote success. Retain that preflight context until freshness and cache reconciliation finish, so an internal retry does not require another Google PATCH. If Google succeeds but cache or freshness reconciliation fails, return a distinct `remoteSavedReconcilePending` result. The UI reports remote success, keeps the old local display temporarily, and forces refresh/reconciliation instead of sending the PATCH again.

## Invoice impact and finalized invoices

Before saving, derive affected invoice keys from the selected cached event(s):

- student change: current studio and month;
- euro override change: current studio and month;
- occurrence studio reassignment: both old and new studio for that month;
- series studio reassignment: old and new studio/month keys for every currently cached instance whose summary exactly matches the confirmed master summary; cached title exceptions are excluded.

For each unique key, perform a strict finalized-PDF lookup and recover its invoice number and filename using the existing filename rules. The lookup has distinct `not found`, `one match`, `ambiguous`, and `unreadable` outcomes. A missing `Final` directory means `not found`; an unreadable directory or multiple matching finalized PDFs blocks the calendar write with a specific error rather than being treated as no finalized invoice.

If no affected finalized invoice exists, save normally. If one or more exist, warn and allow the edit. The confirmation names the affected lesson or series and lists the finalized invoice rows that will become out of date.

After remote success:

- mark those rows `Out of date`;
- continue showing recalculated current totals from the refreshed calendar data;
- disable `Draft Email...` for each stale row with `Re-finalize the invoice first.`;
- keep preview generation available; and
- change finalization to re-finalization for stale rows.

`InvoicesTab` builds its rows from the union of current class-derived rows and active stale records. Therefore, reassigning the last lesson away from a studio does not hide the old out-of-date invoice. A stale-only row shows the current state, including zero lessons and a €0 total when no lessons remain, and remains re-finalizable.

Re-finalization resolves the stale record and existing filename before validating the global invoice counter. It overwrites the recorded finalized PDF after confirmation, reuses the recorded invoice number even when it belongs to a different year than `lastInvoice`, and does not increment `lastInvoice`.

Final PDF writing and opening become separate results. Clear stale state immediately after the replacement PDF is written successfully; failure to open an already-written PDF is reported separately and must not leave the invoice marked stale.

Email drafting is guarded twice: the button is disabled for an active stale record and the handler/service checks freshness again before creating a draft.

The feature does not retract or modify an email draft that was created before the calendar edit.

## Error handling

### Optimistic-concurrency conflict

If Google rejects `If-Match` because the event changed elsewhere:

- do not retry the old PATCH automatically;
- do not overwrite the remote event;
- fetch/sync the latest event;
- refresh the card with the latest values; and
- show `This event changed in Google Calendar. Review it and try again.`

### Authentication and authorization

- `401`: attempt the existing token refresh/re-authorization path once; if it still fails, leave the edit unsaved and request authorization.
- `403` with `userRateLimitExceeded`, `rateLimitExceeded`, or `quotaExceeded`: retain write capability, use bounded exponential backoff where appropriate, and show a retryable limit error.
- `403` with a permission-related reason: leave the edit unsaved and refresh the calendar list. Disable editing only when the refreshed role is no longer `writer`/`owner` or the stored grant no longer contains the write scope.
- Other `403` reasons, including `forbiddenForNonOrganizer`, are surfaced specifically and do not automatically downgrade the complete calendar to read-only.
- Missing write scope: do not call the update command.

### Network and Google service failures

Retain the old local event, show a concise error, and provide `Retry`. Retry runs a new preflight for the same requested change. It never substitutes a newer `etag` behind the previous confirmation; if target values or invoice impact changed, show the refreshed details and require confirmation again before apply.

### Unsupported local data

- Unsupported title structure: disable Fix Studio; do not guess a class title.
- Missing, zero, or ambiguous students: disable Set Euros until Set Students succeeds.
- Unsupported description: require the explicit old/new replacement confirmation.
- Event no longer present: close editing actions after refresh and report that the event was removed.

### Local reconciliation failure after remote success

Never describe this as a failed Google save. Show `Saved to Google; refreshing...`, log the specific local failure, and force selected-calendar synchronization. Errors must preserve enough edit and invoice-impact context to finish stale marking without another remote PATCH.

## Component boundaries

Keep each unit focused:

- `EventChip`: accessible trigger and existing visual states only.
- `EventDetailsCard`: anchoring, values, action state, and feedback.
- `StudioMenu`: configured-studio selection only.
- `RecurrenceScopeDialog`: `This event` versus `Entire series` confirmation.
- `StudentCountDialog`: integer input and validation only.
- `EuroOverrideDialog`: currency input, validation, and configured-rate action.
- description helpers: recognize, parse, and serialize the two legacy formats.
- summary helper: replace only a valid studio prefix.
- edit policy: validate allowed change/scope and calculate invoice impact.
- calendar update client: typed Tauri command wrapper.
- Rust Google update service: HTTP concurrency, remote update, and reconciliation.
- invoice freshness store: persist/query/clear out-of-date status.

`CalendarTab`, `useCalendarData`, and `InvoicesTab` consume these units. They should not absorb the parsing, HTTP, or impact rules directly.

## Testing

### TypeScript unit tests

- Summary rewriting preserves the complete suffix after the first `/`.
- Unsupported title structures are rejected without guessing.
- Description recognition accepts only complete legacy forms, with tolerated legacy whitespace.
- Description serialization produces canonical `N` and `N/PEUR` values.
- Student changes preserve an existing override.
- Clearing an override produces `N`.
- Euro validation accepts zero and at most two decimals.
- Edit policy rejects series-scoped student/euro changes.
- Invoice-impact calculation covers old/new studios, months, duplicate keys, and cached recurring instances.

### Rust unit and integration tests

- SQLite migration preserves existing rows and round-trips recurrence identity and `etag`.
- Identity-schema migration performs one staged full resync, atomically replaces rows on success, and preserves the old cache on failure.
- Calendar sync maps `recurringEventId`, `originalStartTime`, and `etag`.
- Occurrence updates target the instance ID; series updates GET/PATCH the master ID.
- PATCH bodies contain only the allowed field.
- `If-Match` uses the correct occurrence or master `etag`.
- A master change after preflight conflicts instead of substituting a newer `etag`.
- Title exceptions are excluded from series lesson and invoice-impact counts.
- Fake Google responses cover success, pagination/reconciliation, `401`, permission `403`, rate/quota `403`, `404`, conflict, and network failure.
- Remote-success/local-reconcile-failure returns the distinct pending result.
- Invoice freshness records survive selected-calendar cache reset and clear only after successful re-finalization.
- Finalized-PDF lookup distinguishes missing, unreadable, and ambiguous states.
- Partial OAuth grants never replace a token that still supports existing read/Gmail behavior and never enable editing without `calendar.events`.

### React component tests

- Clicking and keyboard activation open the anchored card.
- Card focus, outside click, Escape, modal focus trap, and focus restoration work.
- Studio menu exposes only configured studios and marks the current one.
- Recurring studio edit shows exactly two scope choices.
- Student/euro dialogs initialize and validate correctly.
- Set Euros is disabled with `Set students first.` for missing/zero/ambiguous counts.
- Unsupported descriptions show the exact old and proposed values before replacement.
- Saving disables only the active action and renders success, retryable failure, conflict, and reconciliation-pending states.
- Read-only scope/access-role states cannot invoke an update.
- Stale invoice rows show `Out of date`, disable Draft Email, and reuse the original number on re-finalization.
- A stale-only row remains visible with zero current lessons.
- Cross-year re-finalization bypasses `lastInvoice` validation and reuses the recorded number.
- PDF write success followed by file-open failure still clears stale state.

### Tauri E2E

The E2E path must use the real Tauri app with a deterministic local fake Google Calendar backend. It must never use a developer's live Google account or OAuth grant. The Rust Calendar API base URL is injectable only in test builds, and fixtures preload the selected calendar, access role, token capability, cache, and finalized PDFs.

At minimum, E2E covers:

- existing calendar sync and navigation still work;
- a non-recurring studio edit changes only the summary prefix;
- recurring `This event` targets the instance and `Entire series` targets the master;
- a master change after the entire-series confirmation produces a conflict and no PATCH overwrite;
- cached title exceptions are reported and excluded from series invoice impact;
- student, euro override, and configured-rate saves produce exact descriptions;
- unsupported-description cancel sends no PATCH and replace sends one PATCH;
- a concurrency conflict never overwrites the fake server's latest event;
- a reader calendar and declined scope remain read-only;
- editing a finalized lesson marks both affected rows where applicable, disables email drafting, and re-finalizes with the same invoice number.
- reassigning a studio's final lesson leaves a visible stale-only row that can be re-finalized.

Implementation verification must run:

```bash
bun test
bunx tsc --project tsconfig.app.json --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
bun run e2e
```

`bun run e2e` is mandatory because this feature changes Calendar UI and Tauri behavior.

## Rollout behavior

- Existing SQLite databases migrate in place.
- Existing calendar events remain readable while the one-time staged full resync fills new identity fields.
- Cached events load before remote sync or the scope-upgrade prompt can affect availability.
- An event without an `etag` or complete identity is visible but read-only until refreshed.
- The one-time write-permission prompt appears immediately after the application update; declining it is remembered for this authorization version and does not repeat on every launch.
- No existing calendar or invoice data is rewritten merely by installing the update.

## Non-goals

- Creating or deleting Google Calendar events.
- Editing event date, time, duration, class type, location, arbitrary title text, attendees, notes, reminders, or recurrence rules.
- A `This and following` recurrence option.
- Series-scoped student or euro changes.
- Reassigning to an unconfigured studio.
- Batch editing multiple selected lessons.
- Editing multiple selected calendars at once.
- Preserving arbitrary free-form description notes after the user explicitly approves replacement.
- Retracting or updating Gmail drafts already created from an older finalized invoice.
