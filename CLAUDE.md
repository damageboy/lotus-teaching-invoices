# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the Tauri desktop app (dev mode)
npm run dev

# Run just the Vite frontend (no Tauri window, for fast UI iteration)
npm run dev:vite

# Run the CLI (original Node.js tool)
npm run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run

# Build the desktop app
npm run build

# Run all tests
npm test

# Run a single test file
npx vitest run tests/invoice/calculator.test.ts
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
