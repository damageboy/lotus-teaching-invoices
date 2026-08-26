# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Follow the User's Scope

Do exactly what the user asks and do not invent, infer, or perform additional work. Do not modify, format, restore, clean up, or otherwise touch files outside the requested operation. If additional work appears necessary, explain it and obtain the user's explicit approval before proceeding.

## Commands

```bash
# Run the Tauri desktop app (dev mode)
bun run dev

# Run just the Vite frontend (no Tauri window, for fast UI iteration)
bun run dev:vite

# Run the CLI (original Node.js tool)
bun run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run

# Build the desktop app
bun run build

# Run all tests
bun test

# Run a single test file
bunx vitest run tests/invoice/calculator.test.ts
```

## CLI Usage

```bash
lotus-invoices [options]
  -c, --config <path>      Config file (default: ./config.yaml)
  -o, --output <dir>       Output directory (default: ./invoices)
  --from <YYYY-MM-DD>      Start date (default: first day of last month)
  --to <YYYY-MM-DD>        End date (default: last day of last month)
  -s, --studio <name>      Filter to one studio
  -f, --file <path>        Use local .ics file instead of fetching calendar URL
  --dry-run                Print JSON to stdout instead of writing files
```

## Architecture

The tool reads a Google Calendar ICS feed and generates per-studio JSON invoices. The data flow is linear:

```
config.yaml + CLI args
      ↓
calendar/fetcher.ts  →  raw ICS string
      ↓
calendar/parser.ts   →  CalendarEvent[] → ParsedClass[]
      ↓
invoice/grouper.ts   →  Map<studioName, ParsedClass[]>
      ↓
invoice/generator.ts →  Invoice (via calculator.ts for rate lookup)
      ↓
output/writer.ts     →  JSON file per studio
```

**Calendar event format:** Event summaries must follow `"Studio Name / Class Type"`. The event description must contain a standalone integer for student count. Events not matching a studio in `config.yaml` emit warnings and are skipped.

**Rate tiers:** Each studio in the config has `rateTiers` — ordered ranges mapping student counts to flat per-class rates. `calculator.ts:findRate` iterates tiers and returns the first match. Classes with 0 students are skipped with a warning.

**Output:** Each invoice is a JSON file named `{studio-slug}_{from}_to_{to}.json` written to the output directory.

## Configuration

Copy `config.example.yaml` to `config.yaml`. The `calendarUrl` must be a public Google Calendar ICS URL. Studio keys in `studios` must exactly match the studio name prefix in calendar event summaries.

## Tests

Tests live in `tests/` mirroring `src/` structure. Fixtures are in `tests/fixtures/` (a sample `.ics` and a `config.yaml`). Tests use Vitest with globals enabled — no imports needed for `describe`/`it`/`expect`.

### Testing layers — use them all

| Layer       | Command                                         | What it covers                                                               |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Unit tests  | `bun test`                                      | Pure logic: calculator, parser, grouper, config schema, finalization helpers |
| TypeScript  | `bunx tsc --project tsconfig.app.json --noEmit` | Frontend type correctness                                                    |
| Slice gate  | `bun run verify:calendar-editing`               | Fast calendar editing UI, format, hook, TypeScript, and focused Rust checks  |
| E2E (Tauri) | `bun run e2e`                                   | Full app: real file system, HTTP, Tauri commands, dialog, PDF                |
| Vite smoke  | `bun run dev:vite` + browser tools              | Quick visual iteration only — Tauri APIs not available                       |

For an isolated UI change, run `bun run e2e` before completion. For a planned sequence of small calendar-editing slices, run `bun run verify:calendar-editing` after each slice and run `bun run e2e` once at the final integrated checkpoint. Do not pay for the two cold isolated Rust builds after every intermediate slice. The Vite-only smoke test cannot verify file writes, folder creation, the dialog plugin, PDF generation, or config persistence.

```bash
# Run the fast calendar-editing slice gate
bun run verify:calendar-editing

# Run the full isolated E2E suite at the integrated checkpoint
bun run e2e
```

E2E test file: `tests/e2e/smoke.e2e.ts` — 15 tests covering Boot, Calendar nav, Invoices empty state, Rates dirty+save+YAML verify+version badge, Log panel toggle.
