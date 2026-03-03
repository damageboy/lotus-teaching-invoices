# Calendar Tab: Per-Studio Monthly Summary

## Overview

Display a live summary below the calendar grid for each configured studio, showing the total payout and average payout per lesson for the currently displayed month.

## Goal

Give the teacher an at-a-glance financial summary without switching to the Invoices tab.

## Design

### Shared stats function

**File:** `src/lib/invoice/calculator.ts`

Add alongside `findRate`:

```ts
export interface StudioMonthStats {
  totalAmount: number;
  classCount: number; // non-zero-student classes only
  avgPerClass: number; // 0 when classCount is 0
}

export function computeStudioStats(classes: ParsedClass[], rateTiers: RateTier[]): StudioMonthStats;
```

- Skips classes with `studentCount === 0` (matches generator behaviour)
- Sums `findRate(rateTiers, cls.studentCount)` for each eligible class
- Returns `{ totalAmount, classCount, avgPerClass: totalAmount / classCount }`

`generateInvoice` in `generator.ts` is refactored to call `computeStudioStats` instead of its own inline accumulation loop.

### CalendarTab wiring

**`src/App.tsx`:** pass `config.studios` to `<CalendarTab>` (same pattern already used for `InvoicesTab`).

**`src/components/CalendarTab/index.tsx`:** add `studios?: Record<string, StudioConfig>` prop. For the displayed month, call `computeStudioStats` per configured studio that has ≥1 class.

### Summary UI

Below `<CalendarGrid>`, render a `flex flex-wrap gap-2` row of colored pills — one per configured studio with ≥1 class in the displayed month.

Each pill uses `studioColor(s)` (same as the legend) and shows:

```
StudioName  €320  ·  avg €40
```

- Studios with no classes in the month are omitted
- Section hidden entirely when no configured classes exist in the month
- Amounts formatted with `toFixed(2)` and a `€` prefix

## Data flow

```
config.studios (AppConfig)
      ↓ prop
CalendarTab (monthClasses filtered per displayed month)
      ↓ per configured studio
computeStudioStats(studioClasses, rateTiers) → StudioMonthStats
      ↓
Summary pills rendered below CalendarGrid
```

## Files changed

| File                                   | Change                                             |
| -------------------------------------- | -------------------------------------------------- |
| `src/lib/invoice/calculator.ts`        | Add `StudioMonthStats` + `computeStudioStats`      |
| `src/lib/invoice/generator.ts`         | Refactor to use `computeStudioStats`               |
| `src/App.tsx`                          | Pass `studios={config.studios}` to `<CalendarTab>` |
| `src/components/CalendarTab/index.tsx` | Accept `studios` prop, render summary section      |
| `tests/invoice/calculator.test.ts`     | Add tests for `computeStudioStats`                 |
