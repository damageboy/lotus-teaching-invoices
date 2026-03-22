# Google Calendar API Migration — Design

## Problem

The ICS feed does not expand recurring events (RRULE). Our parser only sees the base VEVENT, so recurring classes appear once (on their first date) and all future occurrences are invisible. Edited occurrences with renamed summaries also persist as stale data in the ICS cache.

## Solution

Replace the ICS feed with Google Calendar API v3, which returns pre-expanded recurring events as individual occurrences.

## Auth & Permissions

- Reuse existing OAuth infrastructure (`getAccessToken()`, Rust loopback server, `gmail-tokens.json`)
- `calendar.events` scope already requested — no re-auth needed for existing users
- Add `https://www.googleapis.com/**` to Tauri HTTP capabilities

## New module: `src/lib/calendar/calendar-api.ts`

- `listCalendars()` — `GET /users/me/calendarList`, returns `{ id, summary }[]`
- `fetchEvents(calendarId, timeMin, timeMax)` — `GET /calendars/{calendarId}/events` with `singleEvents=true` and pagination via `nextPageToken`, returns `CalendarEvent[]`
- Maps API fields (`summary`, `description`, `start.dateTime`, `end.dateTime`) to existing `CalendarEvent` type

## Config changes

- Replace `calendarUrl: string` with `calendarId?: string` and `calendarName?: string` in `AppConfig`
- Remove `calendarUrl` from config schema, defaults, CLI args
- CLI uses `getAccessToken()` same as the app (requires prior OAuth from the app)

## Hook: `useCalendarData.ts`

- Replace ICS fetch+parse with `fetchEvents(config.calendarId, ...)` call
- Remove `parseCalendarEvents()` — API response maps directly to `CalendarEvent[]`
- `extractClasses()` still works as-is (takes `CalendarEvent[]`)
- Time range: fetch 6 months back, 3 months forward

## UI: RatesTab — "Pick Calendar..." button

- Shows when `calendarId` is not set (or as "Change..." when set)
- Calls `getAccessToken()` → `listCalendars()` → picker dialog/dropdown
- On selection, saves `calendarId` and `calendarName` to config
- Displays selected calendar name

## Removed

- `src/lib/calendar/fetcher.ts`
- `ical.js` dependency
- `parseCalendarEvents()` in parser.ts
- `calendarUrl` from all config types, schema, defaults, CLI args

## Unchanged

- `extractClasses()` — still takes `CalendarEvent[]`
- All invoice logic (grouper, generator, calculator, finalization)
- PDF generation, Gmail draft integration
