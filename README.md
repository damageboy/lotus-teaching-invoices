# Lotus Teaching Invoices

[![Build macOS](https://github.com/damageboy/lotus-teaching-invoices/actions/workflows/build-macos.yml/badge.svg)](https://github.com/damageboy/lotus-teaching-invoices/actions/workflows/build-macos.yml)
[![Latest Release](https://img.shields.io/github/v/release/damageboy/lotus-teaching-invoices?label=latest)](https://github.com/damageboy/lotus-teaching-invoices/releases/latest)

A yoga teaching invoice generator that reads your Google Calendar and produces per-studio PDF invoices. Available as a macOS desktop app (Tauri) and a Node.js CLI.

## Download

Grab the latest `.dmg` from the [Releases](https://github.com/damageboy/lotus-teaching-invoices/releases/latest) page.

## Setup

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

## How It Works

Calendar events must follow the format `"Studio Name / Class Type"`. The event description must contain a standalone integer for the student count. Each studio in `config.yaml` has `rateTiers` that map student counts to flat per-class rates.

```
config.yaml + calendar ICS
      ↓
parse events → group by studio → calculate rates → generate invoices → write PDF
```
