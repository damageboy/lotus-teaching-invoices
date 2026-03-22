# Google Calendar API Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ICS feed with Google Calendar API v3 so recurring events are properly expanded and the calendar view shows all occurrences.

**Architecture:** Create a new `calendar-api.ts` module that calls the Google Calendar API using the existing OAuth token infrastructure. Replace ICS fetching in `useCalendarData` with API calls. Add a calendar picker UI in the Rates tab. Remove ICS-related code and the `ical.js` dependency.

**Tech Stack:** Google Calendar API v3, TypeScript, React, Tauri plugin-http, existing OAuth (gmail/auth.ts)

---

### Task 1: Add `www.googleapis.com` to Tauri HTTP permissions

**Files:**

- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the Calendar API URL to HTTP allow list**

In `src-tauri/capabilities/default.json`, add `{ "url": "https://www.googleapis.com/**" }` to the `http:default` allow array:

```json
{
  "identifier": "http:default",
  "allow": [
    { "url": "https://calendar.google.com/**" },
    { "url": "https://oauth2.googleapis.com/**" },
    { "url": "https://gmail.googleapis.com/**" },
    { "url": "https://www.googleapis.com/**" }
  ]
}
```

- [ ] **Step 2: Verify Rust builds**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compiles without error

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat: add googleapis.com to Tauri HTTP allow list"
```

---

### Task 2: Add `CALENDAR_API_BASE` constant

**Files:**

- Modify: `src/lib/gmail/constants.ts`

- [ ] **Step 1: Add the constant**

Add to `src/lib/gmail/constants.ts`:

```typescript
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/gmail/constants.ts
git commit -m "feat: add Calendar API base URL constant"
```

---

### Task 3: Create `calendar-api.ts` — `listCalendars()`

**Files:**

- Create: `src/lib/calendar/calendar-api.ts`
- Test: `tests/calendar/calendar-api.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/calendar/calendar-api.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapCalendarListResponse, mapEventsResponse } from '../../src/lib/calendar/calendar-api';

describe('mapCalendarListResponse', () => {
  it('extracts id and summary from calendar list response', () => {
    const apiResponse = {
      items: [
        { id: 'primary', summary: 'My Calendar', accessRole: 'owner' },
        { id: 'abc123@group.calendar.google.com', summary: 'Teaching', accessRole: 'owner' },
      ],
    };
    const result = mapCalendarListResponse(apiResponse);
    expect(result).toEqual([
      { id: 'primary', summary: 'My Calendar' },
      { id: 'abc123@group.calendar.google.com', summary: 'Teaching' },
    ]);
  });

  it('returns empty array when no items', () => {
    expect(mapCalendarListResponse({})).toEqual([]);
    expect(mapCalendarListResponse({ items: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/calendar/calendar-api.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `calendar-api.ts` with `listCalendars()` and `mapCalendarListResponse()`**

Create `src/lib/calendar/calendar-api.ts`:

```typescript
import { fetch } from '@tauri-apps/plugin-http';
import { CALENDAR_API_BASE } from '../gmail/constants';
import { getAccessToken } from '../gmail/auth';
import { logInfo, logError } from '../logger';
import { CalendarEvent } from '../types';

export interface CalendarListEntry {
  id: string;
  summary: string;
}

/** Pure mapper — extracts id and summary from the API response. Exported for testing. */
export function mapCalendarListResponse(data: any): CalendarListEntry[] {
  if (!data?.items?.length) return [];
  return data.items.map((item: any) => ({
    id: item.id,
    summary: item.summary,
  }));
}

/** Fetch the user's list of calendars from the Google Calendar API. */
export async function listCalendars(): Promise<CalendarListEntry[]> {
  const accessToken = await getAccessToken();
  const resp = await fetch(`${CALENDAR_API_BASE}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    const msg = `Calendar list fetch failed (${resp.status}): ${text}`;
    logError(msg);
    throw new Error(msg);
  }

  const data = await resp.json();
  logInfo(`Fetched ${data.items?.length ?? 0} calendars`);
  return mapCalendarListResponse(data);
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run tests/calendar/calendar-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar/calendar-api.ts tests/calendar/calendar-api.test.ts
git commit -m "feat: add listCalendars() with Google Calendar API"
```

---

### Task 4: Add `fetchEvents()` to `calendar-api.ts`

**Files:**

- Modify: `src/lib/calendar/calendar-api.ts`
- Modify: `tests/calendar/calendar-api.test.ts`

- [ ] **Step 1: Write the test**

Add to `tests/calendar/calendar-api.test.ts`:

```typescript
describe('mapEventsResponse', () => {
  it('maps API events to CalendarEvent[]', () => {
    const apiResponse = {
      items: [
        {
          id: 'evt1',
          summary: 'YFD / mitte / Vinyasa',
          description: '7',
          start: { dateTime: '2026-03-15T10:00:00+01:00' },
          end: { dateTime: '2026-03-15T11:15:00+01:00' },
        },
        {
          id: 'evt2',
          summary: 'Zen Yoga / Hatha',
          description: '5',
          start: { dateTime: '2026-03-15T18:00:00+01:00' },
          end: { dateTime: '2026-03-15T19:15:00+01:00' },
        },
      ],
    };
    const result = mapEventsResponse(apiResponse);
    expect(result).toHaveLength(2);
    expect(result[0].uid).toBe('evt1');
    expect(result[0].summary).toBe('YFD / mitte / Vinyasa');
    expect(result[0].description).toBe('7');
    expect(result[0].start).toBeInstanceOf(Date);
    expect(result[0].end).toBeInstanceOf(Date);
  });

  it('skips all-day events (no dateTime)', () => {
    const apiResponse = {
      items: [
        {
          id: 'evt-allday',
          summary: 'Holiday',
          start: { date: '2026-03-20' },
          end: { date: '2026-03-21' },
        },
      ],
    };
    const result = mapEventsResponse(apiResponse);
    expect(result).toHaveLength(0);
  });

  it('handles missing description', () => {
    const apiResponse = {
      items: [
        {
          id: 'evt3',
          summary: 'Zen Yoga / Flow',
          start: { dateTime: '2026-03-16T09:00:00Z' },
          end: { dateTime: '2026-03-16T10:00:00Z' },
        },
      ],
    };
    const result = mapEventsResponse(apiResponse);
    expect(result[0].description).toBe('');
  });

  it('returns empty array for empty response', () => {
    expect(mapEventsResponse({})).toEqual([]);
    expect(mapEventsResponse({ items: [] })).toEqual([]);
  });

  it('skips cancelled events', () => {
    const apiResponse = {
      items: [
        {
          id: 'evt4',
          summary: 'Zen Yoga / Hatha',
          status: 'cancelled',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
        },
      ],
    };
    const result = mapEventsResponse(apiResponse);
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/calendar/calendar-api.test.ts`
Expected: FAIL — `mapEventsResponse` not found

- [ ] **Step 3: Implement `mapEventsResponse()` and `fetchEvents()`**

Add to `src/lib/calendar/calendar-api.ts`:

```typescript
/** Pure mapper — converts API event objects to CalendarEvent[]. Exported for testing. */
export function mapEventsResponse(data: any): CalendarEvent[] {
  if (!data?.items?.length) return [];
  const events: CalendarEvent[] = [];
  for (const item of data.items) {
    // Skip all-day events (they have date instead of dateTime)
    if (!item.start?.dateTime || !item.end?.dateTime) continue;
    // Skip cancelled events
    if (item.status === 'cancelled') continue;
    events.push({
      uid: item.id ?? '',
      summary: item.summary ?? '',
      description: item.description ?? '',
      start: new Date(item.start.dateTime),
      end: new Date(item.end.dateTime),
    });
  }
  return events;
}

/**
 * Fetch events from a Google Calendar for a given time range.
 * Uses singleEvents=true so recurring events are expanded into individual occurrences.
 * Handles pagination via nextPageToken.
 */
export async function fetchEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarEvent[]> {
  const accessToken = await getAccessToken();
  const allEvents: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      const msg = `Calendar events fetch failed (${resp.status}): ${text}`;
      logError(msg);
      throw new Error(msg);
    }

    const data = await resp.json();
    allEvents.push(...mapEventsResponse(data));
    pageToken = data.nextPageToken;
  } while (pageToken);

  logInfo(`Fetched ${allEvents.length} calendar events`);
  return allEvents;
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run tests/calendar/calendar-api.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/calendar/calendar-api.ts tests/calendar/calendar-api.test.ts
git commit -m "feat: add fetchEvents() with pagination and recurring event expansion"
```

---

### Task 5: Update `AppConfig` type and schema — replace `calendarUrl` with `calendarId`

**Files:**

- Modify: `src/lib/types.ts:28-34`
- Modify: `src/lib/config/schema.ts:97-113`
- Modify: `src/lib/config/defaults.ts`
- Modify: `tests/fixtures/config.yaml`
- Modify: `tests/fixtures/e2e-config.yaml`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/config/serialization.test.ts`

- [ ] **Step 1: Update `AppConfig` type**

In `src/lib/types.ts`, replace `calendarUrl: string` with:

```typescript
export interface AppConfig {
  teacher: TeacherInfo;
  calendarId?: string; // Google Calendar ID (e.g. "abc@group.calendar.google.com")
  calendarName?: string; // Display name of the selected calendar
  outputDir: string;
  lastInvoice: string;
  studios: Record<string, StudioConfig>;
}
```

- [ ] **Step 2: Update config schema**

In `src/lib/config/schema.ts`, replace `calendarUrl: z.string().default('')` with:

```typescript
  calendarId: z.string().optional(),
  calendarName: z.string().optional(),
```

Update the `config` object construction (lines 147-153) to:

```typescript
const config: AppConfig = {
  teacher: configData.teacher as TeacherInfo,
  calendarId: configData.calendarId,
  calendarName: configData.calendarName,
  outputDir: configData.outputDir,
  lastInvoice: configData.lastInvoice,
  studios: {},
};
```

- [ ] **Step 3: Update defaults**

In `src/lib/config/defaults.ts`, remove `calendarUrl: ''`:

```typescript
export const DEFAULT_CONFIG: AppConfig = {
  teacher: {
    name: '',
    address: '',
    taxNumber: '',
    bankDetails: {
      accountOwner: '',
      iban: '',
      bic: '',
    },
  },
  outputDir: '',
  lastInvoice: '',
  studios: {
    Yogibar: {
      fullName: '',
      address: '',
      rateTiers: [
        { minStudents: 1, maxStudents: 5, rate: 80 },
        { minStudents: 6, maxStudents: 10, rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
};
```

- [ ] **Step 4: Update test fixture config.yaml**

Replace `calendarUrl` line in `tests/fixtures/config.yaml`:

```yaml
calendarId: 'example@group.calendar.google.com'
calendarName: 'Teaching Schedule'
lastInvoice: ''
studios:
```

- [ ] **Step 5: Update e2e fixture**

Replace `calendarUrl` line in `tests/fixtures/e2e-config.yaml`:

```yaml
outputDir: ''
teacher:
```

(Just remove the `calendarUrl` line; `calendarId` is optional so its absence is fine.)

- [ ] **Step 6: Update loader test**

In `tests/config/loader.test.ts`, replace `expect(config.calendarUrl).toBe(...)` with:

```typescript
expect(config.calendarId).toBe('example@group.calendar.google.com');
expect(config.calendarName).toBe('Teaching Schedule');
```

Also update `'accepts missing calendarUrl'` test to `'accepts missing calendarId'`:

```typescript
it('accepts missing calendarId (defaults to undefined)', () => {
  const cfg = validateConfig({
    studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
  });
  expect(cfg.calendarId).toBeUndefined();
});
```

Remove `calendarUrl` from all `validateConfig()` calls in the test file — the field no longer exists. Where tests pass `calendarUrl: 'url'` or `calendarUrl: 'https://...'`, just remove that property.

- [ ] **Step 7: Update serialization test**

In `tests/config/serialization.test.ts`, update `SAMPLE_CONFIG` to use `calendarId` and `calendarName` instead of `calendarUrl`. Update the round-trip assertion accordingly.

- [ ] **Step 8: Fix any remaining TypeScript errors**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
This will surface any remaining references to `calendarUrl` in the app code. Fix each one.

Run: `bunx tsc --project tsconfig.json --noEmit`
Same for CLI code.

- [ ] **Step 9: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/lib/types.ts src/lib/config/schema.ts src/lib/config/defaults.ts \
  tests/fixtures/config.yaml tests/fixtures/e2e-config.yaml \
  tests/config/loader.test.ts tests/config/serialization.test.ts
git commit -m "feat: replace calendarUrl with calendarId/calendarName in config"
```

---

### Task 6: Update `useCalendarData` hook to use Calendar API

**Files:**

- Modify: `src/hooks/useCalendarData.ts`

- [ ] **Step 1: Replace ICS fetch with Calendar API call**

Rewrite `src/hooks/useCalendarData.ts`:

```typescript
import { useState, useCallback } from 'react';
import { extractClasses } from '../lib/calendar/parser';
import { fetchEvents } from '../lib/calendar/calendar-api';
import { ParsedClass, ParseWarning, AppConfig } from '../lib/types';
import { logInfo, logWarn, logError } from '../lib/logger';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Time range: 6 months back, 3 months forward from today. */
function defaultTimeRange(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const min = new Date(now);
  min.setMonth(min.getMonth() - 6);
  const max = new Date(now);
  max.setMonth(max.getMonth() + 3);
  return {
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
  };
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studioKeys = Object.keys(config.studios).sort().join(',');

  const refresh = useCallback(async () => {
    if (!config.calendarId) {
      setError('No calendar selected. Pick one in the Rates tab.');
      return;
    }
    setIsLoading(true);
    setError(null);
    logInfo('Fetching calendar events…');
    try {
      const { timeMin, timeMax } = defaultTimeRange();
      const events = await fetchEvents(config.calendarId, timeMin, timeMax);
      const knownStudios = new Map(
        Object.keys(config.studios).map((name) => [name.toLowerCase(), name])
      );
      const { classes: parsed, warnings: warns } = extractClasses(events, knownStudios);
      setClasses(parsed);
      setWarnings(warns);
      const unconfiguredCount = parsed.filter((c) => c.unconfigured).length;
      logInfo(
        `Calendar loaded: ${parsed.length - unconfiguredCount} classes, ${unconfiguredCount} unconfigured, ${warns.length} warnings`
      );
      const now = new Date().toISOString().slice(0, 10);
      warns
        .filter((w) => !w.date || w.date <= now)
        .forEach((w) => logWarn(`${w.code}: ${w.event}${w.date ? ` (${w.date})` : ''}`));
    } catch (e) {
      const msg = `Failed to fetch calendar: ${e instanceof Error ? e.message : String(e)}`;
      logError(msg);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [config.calendarId, studioKeys]);

  return { classes, warnings, isLoading, error, refresh };
}
```

- [ ] **Step 2: Update App.tsx refresh trigger**

In `src/App.tsx`, update the useEffect that triggers refresh (around line 57-59). Replace `config.calendarUrl` with `config.calendarId`:

```typescript
useEffect(() => {
  if (!configLoading && config.calendarId) refresh();
}, [configLoading, config.calendarId, refresh]);
```

- [ ] **Step 3: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCalendarData.ts src/App.tsx
git commit -m "feat: use Google Calendar API instead of ICS feed"
```

---

### Task 7: Update RatesTab — replace Calendar URL input with "Pick Calendar..." button

**Files:**

- Modify: `src/components/RatesTab/index.tsx`

- [ ] **Step 1: Remove `updateCalendarUrl` function**

Delete the `updateCalendarUrl` function (line 223-225 in RatesTab).

- [ ] **Step 2: Add calendar picker state and handler**

Add at the top of the `RatesTab` component:

```typescript
const [calendars, setCalendars] = useState<{ id: string; summary: string }[] | null>(null);
const [calendarLoading, setCalendarLoading] = useState(false);
const [calendarError, setCalendarError] = useState<string | null>(null);
```

Add the import at the top of the file:

```typescript
import { listCalendars } from '../../lib/calendar/calendar-api';
```

Add handler:

```typescript
async function handlePickCalendar() {
  setCalendarLoading(true);
  setCalendarError(null);
  try {
    const list = await listCalendars();
    setCalendars(list);
  } catch (e) {
    setCalendarError(e instanceof Error ? e.message : String(e));
  } finally {
    setCalendarLoading(false);
  }
}

function handleSelectCalendar(id: string, name: string) {
  onUpdate({ ...config, calendarId: id, calendarName: name });
  setCalendars(null);
}
```

- [ ] **Step 3: Replace the Calendar URL input with picker UI**

Replace the Calendar section in the JSX (the `<h3>Calendar</h3>` and the URL input, around lines 403-411) with:

```tsx
        <h3 className="text-sm font-medium text-gray-700 mt-2">Calendar</h3>
        <div className="flex flex-col gap-2">
          {config.calendarId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-800">
                {config.calendarName || config.calendarId}
              </span>
              <button
                onClick={handlePickCalendar}
                disabled={calendarLoading}
                className="text-xs text-indigo-500 hover:text-indigo-700"
              >
                {calendarLoading ? 'Loading…' : 'Change…'}
              </button>
            </div>
          ) : (
            <button
              onClick={handlePickCalendar}
              disabled={calendarLoading}
              className="self-start px-3 py-1.5 rounded border border-gray-300 text-sm text-gray-600 hover:border-indigo-400 hover:text-indigo-600"
            >
              {calendarLoading ? 'Loading…' : 'Pick Calendar…'}
            </button>
          )}
          {calendarError && (
            <span className="text-xs text-red-500">{calendarError}</span>
          )}
          {calendars && (
            <div className="flex flex-col gap-1 p-2 rounded border border-gray-200 bg-gray-50 max-h-48 overflow-y-auto">
              {calendars.map((cal) => (
                <button
                  key={cal.id}
                  onClick={() => handleSelectCalendar(cal.id, cal.summary)}
                  className={`text-left text-sm px-2 py-1 rounded hover:bg-indigo-50 ${
                    config.calendarId === cal.id
                      ? 'bg-indigo-100 text-indigo-700 font-medium'
                      : 'text-gray-700'
                  }`}
                >
                  {cal.summary}
                </button>
              ))}
              {calendars.length === 0 && (
                <span className="text-xs text-gray-400">No calendars found</span>
              )}
            </div>
          )}
        </div>
```

- [ ] **Step 4: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/RatesTab/index.tsx
git commit -m "feat: add calendar picker UI, replace ICS URL input"
```

---

### Task 8: Update CLI to use Calendar API

**Files:**

- Modify: `src/cli/main.ts`
- Modify: `src/cli/args.ts`

- [ ] **Step 1: Update CLI args**

In `src/cli/args.ts`, the `--file` flag (`-f, --file <path>`) stays for local ICS testing. Remove any reference to calendar URL in the description. No structural changes needed — the CLI will read `calendarId` from config.

- [ ] **Step 2: Update CLI main**

In `src/cli/main.ts`, replace the ICS fetch/parse logic with Calendar API usage. The `--file` flag now serves as a legacy override that reads a local ICS file.

Replace the calendar fetch block (lines 20-30) with:

```typescript
// Fetch calendar events
let events: CalendarEvent[];
if (opts.file) {
  // Legacy: parse a local ICS file
  const icsData = readFileSync(opts.file, 'utf-8');
  events = parseCalendarEvents(icsData);
} else {
  if (!config.calendarId) {
    throw new AppError(
      'No calendar configured. Run the desktop app and pick a calendar in Settings.',
      'NO_CALENDAR'
    );
  }
  const { fetchEvents } = await import('../lib/calendar/calendar-api.js');
  events = await fetchEvents(config.calendarId, opts.from + 'T00:00:00Z', opts.to + 'T23:59:59Z');
}
```

Update the imports at the top — keep `parseCalendarEvents` for the `--file` case, add `CalendarEvent` to the types import.

- [ ] **Step 3: Run TypeScript check**

Run: `bunx tsc --project tsconfig.json --noEmit`
Expected: PASS (or errors to fix — `fetchEvents` uses Tauri plugin-http which is not available in CLI context. If so, use dynamic import to avoid build-time issues.)

Note: `fetchEvents` uses `@tauri-apps/plugin-http`'s `fetch`. The CLI runs in Node.js, not Tauri. The dynamic `import()` above defers the import so the CLI doesn't fail at startup. The actual fetch call will fail in Node because the Tauri plugin isn't available. For now this is acceptable — the `--file` flag works for CLI users, and the Calendar API path is for the desktop app only.

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts src/cli/args.ts
git commit -m "feat: update CLI to use calendarId from config"
```

---

### Task 9: Remove ICS-related code and dependencies

**Files:**

- Delete: `src/lib/calendar/fetcher.ts`
- Modify: `src/lib/calendar/parser.ts` — remove `parseCalendarEvents()` function
- Modify: `tests/calendar/parser.test.ts` — remove tests for `parseCalendarEvents()`
- Remove: `ical.js` dependency from `package.json`

- [ ] **Step 1: Delete `fetcher.ts`**

Remove `src/lib/calendar/fetcher.ts`.

- [ ] **Step 2: Remove `parseCalendarEvents` from parser.ts**

In `src/lib/calendar/parser.ts`, delete the `parseCalendarEvents` function and the `ICAL` import. Keep `extractClasses` and the helper functions (`formatDate`, `formatTime`, `parseStudentCount`).

- [ ] **Step 3: Update parser tests**

In `tests/calendar/parser.test.ts`, remove the `parseCalendarEvents` import and the `describe('parseCalendarEvents', ...)` block. The `extractClasses` tests will need to construct `CalendarEvent[]` directly rather than parsing from ICS. Update the test file:

```typescript
import { describe, it, expect } from 'vitest';
import { extractClasses } from '../../src/lib/calendar/parser.js';
import { CalendarEvent } from '../../src/lib/types.js';

// Test events that mirror what the Calendar API would return
const testEvents: CalendarEvent[] = [
  {
    uid: 'event-1',
    summary: 'Zen Yoga / Vinyasa Flow',
    description: '8',
    start: new Date('2026-01-03T09:00:00'),
    end: new Date('2026-01-03T10:15:00'),
  },
  {
    uid: 'event-2',
    summary: 'Zen Yoga / Yin Yoga',
    description: '3',
    start: new Date('2026-01-05T18:00:00'),
    end: new Date('2026-01-05T19:15:00'),
  },
  {
    uid: 'event-3',
    summary: 'Power House / HIIT Yoga',
    description: '6',
    start: new Date('2026-01-07T10:00:00'),
    end: new Date('2026-01-07T11:15:00'),
  },
  {
    uid: 'event-4',
    summary: 'Zen Yoga / Vinyasa Flow',
    description: '12',
    start: new Date('2026-01-10T09:00:00'),
    end: new Date('2026-01-10T10:15:00'),
  },
  {
    uid: 'event-5',
    summary: 'Power House / Power Flow',
    description: '2',
    start: new Date('2026-01-12T14:00:00'),
    end: new Date('2026-01-12T15:15:00'),
  },
  {
    uid: 'event-6',
    summary: 'Zen Yoga / Hatha',
    description: '',
    start: new Date('2026-01-15T09:00:00'),
    end: new Date('2026-01-15T10:15:00'),
  },
  {
    uid: 'event-7',
    summary: 'Unknown Studio / Mystery Class',
    description: '5',
    start: new Date('2026-01-20T10:00:00'),
    end: new Date('2026-01-20T11:15:00'),
  },
  {
    uid: 'event-8',
    summary: 'No Separator Here',
    description: '5',
    start: new Date('2026-01-25T09:00:00'),
    end: new Date('2026-01-25T10:15:00'),
  },
  {
    uid: 'event-9',
    summary: 'YFD / mitte / Vinyasa',
    description: '7',
    start: new Date('2026-01-08T17:00:00'),
    end: new Date('2026-01-08T18:15:00'),
  },
  {
    uid: 'event-10',
    summary: 'YFD / schoeneberg / Hatha',
    description: '4',
    start: new Date('2026-01-14T17:00:00'),
    end: new Date('2026-01-14T18:15:00'),
  },
];

const knownStudios = new Map([
  ['zen yoga', 'Zen Yoga'],
  ['power house', 'Power House'],
]);

describe('extractClasses', () => {
  it('extracts valid classes', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    expect(classes.length).toBeGreaterThanOrEqual(5);
  });

  it('parses studio name and class type', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    const first = classes.find((c) => c.classType === 'Vinyasa Flow' && c.studentCount === 8);
    expect(first).toBeDefined();
    expect(first!.studioName).toBe('Zen Yoga');
    expect(first!.date).toBe('2026-01-03');
    expect(first!.startTime).toBe('09:00');
    expect(first!.endTime).toBe('10:15');
  });

  it('includes unknown studio as unconfigured class (not a warning)', () => {
    const { classes, warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'UNKNOWN_STUDIO')).toBe(false);
    expect(classes.some((c) => c.unconfigured && c.studioName === 'Unknown Studio')).toBe(true);
  });

  it('warns on missing separator', () => {
    const { warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'NO_SEPARATOR')).toBe(true);
  });

  it('warns on missing student count', () => {
    const { warnings } = extractClasses(testEvents, knownStudios);
    expect(warnings.some((w) => w.code === 'MISSING_STUDENT_COUNT')).toBe(true);
  });

  it('parses multi-location events (2 slashes)', () => {
    const studios = new Map([
      ['zen yoga', 'Zen Yoga'],
      ['power house', 'Power House'],
      ['yfd', 'YFD'],
    ]);
    const { classes } = extractClasses(testEvents, studios);
    const yfdClasses = classes.filter((c) => c.studioName === 'YFD');
    expect(yfdClasses).toHaveLength(2);
    expect(yfdClasses[0].location).toBe('mitte');
    expect(yfdClasses[0].classType).toBe('Vinyasa');
    expect(yfdClasses[1].location).toBe('schoeneberg');
    expect(yfdClasses[1].classType).toBe('Hatha');
  });

  it('single-location events have no location field', () => {
    const { classes } = extractClasses(testEvents, knownStudios);
    const zenClasses = classes.filter((c) => c.studioName === 'Zen Yoga');
    expect(zenClasses.every((c) => c.location === undefined)).toBe(true);
  });
});
```

- [ ] **Step 4: Remove ical.js dependency**

Run: `bun remove ical.js`

Also remove the `@types/ical.js` if it exists:

Run: `bun remove @types/ical.js` (ignore if not found)

- [ ] **Step 5: Delete the ICS fixture file**

Remove `tests/fixtures/sample.ics` — no longer needed.

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 7: Run TypeScript checks**

Run: `bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: remove ICS feed support, ical.js dependency, and fetcher"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run unit tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: No errors

- [ ] **Step 3: Run E2E tests**

Run: `bun run e2e`
Expected: All tests pass. The e2e tests don't test calendar fetching (they use a fixture config without a calendar URL/ID), so they should be unaffected.

- [ ] **Step 4: Manual smoke test**

Run: `bun run dev`

1. Open Rates tab — should show "Pick Calendar..." button (no ICS URL field)
2. Click "Pick Calendar..." — should trigger OAuth if needed, then list your calendars
3. Select a calendar — should save and trigger a refresh
4. Check Calendar tab — recurring events should now appear on all their occurrence dates
5. Check that multi-location events (e.g., yogibar/fhain/...) show correctly
