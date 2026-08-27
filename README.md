# Lotus Teaching Invoices

[![Build macOS](https://github.com/damageboy/lotus-teaching-invoices/actions/workflows/build-macos.yml/badge.svg)](https://github.com/damageboy/lotus-teaching-invoices/actions/workflows/build-macos.yml)
[![Latest Release](https://img.shields.io/github/v/release/damageboy/lotus-teaching-invoices?label=latest)](https://github.com/damageboy/lotus-teaching-invoices/releases/latest)

A yoga teaching invoice generator that reads your Google Calendar and produces per-studio PDF invoices. Available as a macOS desktop app (Tauri) and a Node.js CLI.

## Download

Grab the latest `.dmg` from the [Releases](https://github.com/damageboy/lotus-teaching-invoices/releases/latest) page.

## CLI setup

1. Copy `config.example.yaml` to `config.yaml`
2. Set `calendarUrl` to your public Google Calendar ICS URL
3. Add studios with their rate tiers — studio names must exactly match the prefix in calendar event summaries (`"Studio Name / Class Type"`)

## CLI Usage

```bash
bun run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run
```

```
lotus-invoices [options]
  -c, --config <path>      Config file (default: ./config.yaml)
  -o, --output <dir>       Output directory (default: ./invoices)
  --from <YYYY-MM-DD>      Start date (default: first day of last month)
  --to <YYYY-MM-DD>        End date (default: last day of last month)
  -s, --studio <name>      Filter to one studio
  -f, --file <path>        Use local .ics file instead of fetching calendar URL
  --dry-run                Print JSON to stdout instead of writing files
```

## Development

```bash
bun install

# Desktop app (Tauri)
bun run dev

# Frontend only (fast iteration, no Tauri APIs)
bun run dev:vite

# Unit tests
bun test

# TypeScript check
bunx tsc --project tsconfig.app.json --noEmit

# Full E2E suite (required after any UI change)
bun run e2e
```

### Android APK variants

The Android convenience commands build an **aarch64 (`arm64-v8a`) APK**, install it with `adb`, and launch the app. Install the Android SDK command-line tools first and enable USB debugging when using a physical device.

| Variant | Physical device over USB         | Android emulator                   |
| ------- | -------------------------------- | ---------------------------------- |
| Debug   | `bun run android:debug:device`   | `bun run android:debug:emulator`   |
| Release | `bun run android:release:device` | `bun run android:release:emulator` |

When exactly one suitable target is available, the script selects it automatically. If multiple devices are connected, pass the desired `adb` serial after `--`:

```bash
adb devices -l
bun run android:debug:device -- --device <adb-serial>
bun run android:release:device -- --device <adb-serial>
```

The emulator commands use an already-running emulator when exactly one is available. Otherwise, they start the only configured Android Virtual Device (AVD). Select a specific AVD when more than one is configured:

```bash
emulator -list-avds
bun run android:debug:emulator -- --avd <avd-name>
bun run android:release:emulator -- --avd <avd-name>
```

If Gradle produces an unsigned release APK, the convenience script signs a local-install copy with the standard Android debug keystore at `~/.android/debug.keystore`. This local signature is not suitable for distribution; configure production release signing separately. Generated APKs are written below `src-tauri/gen/android/app/build/outputs/apk/`.

Run `bash scripts/android-apk.sh --help` for the complete launcher options.

## Finalized Invoices and Google Drive

Google Drive is the only authority for finalized invoice PDFs in the desktop and Android apps. Choose or create one Drive root in the app; Lotus manages exactly one direct child named `Final` and identifies files by Drive ID. A refresh on another device signed into the same Google account loads the same selected root and finalized invoices.

Before activating a Drive root, manually copy any existing finalized PDFs into its `Final` folder, refresh the staged scan, resolve duplicate or malformed entries, and then confirm activation. Lotus does not automatically upload, move, or delete old local invoice files. After activation, those local files remain untouched but are ignored.

Lotus stores all behavior-defining desktop/Android configuration in an ordinary, visible file named `lotus-invoices-config.yaml` directly inside the selected invoice root. Its parent is the root; no separate root pointer exists. The file contains the teacher, Calendar, studios, rates, email/color settings, and `invoiceSequenceByYear`, and uses the Drive property `lotusConfigSchema=1`.

Configuration and invoice-number writes use the file's ETag. Conflicts are reloaded and shown instead of merged. A new invoice number is saved before PDF rendering/upload; a later failure deliberately leaves a gap. There is no reservation or recovery file.

The desktop keeps only Google authorization in `google-tokens.json` as durable local authority. Calendar databases, logs, temporary PDFs, and other disposable caches may remain local. The standalone CLI still accepts an explicit local `config.yaml` and is separate from desktop/Android cloud authority.

Finalized list, finalize, re-finalize, open, and draft-email actions are online-only and read verified Drive state or bytes. There is no persistent local finalized-PDF cache or offline fallback. `Preview` still renders locally, and disposable temporary copies may be created only to open or attach a verified Drive PDF.

Google Cloud client registration, migration, and release validation are documented in [Google OAuth Setup](docs/google-oauth-setup.md), [Cloud Configuration Migration](docs/release/cloud-config-migration.md), and the [Drive release checklist](docs/release/google-drive-invoice-storage-checklist.md).

## How It Works

Calendar events must follow the format `"Studio Name / Class Type"`. The event description must contain a standalone integer for the student count. Each studio in the active configuration has `rateTiers` that map student counts to flat per-class rates.

```
configuration + Google Calendar
      ↓
parse events → group by studio → calculate rates → generate invoices → write PDF
```
