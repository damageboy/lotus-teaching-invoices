# Tauri Desktop App Design

**Date:** 2026-03-01
**Status:** Approved

## Context

The existing project is a Node.js CLI that reads a Google Calendar ICS feed and generates per-studio JSON invoices. This design converts it into a local-first Tauri desktop app — chosen specifically to avoid hosting, auth, and user management while still getting a proper GUI.

## Architecture

**Tauri is a thin native shell.** All business logic runs in the Vite/React webview. Tauri contributes only native OS capabilities:

| Plugin | Purpose |
|---|---|
| `@tauri-apps/plugin-http` | Fetch the ICS URL from Rust (bypasses browser CORS) |
| `@tauri-apps/plugin-fs` | Read/write `config.yaml` and PDF files |
| `@tauri-apps/plugin-dialog` | Native folder picker for PDF output directory |
| `@tauri-apps/plugin-shell` | `open()` to launch the system PDF viewer |

The Rust side stays minimal. Future DB integration (SQLite etc.) would slot into the Rust layer without touching frontend logic.

## Directory Structure

```
src-tauri/               ← Tauri 2.x Rust shell (plugin config only)
src/
  lib/                   ← existing business logic, adapted for browser
    parser.ts            ← swap node-ical → ical.js (browser-compatible)
    calculator.ts        ← unchanged
    generator.ts         ← unchanged
    grouper.ts           ← unchanged
    types.ts             ← unchanged
  components/
    CalendarTab/
    InvoicesTab/
    RatesTab/
  hooks/
    useCalendarData.ts   ← fetches + caches ICS on launch
    useConfig.ts         ← reads/writes config.yaml via Tauri fs
  App.tsx                ← three-tab shell
```

## Config

`config.yaml` lives in Tauri's app data directory (`~/Library/Application Support` on macOS). Two new fields are added:

```yaml
teacherName: "Jane Doe"
outputDir: "/Users/jane/Documents/Invoices"
calendarUrl: "https://..."
studios:
  "Yogibar":
    rateTiers: ...
```

The `AppConfig` TypeScript type is extended accordingly and shared between the lib layer and the UI.

## Tab 1: Calendar View

A read-only monthly calendar grid (7 columns, Mon–Sun).

- Each studio gets a distinct color derived deterministically from its name — no manual color assignment
- Events render as colored chips on their day cell showing class type and time
- Hovering/clicking a chip shows a popover with student count and studio name
- Month switcher: prev/next arrows with a "Month YYYY" label; switching months is instant (all data is already in memory)
- A **Refresh** button in the toolbar triggers a re-fetch of the ICS feed

**Data flow:** On app launch, `useCalendarData` fetches the ICS once via the Tauri HTTP plugin and parses it into `ParsedClass[]`. The calendar filters this array client-side by selected month.

## Tab 2: Invoices Table

A table with one row per studio × month combination that has classes, sorted by date descending then studio name.

**Columns:** Studio | Month | Classes | Total | Generate Invoice...

**Output folder setting** (top of tab): a read-only path display + **"Change folder..."** button that opens a native folder picker. The chosen path is saved to `outputDir` in `config.yaml`. Defaults to `~/Documents/Invoices` on first launch.

**"Generate Invoice..." button:**
1. Runs `generateInvoice()` against current in-memory ICS data and config rates
2. Renders a PDF using `@react-pdf/renderer` (React components → PDF)
3. Writes `{StudioName}-{YYYY}-{MM}.pdf` to the configured output folder via Tauri fs
4. Opens the file with `shell.open()` (system PDF viewer)

**PDF contents:** teacher name, studio name, invoice period, line-item table (date, time, class type, students, rate, total), grand total.

## Tab 3: Rate Editor

A form editor for `config.yaml`.

**Global settings block (top):**
- Teacher name — text input
- Calendar URL — text input

**Per-studio cards (one per studio):**
- Studio name — editable (renaming updates the config key)
- Rate tiers — inline editable table (min students, max students, rate); rows can be added/removed; `maxStudents` is blank for open-ended
- Delete studio button (with confirmation)

**"+ Add studio"** button at the bottom adds a new card with one empty tier.

**Save behaviour:** A single explicit **Save** button writes the entire config back to `config.yaml`. An "Unsaved changes" badge appears when the in-memory state diverges from the saved file. No auto-save.

## Key Dependencies

| Package | Purpose |
|---|---|
| `tauri` 2.x | Desktop shell |
| `react` + `typescript` + `vite` | Frontend framework |
| `ical.js` | Browser-compatible ICS parser (replaces `node-ical`) |
| `yaml` | Config read/write (already in project) |
| `@react-pdf/renderer` | PDF generation from React components |

## What Is Explicitly Out of Scope

- Drag-to-reschedule or event creation in the calendar
- Week/day calendar views
- Rate tier gap/overlap validation
- Undo history in the rate editor
- Any hosting, auth, or multi-user support
