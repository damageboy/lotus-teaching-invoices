# Multi-Location Studio Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support calendar events with two slashes (`Studio / Location / ClassType`) so multi-location studios aggregate into a single invoice while preserving location info in display.

**Architecture:** Add an optional `location` field to `ParsedClass` and `InvoiceLineItem`. The parser detects 2-slash events and extracts the location segment. Grouping/invoicing is unchanged — location is display metadata. Calendar chips and legend render location info contextually.

**Tech Stack:** TypeScript, React, Vitest

---

### Task 1: Add `location` to types

**Files:**

- Modify: `src/lib/types.ts:44-53` (ParsedClass)
- Modify: `src/lib/types.ts:55-63` (InvoiceLineItem)

**Step 1: Add `location` field to `ParsedClass`**

In `src/lib/types.ts`, add `location?: string` to `ParsedClass` (after `classType`):

```typescript
export interface ParsedClass {
  studioName: string;
  classType: string;
  location?: string; // e.g. "mitte" — only for multi-location studios
  date: string;
  startTime: string;
  endTime: string;
  studentCount: number;
  unconfigured?: boolean;
  ambiguousStudentCount?: boolean;
}
```

**Step 2: Add `location` field to `InvoiceLineItem`**

```typescript
export interface InvoiceLineItem {
  date: string;
  startTime: string;
  endTime: string;
  classType: string;
  location?: string;
  studentCount: number;
  rateApplied: number;
  lineTotal: number;
}
```

**Step 3: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS (new optional fields don't break existing code)

**Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add optional location field to ParsedClass and InvoiceLineItem"
```

---

### Task 2: Update parser to handle 2-slash events

**Files:**

- Modify: `src/lib/calendar/parser.ts:62-118`
- Test: `tests/calendar/parser.test.ts`
- Fixture: `tests/fixtures/sample.ics`

**Step 1: Add multi-location events to the test fixture**

Append before `END:VCALENDAR` in `tests/fixtures/sample.ics`:

```ics
BEGIN:VEVENT
DTSTART:20260108T170000
DTEND:20260108T181500
SUMMARY:YFD / mitte / Vinyasa
DESCRIPTION:7
UID:event-9@test
END:VEVENT
BEGIN:VEVENT
DTSTART:20260114T170000
DTEND:20260114T181500
SUMMARY:YFD / schoeneberg / Hatha
DESCRIPTION:4
UID:event-10@test
END:VEVENT
```

**Step 2: Write failing tests**

Add to `tests/calendar/parser.test.ts`:

```typescript
it('parses multi-location events (2 slashes)', () => {
  const events = parseCalendarEvents(icsData);
  const studios = new Map([
    ['zen yoga', 'Zen Yoga'],
    ['power house', 'Power House'],
    ['yfd', 'YFD'],
  ]);
  const { classes } = extractClasses(events, studios);
  const yfdClasses = classes.filter((c) => c.studioName === 'YFD');
  expect(yfdClasses).toHaveLength(2);
  expect(yfdClasses[0].location).toBe('mitte');
  expect(yfdClasses[0].classType).toBe('Vinyasa');
  expect(yfdClasses[1].location).toBe('schoeneberg');
  expect(yfdClasses[1].classType).toBe('Hatha');
});

it('single-location events have no location field', () => {
  const events = parseCalendarEvents(icsData);
  const studios = new Map([
    ['zen yoga', 'Zen Yoga'],
    ['power house', 'Power House'],
  ]);
  const { classes } = extractClasses(events, studios);
  const zenClasses = classes.filter((c) => c.studioName === 'Zen Yoga');
  expect(zenClasses.every((c) => c.location === undefined)).toBe(true);
});
```

**Step 3: Run tests to verify they fail**

Run: `bunx vitest run tests/calendar/parser.test.ts`
Expected: FAIL — `location` is undefined for YFD classes, and YFD classes aren't found because 'yfd' isn't in knownStudios for the existing tests.

**Step 4: Implement 2-slash parsing**

Replace the slash-parsing logic in `src/lib/calendar/parser.ts` (lines 63-70) with:

```typescript
// Count slashes to distinguish single-location vs multi-location events
// 1 slash: "Studio / ClassType"
// 2 slashes: "Studio / Location / ClassType"
const parts = event.summary.split('/').map((p) => p.trim());

let rawStudioName: string;
let location: string | undefined;
let classType: string;

if (parts.length === 2) {
  rawStudioName = parts[0];
  classType = parts[1];
} else if (parts.length === 3) {
  rawStudioName = parts[0];
  location = parts[1];
  classType = parts[2];
} else if (parts.length < 2) {
  warnings.push({ code: 'NO_SEPARATOR', event: event.summary });
  continue;
} else {
  // 4+ slashes — treat as malformed
  warnings.push({ code: 'NO_SEPARATOR', event: event.summary });
  continue;
}

if (!rawStudioName || !classType) {
  warnings.push({ code: 'MISSING_CLASS_TYPE', event: event.summary });
  continue;
}
```

Then update both `classes.push()` calls (unconfigured branch at ~line 83 and configured branch at ~line 110) to include `...(location ? { location } : {})`.

For the unconfigured branch:

```typescript
classes.push({
  studioName: rawStudioName,
  classType,
  ...(location ? { location } : {}),
  date: formatDate(event.start),
  startTime: formatTime(event.start),
  endTime: formatTime(event.end),
  studentCount: studentCount ?? 0,
  unconfigured: true,
  ambiguousStudentCount: studentCountResult.ambiguous,
});
```

For the configured branch:

```typescript
classes.push({
  studioName,
  classType,
  ...(location ? { location } : {}),
  date: formatDate(event.start),
  startTime: formatTime(event.start),
  endTime: formatTime(event.end),
  studentCount: studentCount ?? 0,
  ambiguousStudentCount: studentCountResult.ambiguous,
});
```

**Step 5: Run tests to verify they pass**

Run: `bunx vitest run tests/calendar/parser.test.ts`
Expected: PASS

**Step 6: Update the existing test for event count**

The fixture now has 10 events instead of 8. Update the test at line 12:

```typescript
expect(events).toHaveLength(10);
```

**Step 7: Run all tests**

Run: `bun test`
Expected: PASS

**Step 8: Commit**

```bash
git add src/lib/calendar/parser.ts tests/calendar/parser.test.ts tests/fixtures/sample.ics
git commit -m "feat: parse multi-location calendar events (2-slash format)"
```

---

### Task 3: Pass `location` through invoice generator

**Files:**

- Modify: `src/lib/invoice/generator.ts:36-44`
- Test: `tests/invoice/generator.test.ts`

**Step 1: Write failing test**

Add to `tests/invoice/generator.test.ts`:

```typescript
it('preserves location in invoice line items', () => {
  const classesWithLocation: ParsedClass[] = [
    {
      studioName: 'YFD',
      classType: 'Vinyasa',
      location: 'mitte',
      date: '2026-01-08',
      startTime: '17:00',
      endTime: '18:15',
      studentCount: 7,
    },
    {
      studioName: 'YFD',
      classType: 'Hatha',
      location: 'schoeneberg',
      date: '2026-01-14',
      startTime: '17:00',
      endTime: '18:15',
      studentCount: 4,
    },
  ];

  const { invoice } = generateInvoice('YFD', classesWithLocation, studioConfig, {
    from: '2026-01-01',
    to: '2026-01-31',
  });

  expect(invoice.classes[0].location).toBe('mitte');
  expect(invoice.classes[0].classType).toBe('Vinyasa');
  expect(invoice.classes[1].location).toBe('schoeneberg');
  expect(invoice.classes[1].classType).toBe('Hatha');
});

it('omits location for single-location classes', () => {
  const { invoice } = generateInvoice('Zen Yoga', classes, studioConfig, {
    from: '2026-01-01',
    to: '2026-01-31',
  });

  expect(invoice.classes.every((c) => c.location === undefined)).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/invoice/generator.test.ts`
Expected: FAIL — `location` is undefined on line items

**Step 3: Implement — pass location through**

In `src/lib/invoice/generator.ts`, update the `lineItems.push()` call (around line 36) to include location:

```typescript
lineItems.push({
  date: cls.date,
  startTime: cls.startTime,
  endTime: cls.endTime,
  classType: cls.classType,
  ...(cls.location ? { location: cls.location } : {}),
  studentCount: cls.studentCount,
  rateApplied: rate,
  lineTotal: rate,
});
```

**Step 4: Run tests**

Run: `bunx vitest run tests/invoice/generator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/invoice/generator.ts tests/invoice/generator.test.ts
git commit -m "feat: pass location through to invoice line items"
```

---

### Task 4: Update EventChip to show location

**Files:**

- Modify: `src/components/CalendarTab/EventChip.tsx`

**Step 1: Create a display label helper**

The chip should show `"location / classType"` for multi-location, `"classType"` for single-location. Add a computed label at the top of the component:

```typescript
const chipLabel = cls.location ? `${cls.location} / ${cls.classType}` : cls.classType;
```

**Step 2: Replace all `{cls.classType}` references with `{chipLabel}`**

There are 4 places in EventChip where `cls.classType` appears in JSX (lines 21, 33, 43, 53). Replace each with `chipLabel`.

**Step 3: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/CalendarTab/EventChip.tsx
git commit -m "feat: show location in calendar event chips for multi-location studios"
```

---

### Task 5: Update CalendarTab legend with location sub-text

**Files:**

- Modify: `src/components/CalendarTab/index.tsx:112-126`

**Step 1: Compute locations per studio**

Add a `useMemo` after the existing `colorMap` computation (around line 63). This collects the unique locations seen per studio in the current month:

```typescript
// For multi-location studios, collect the locations seen this month
const studioLocations = useMemo(() => {
  const map = new Map<string, Set<string>>();
  for (const cls of monthClasses) {
    if (cls.location) {
      const set = map.get(cls.studioName) ?? new Set();
      set.add(cls.location);
      map.set(cls.studioName, set);
    }
  }
  return map;
}, [monthClasses]);
```

**Step 2: Update configured studio legend entries**

In the legend rendering (line 114-126), update to show locations below studio name:

```tsx
{
  configuredStudios.map((s) => {
    const c = studioColor(s, colorMap[s]);
    const locations = studioLocations.get(s);
    return (
      <span
        key={s}
        className="text-xs px-2 py-0.5 rounded border inline-flex flex-col"
        style={{
          backgroundColor: c.backgroundColor,
          color: c.color,
          borderColor: c.borderColor,
        }}
      >
        <span>{s}</span>
        {locations && (
          <span className="text-[10px] opacity-60">{[...locations].sort().join(', ')}</span>
        )}
      </span>
    );
  });
}
```

**Step 3: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/CalendarTab/index.tsx
git commit -m "feat: show multi-location sub-text in calendar legend"
```

---

### Task 6: Show location in PDF invoice

**Files:**

- Modify: `src/lib/pdf/InvoiceDocument.tsx:129`

**Step 1: Update the class column in the PDF table**

In `InvoiceDocument.tsx` line 129, replace:

```tsx
<Text style={s.col}>{item.classType}</Text>
```

with:

```tsx
<Text style={s.col}>{item.location ? `${item.location} / ${item.classType}` : item.classType}</Text>
```

**Step 2: Run type check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/pdf/InvoiceDocument.tsx
git commit -m "feat: show location in PDF invoice class column"
```

---

### Task 7: Update generator warning to include location

**Files:**

- Modify: `src/lib/invoice/generator.ts:29`

**Step 1: Include location in ZERO_STUDENTS warning**

The warning event string at line 29 currently reads:

```typescript
event: `${cls.studioName} / ${cls.classType}`,
```

Update to include location when present:

```typescript
event: cls.location
  ? `${cls.studioName} / ${cls.location} / ${cls.classType}`
  : `${cls.studioName} / ${cls.classType}`,
```

**Step 2: Commit**

```bash
git add src/lib/invoice/generator.ts
git commit -m "fix: include location in zero-students warning message"
```

---

### Task 8: Run all tests and type checks

**Step 1: Run unit tests**

Run: `bun test`
Expected: All tests pass

**Step 2: Run TypeScript check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: No errors

**Step 3: Run E2E tests**

Run: `bun run e2e`
Expected: All 15 tests pass (no UI structure changes that would break selectors)

---

### Task 9: Final commit and cleanup

Review all changes, ensure no debug code or unnecessary additions remain.
