# Cloud Configuration Migration

Use these steps separately for every Lotus configuration/account. Do not run an old desktop or Android build after converting its Drive file.

## Before upgrading

1. Close Lotus on every device.
2. In Google Drive, confirm `.lotus-teaching-invoices.json` is directly inside the intended invoice root and that the root has exactly one direct `Final` folder.
3. Download a backup of `.lotus-teaching-invoices.json` without changing its name or contents.
4. Back up the matching local `config.yaml`.
5. Record the Google account and invoice-root folder name beside both backups. This prevents mixing configurations when migrating more than one account/profile.

## Migrate

1. Install and open the upgraded desktop application while signed into the matching Google account.
2. Lotus reads the local `config.yaml`, reads `sequenceByYear` from the Drive JSON file, and conditionally updates that same Drive file ID.
3. Wait for normal Calendar, Rates, and Invoices screens to load. Do not open Lotus on another device during this step.

The converted file must be named `lotus-invoices-config.yaml`, remain directly inside the same invoice root, retain `lotusConfigSchema=1`, and contain `invoiceSequenceByYear`. Its file ID does not change. The local `config.yaml` is removed only after the converted Drive file has been downloaded and verified.

## Verify

For each migrated configuration, verify:

- the Google account is correct;
- the selected Calendar is correct;
- every studio, address, rate tier, email, and color is present;
- the selected invoice root and its `Final` folder are correct;
- existing finalized invoices appear;
- `invoiceSequenceByYear` matches the backed-up JSON `sequenceByYear`;
- the next finalized invoice uses the expected next number.

Keep the two backups until this verification and one real finalize/refresh cycle succeed on each intended device.

## Additional configurations

Repeat the entire process from “Before upgrading” for the next local YAML/Google-account pair. Never reuse one profile's local YAML with another profile's Drive JSON file.

## Roll back

Rollback is manual and should happen only while all Lotus clients are closed:

1. Download the current `lotus-invoices-config.yaml` as an additional safety backup.
2. Restore the backed-up `.lotus-teaching-invoices.json` bytes to the same Drive file ID, name, MIME type `application/json`, parent, and `lotusConfigSchema=1` property.
3. Restore the matching backed-up local file as `config.yaml` in the previous desktop application's configured location.
4. Reopen only the old application and verify the root and invoice sequence before finalizing anything.

Do not keep both `.lotus-teaching-invoices.json` and `lotus-invoices-config.yaml` active. The upgraded application deliberately blocks when both authorities exist.

## Local files after migration

The desktop authorization record is `google-tokens.json`. An existing `gmail-tokens.json` is renamed byte-for-byte at startup; if both names exist, startup blocks instead of choosing one. Calendar databases, logs, temporary PDFs, and other disposable caches may remain local.
