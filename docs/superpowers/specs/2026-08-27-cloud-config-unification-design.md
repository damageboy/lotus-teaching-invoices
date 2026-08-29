# Google Drive Configuration Unification Design

## Goal

Use one Google Drive YAML file as the durable authority for desktop and Android application configuration and invoice numbering. Keep only Google authorization credentials, the selected Drive config file ID, and disposable operational data locally.

## Scope

- Replace the local application `config.yaml` and Drive `.lotus-teaching-invoices.json` with one Drive file named `lotus-invoices-config.yaml`.
- Preserve the existing configuration fields and YAML layout.
- Add one durable field: `invoiceSequenceByYear`.
- Rename the desktop authorization record from `gmail-tokens.json` to `google-tokens.json` without changing its contents.
- Provide repeatable migration and rollback instructions for every existing configuration.

The standalone CLI may still accept an explicit local `--config` input. That input is not application authority and is outside this migration.

## Remote File

`lotus-invoices-config.yaml` lives directly inside the selected invoice root. Google Drive file metadata identifies it with the existing custom property:

```text
lotusConfigSchema=1
```

Discovery requires the exact filename, the metadata property, a non-trashed file, download permission, and edit permission. Discovery is used only when no valid local file-ID pointer exists or that pointer is definitively dead. Every discovered candidate requires user confirmation, including a single candidate; multiple valid candidates are directly selectable.

The file's actual Google Drive parent is the invoice root. No root folder ID, Drive ID, folder name, or `Final` folder ID is stored in YAML. The application fetches the parent folder metadata and finds its single `Final` child by name.

## YAML Schema

The existing configuration remains top-level and unchanged. One top-level map is added:

```yaml
teacher:
  name: Example Teacher
  address: |-
    Example Street 1
    10115 Berlin
  taxNumber: 12/345/67890
  bankDetails:
    accountOwner: Example Teacher
    iban: DE00000000000000000000
    bic: EXAMPLEBIC

calendarId: example@group.calendar.google.com
calendarName: Teaching Calendar
calendarAccessRole: owner

studios:
  Example Studio:
    fullName: Example Studio GmbH
    address: Example Street 2
    invoiceEmail: invoices@example.test
    color: '#7c3aed'
    rateTiers:
      - minStudents: 1
        maxStudents: null
        rate: 80

invoiceSequenceByYear:
  '2026': 9
```

`invoiceSequenceByYear` maps a four-digit invoice year to the greatest number already allocated for that year. Values are non-negative safe integers. A missing year means zero.

The unified schema does not contain `outputDir`, `lastInvoice`, `root`, `finalFolderId`, `generation`, or `reservation`.

## Authority and Saving

Google Drive is the only durable configuration authority after migration. The application holds the downloaded configuration and its ETag in memory.

Every configuration save uses `If-Match` with that ETag. A successful save replaces the in-memory configuration and ETag. An ETag conflict does not merge or overwrite fields: the application reloads the remote file, reports that the configuration changed elsewhere, and requires the user to repeat the edit.

No durable local configuration copy, root metadata, folder name, Calendar field, or onboarding-complete flag is written. A strict local file contains only `{version: 1, configFileId}`. It is an identity pointer, not configuration authority: the app must download and validate the pointed Drive YAML on every startup. Calendar databases, logs, prompt preferences, temporary PDFs, and other disposable operational files may remain local.

## Invoice Number Allocation

Finalizing a new invoice uses this sequence:

1. Refresh `lotus-invoices-config.yaml` and its ETag.
2. Confirm no finalized Drive invoice already exists for the studio and month.
3. Read the current value for the invoice year and allocate the next number.
4. Save the incremented `invoiceSequenceByYear` using `If-Match`.
5. Render and upload the finalized PDF with the allocated number.

An ETag conflict before step 4 reloads the configuration and retries allocation from the new sequence. Re-finalizing an existing invoice keeps its existing number and does not change the sequence.

If rendering, upload, verification, or the process fails after step 4, the number remains allocated and may be skipped. Skipped numbers are explicitly acceptable. There is no reservation, recovery lease, or rollback of the counter.

## Drive Root Changes

Changing the invoice root moves the same `lotus-invoices-config.yaml` Drive file to the confirmed new root using its current ETag. It does not create a second configuration file or store a folder pointer inside YAML.

After the move, the application reloads the same file ID, verifies that it has exactly one parent, finds that parent's `Final` child, and then treats the new parent as authoritative. The local file-ID pointer does not change.

## Startup

1. Load Google authorization and the config file-ID pointer locally.
2. Obtain Drive authorization when required.
3. If the pointer is valid, fetch that exact file ID; do not run account-wide config discovery.
4. If the pointer is absent, invalid, or definitively dead, discover candidates and require confirmation before installing a replacement pointer.
5. Download and validate the YAML, derive the invoice root from its sole parent, and find `Final` by name before exposing normal application screens.

A fresh desktop or Android installation therefore receives the same teacher, Calendar, studio, rate, email, color, and invoice-sequence configuration after Google authorization. It does not need a local `config.yaml`.

The application does not support offline configuration edits. If Drive is unavailable on cold startup, it shows a retryable blocking error rather than using stale durable configuration.

## One-Time Migration

Old desktop and Android versions must be closed and upgraded before migration. An old version must not run after conversion because it cannot read the unified YAML file.

For each legacy configuration:

1. Back up the local `config.yaml` and the Drive `.lotus-teaching-invoices.json`.
2. Confirm the JSON control file is inside the intended invoice root and has exactly one `Final` child beside it.
3. Read `sequenceByYear` from the JSON control file.
4. Validate the local YAML configuration without changing its existing teacher, Calendar, or studio fields.
5. Add `invoiceSequenceByYear` using the JSON `sequenceByYear` values.
6. Update the same Drive file ID with the YAML bytes, rename it to `lotus-invoices-config.yaml`, set MIME type `application/yaml`, preserve its parent, and retain `lotusConfigSchema=1`.
7. Use the legacy JSON file's ETag as `If-Match` so migration cannot overwrite a concurrent change.
8. Download the converted file again, verify its file ID, parent, metadata, ETag, YAML syntax, complete configuration, and invoice sequences.
9. Start the upgraded application and verify the expected Calendar, studios, rates, selected invoice root, existing invoices, and next invoice number.
10. Only after verification, remove the local application `config.yaml`. Keep the backups until the migration has been exercised successfully.

The migration changes the existing Drive file in place. It must not create a second remote configuration file. The same instructions are repeated for other configurations, with each local YAML matched to its own legacy JSON control file and Google account.

## Authorization Record Rename

On desktop startup:

1. If `google-tokens.json` exists, use it.
2. Otherwise, if `gmail-tokens.json` exists, atomically rename it to `google-tokens.json` without parsing or rewriting its contents.
3. Rename the associated lock file to `.google-tokens.lock`.
4. If both token files exist, stop with an explicit conflict instead of choosing one.

Android continues using the platform Google authorization mechanism; it does not require the desktop token file.

## Rollback

Rollback is manual and only supported before any invoice number or configuration change is made with the upgraded application:

1. Close all Lotus applications.
2. Restore the backed-up `.lotus-teaching-invoices.json` to the same Drive file ID, filename, MIME type, parent, metadata, and contents.
3. Restore the backed-up local `config.yaml`.
4. Rename `google-tokens.json` and `.google-tokens.lock` back to their legacy names if returning to an old desktop build.
5. Reopen the old application and verify its selected root and invoice sequence before finalizing anything.

After the upgraded application changes configuration or allocates an invoice number, forward repair is required; restoring an older snapshot could reuse a number or discard configuration changes.

## Error Handling

- Missing unified file with no legacy inputs: show setup rather than creating behavior-defining defaults silently.
- Multiple matching unified files during recovery: present every valid candidate for explicit selection; they do not affect a device whose valid pointer resolves.
- Retryable Drive failure: preserve the pointer and show Retry; do not classify it as dead or overwrite it.
- Invalid YAML or invalid configuration: block without replacing the remote file.
- Missing, duplicate, or unusable `Final` folder: block invoice actions until corrected.
- ETag conflict: reload and require retry; never merge automatically.
- Counter save succeeds but PDF upload fails: report the failed upload and retain the skipped number.
- Migration verification fails: keep the local configuration and backups; do not delete anything.
- Both old and new token files exist: block authorization storage until the conflict is resolved explicitly.

## Testing

Unit and integration coverage must prove:

- Existing YAML fields round-trip unchanged with `invoiceSequenceByYear` appended.
- Obsolete local and control fields are rejected or removed during migration.
- File discovery uses the exact name and metadata marker across My Drive and shared drives.
- The invoice root is derived from the configuration file's sole parent.
- Configuration saves and sequence increments use the latest ETag.
- Two devices allocating concurrently cannot receive the same invoice number.
- A post-allocation upload failure leaves a deliberate sequence gap and requires no recovery state.
- Re-finalization preserves the existing number.
- Valid-pointer startup performs exact file lookup without global config discovery.
- Missing/dead-pointer recovery requires confirmation and safely handles multiple candidates.
- Root changes move the same file ID and keep the local pointer unchanged.
- Migration preserves configuration and sequences, refuses stale ETags, verifies before local deletion, and never creates a second remote file.
- Desktop token rename preserves bytes and rejects dual-file conflicts.
- A fresh desktop and Android installation load identical cloud configuration.
- Existing Calendar editing, invoice freshness, PDF preview/open, Gmail draft, and income behavior continue using the unified configuration.

The final integrated gate includes the existing unit tests, both TypeScript projects, focused Rust tests, Drive verification gate, and desktop/Android E2E coverage for migration and fresh-device bootstrap.

## Documentation Deliverables

Implementation must update user-facing migration documentation with:

- prerequisites and the requirement to upgrade every client first;
- exact backup locations and Drive file identity checks;
- the before/after JSON and YAML field mapping;
- verification steps before removing local files;
- repeat instructions for additional configurations;
- rollback limits and the point after which rollback is unsafe.
