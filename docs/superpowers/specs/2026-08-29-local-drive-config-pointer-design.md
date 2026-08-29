# Local Drive Configuration Pointer Design

**Date:** 2026-08-29
**Status:** Approved architecture; written specification pending final review

## Goal

Make the chosen Google Drive configuration file an explicit, stable device-local identity without storing configuration contents locally.

Normal startup must fetch the exact configuration file by its Drive file ID. Drive-wide metadata discovery remains available only when a device has no pointer or its pointer is definitively dead. Onboarding resolves Drive before Calendar so an existing Drive configuration can supply the selected Calendar.

## Scope

### Included

- Persist one local Drive configuration file ID on desktop and Android.
- Replace normal-startup Drive-wide configuration discovery with direct lookup by that ID.
- Retain Drive-wide discovery for first run and recovery from a definitively dead pointer.
- Require confirmation before adopting a discovered configuration.
- Present all discovered configurations when discovery is ambiguous.
- Reorder setup so Drive resolution precedes Calendar selection.
- Validate a recovered configuration's Calendar and skip Calendar selection when it remains accessible.
- Preserve current Drive YAML authority, ETag rules, invoice numbering, and root derivation from the configuration file's parent.

### Excluded

- Storing configuration YAML, folder IDs, folder names, Calendar data, or an onboarding-complete flag in the pointer record.
- Changing the remote YAML schema or metadata marker.
- Automatically choosing among multiple discovered configurations.
- Treating transient Drive failures as a dead pointer.
- Adding an app-private cloud registry or another cloud coordination file.

## Local Pointer

The application stores one versioned local record in app data:

```json
{
  "version": 1,
  "configFileId": "<Google Drive file ID>"
}
```

The version is storage framing, not application configuration. `configFileId` is the only authority-bearing value.

The record must:

- be written atomically using the existing application-storage durability pattern;
- use application-private file permissions where the platform supports them;
- reject malformed JSON, unknown versions, blank IDs, and extra fields;
- never contain YAML, a folder ID, a Drive ID, a folder name, Calendar fields, Google tokens, or cached Drive metadata;
- be replaced only after the selected remote configuration has been fetched and validated successfully;
- be removed only through an explicit reset or after a replacement has been durably installed.

Desktop and Android use the same Tauri commands and semantic record. Android stores the pointer in Lotus app data; it continues to obtain Google access tokens through Play Services.

## Configuration Identity

The Drive file ID identifies the selected configuration. The configuration file's current sole parent identifies the invoice root.

Moving or renaming the root therefore does not invalidate the pointer. Copying the root creates a different configuration file ID and does not affect a device already pointing at the original file.

Every direct load validates that the file:

- has the expected file ID;
- is named `lotus-invoices-config.yaml`;
- has MIME type `application/yaml`;
- has `lotusConfigSchema=1`;
- is not trashed;
- is editable and downloadable;
- has a non-empty ETag;
- has exactly one parent; and
- contains valid configuration YAML.

After validation, Lotus fetches the parent folder and its direct `Final` child using the existing root-validation rules.

## Startup State Machine

### Pointer present

1. Load and validate the local pointer record.
2. Obtain non-interactive Drive authorization.
3. Fetch the exact file by `configFileId`; do not run Drive-wide discovery.
4. Download and validate the configuration and resolve its root.
5. Validate the stored Calendar selection.
6. Enter the ready application when both Drive and Calendar are usable.

Malformed local pointer storage enters recovery without deleting the malformed record automatically.

### Pointer absent

1. Enter setup at Drive.
2. Obtain Drive authorization.
3. Run Drive-wide discovery for marked current and legacy configurations.
4. Resolve zero, one, or many candidates through the recovery UI.

### Pointer definitively dead

The application retains the old local pointer and enters the same Drive discovery flow used for an absent pointer. The old pointer is replaced only after the user confirms a valid existing configuration or a new configuration is created and verified.

### Transient failure

Offline errors, timeouts, rate limits, Google `5xx` responses, cancelled authorization, and other retryable failures do not start onboarding and do not change the pointer. They produce a blocking retry state for cold startup or the existing operational error state after a configuration is loaded.

## Dead-Pointer Classification

A pointer is definitively dead only when current authorized Drive evidence establishes that the selected file cannot be used:

- Drive returns a definitive not-found result;
- the file is trashed;
- the file remains inaccessible after interactive reauthorization;
- its exact identity metadata is invalid;
- it does not contain valid configuration YAML; or
- it no longer has exactly one usable parent.

Authorization failure by itself is not dead-pointer evidence. Permission failure first offers interactive reauthorization. Retryable transport and server failures remain transient.

Corrupt remote content or metadata enters recovery but is shown explicitly as `Invalid configuration`, not as an absent configuration.

## Initial and Recovery Discovery

Drive-wide discovery retains the existing exact filename and `lotusConfigSchema=1` metadata queries across My Drive and shared drives. Discovery is not used when a valid local pointer exists.

### One valid candidate

Show:

> Found existing configuration in “<folder name>”

The user must confirm. Before showing confirmation, Lotus validates the candidate, downloads its YAML, resolves its parent folder, and obtains the current folder name. Confirmation installs the candidate's file ID locally and continues to Calendar validation.

### Multiple valid candidates

Show a direct list containing, for each candidate:

- Drive folder name;
- stored Calendar name when readable; and
- `Use this configuration`.

Also show `Choose another folder`.

No candidate is selected implicitly. Confirming an entry atomically installs its file ID and continues to Calendar validation.

### No valid candidates

Open the normal Drive folder browser. Selecting a folder inspects only that folder for marked configuration files:

- one valid config: show the same confirmation before installing its file ID;
- multiple valid configs: show the localized candidate list;
- no config: retain the chosen folder as session-only staged state and continue to Calendar selection.

The staged folder is not persisted before a remote configuration exists.

## Calendar-Second Onboarding

Drive is the first setup step. Calendar is conditional and second.

After an existing configuration is confirmed, Lotus checks its `calendarId` against the current Google Calendar account:

- accessible Calendar: refresh the in-memory Calendar name and access role, persist changed metadata to the same Drive configuration using its ETag, and skip Calendar selection;
- missing, deleted, or inaccessible Calendar: keep the confirmed Drive configuration selected and show Calendar selection;
- transient Calendar failure: show Retry and do not claim that the Calendar is invalid.

After the user selects a replacement Calendar, Lotus updates the same Drive configuration with the Calendar ID, current name, and access role. The local file ID does not change.

When the selected folder contains no configuration, Calendar selection completes the data needed to create the initial Drive YAML. Lotus then:

1. creates and verifies the configuration inside the staged folder;
2. resolves the resulting file and root;
3. atomically stores the new file ID locally; and
4. enters the ready application.

If remote creation succeeds but local pointer persistence fails, setup reports the local persistence failure and offers Retry against the verified created file. It must not create another configuration.

## Existing Configuration Changes

- Moving the configuration file changes the selected invoice root on the next direct load because the file's parent remains authoritative.
- Renaming the root is reflected from live folder metadata.
- Duplicating the configuration elsewhere does not affect devices with a valid pointer.
- Deleting the selected file triggers recovery on the next definitive lookup.
- Changing Google accounts may make the pointer inaccessible. Lotus offers reauthorization before classifying it as dead and never silently adopts a configuration from the other account.
- Changing the root through Lotus moves the same configuration file ID; the local pointer remains unchanged.

## UI Flow

The Welcome wizard becomes Drive-first:

1. **Drive:** authorization, pointer recovery, discovery confirmation, candidate selection, or folder selection.
2. **Calendar:** shown only when the selected/new configuration has no accessible Calendar.

The Connections section continues to expose Calendar and Drive changes after setup.

The discovery confirmation and candidate chooser must show blocking errors inline, preserve selection across retryable failures, and support the existing desktop focus and Android Back behavior. Dismissing incomplete setup remains session-only.

There is still no persisted `onboardingComplete` flag. Readiness is derived from a validated pointed configuration, its root, Drive authorization, and an accessible Calendar.

## Concurrency and Stale-Async Rules

- Pointer reads and writes are serialized and conflict-safe across processes using the existing storage locking pattern.
- A pointer write validates the expected previous raw record so stale setup sessions cannot replace a newer selection.
- Authorization incarnation, setup session, candidate discovery, folder browsing, Calendar validation, and confirmation each participate in stale-result rejection.
- A to B to A account or selection transitions remain distinguishable through monotonic incarnations.
- Closing and reopening setup cannot allow an older discovery, validation, or confirmation to install a pointer.
- Remote configuration saves continue using ETags. A conflict reloads the pointed file and requires the user to retry the Calendar/configuration edit.

## Migration

Existing upgraded devices initially have no local pointer. Their first run uses discovery:

- one existing marked configuration: show the required folder confirmation, then install its file ID;
- multiple configurations: require explicit selection;
- no configuration: run Drive-first onboarding.

The migration does not recreate, move, or rewrite a valid existing configuration merely to install the pointer. Calendar metadata is rewritten only when live validation discovers a changed name or access role.

The old behavior that requires global uniqueness remains only during pointerless discovery. Once a candidate is confirmed, later duplicates do not block startup.

## Testing and Acceptance

### Local storage

- absent, valid, malformed, unknown-version, blank-ID, and extra-field records;
- atomic durable installation and expected-record conflict;
- permissions and desktop legacy app-data behavior;
- identical desktop/Android command semantics;
- failed local installation after verified remote creation does not create a second config.

### Direct startup

- valid pointer performs exact metadata/download/root loads and no Drive-wide list query;
- moved or renamed root remains valid;
- unrelated duplicate configs do not affect startup;
- stale-account and A to B to A authorization results cannot publish or replace state;
- retryable failures preserve the pointer and do not open onboarding;
- definitive missing, trashed, inaccessible-after-reauthorization, corrupt, and invalid-parent states enter recovery with distinct errors.

### Discovery and confirmation

- zero, one, and multiple candidates across My Drive and shared drives;
- one candidate requires confirmation and stores nothing before confirmation;
- multiple candidates show every validated folder plus `Choose another folder`;
- selected-folder inspection is limited to direct children;
- stale or closed confirmation sessions cannot install a pointer;
- pointer replacement is atomic and happens only after full remote validation.

### Calendar-second flow

- existing accessible Calendar skips Calendar selection;
- renamed Calendar refreshes its displayed/persisted name;
- deleted or inaccessible Calendar proceeds to Calendar selection without losing Drive selection;
- transient Calendar errors show Retry rather than invalidating the Calendar;
- replacement Calendar updates the same Drive file ID;
- a new folder creates configuration only after Calendar selection and persists the verified new file ID.

### Regression gates

- configuration ETag conflicts and invoice-number concurrency remain unchanged;
- changing Drive root keeps the same pointer;
- setup dismissal, desktop focus, Android Back, and responsive behavior remain correct;
- existing Calendar editing, invoice scanning/finalization, Gmail draft, PDF preview, Income, Rates, and migration behavior remain intact.

Final verification uses focused storage, Drive repository/store, setup/readiness, wizard, Calendar picker, and E2E tests; `bun run test`; both TypeScript checks; focused Rust storage tests; `bun run verify:drive-invoices`; `bun run verify:calendar-editing`; desktop E2E; and Android emulator setup/restart smoke.

## Rejected Alternatives

- **Drive-wide discovery on every boot:** fragile because unrelated duplicate configs can block an already configured device.
- **Persist the root folder ID:** leaves configuration identity ambiguous within the folder and makes folder identity authoritative instead of the config file.
- **Persist configuration contents:** creates a second configuration authority and stale-data behavior.
- **Cloud app-private registry:** adds another mutable cloud coordination record without a current requirement.
- **Automatically adopt one discovered config:** unsafe when the user authorized the wrong Google account.
- **Automatically choose among duplicates:** risks selecting the wrong invoice sequence and configuration.
