# Calendar Studio Monthly Summary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show per-studio total payout and average payout per lesson as colored pills below the calendar grid for the displayed month.

**Architecture:** Extract a `computeStudioStats` function from existing invoice logic so that both `generateInvoice` and the CalendarTab share the same rate-computation code. Pass `config.studios` into `CalendarTab` to enable live stats without duplicating business logic.

**Tech Stack:** TypeScript, React 19, Vitest, Tailwind CSS v4

---

### Task 1: Add `computeStudioStats` to calculator.ts (TDD)

**Files:**

- Modify: `src/lib/invoice/calculator.ts`
- Test: `tests/invoice/calculator.test.ts`

**Step 1: Add failing tests for `computeStudioStats`**

Append to `tests/invoice/calculator.test.ts` (after the existing `findRate` describe block):

```ts
import { findRate, computeStudioStats } from '../../src/lib/invoice/calculator.js';
import { RateTier, ParsedClass } from '../../src/lib/types.js';
```

Replace the existing import line at the top with:

```ts
import { findRate, computeStudioStats } from '../../src/lib/invoice/calculator.js';
import { RateTier, ParsedClass } from '../../src/lib/types.js';
```

Then append this describe block at the bottom of the file:

```ts
const classFixtures: ParsedClass[] = [
  {
    studioName: 'Zen Yoga',
    classType: 'Vinyasa',
    date: '2026-01-03',
    startTime: '09:00',
    endTime: '10:15',
    studentCount: 8,
  }, // → 100
  {
    studioName: 'Zen Yoga',
    classType: 'Yin',
    date: '2026-01-05',
    startTime: '18:00',
    endTime: '19:15',
    studentCount: 3,
  }, // → 80
  {
    studioName: 'Zen Yoga',
    classType: 'Vinyasa',
    date: '2026-01-10',
    startTime: '09:00',
    endTime: '10:15',
    studentCount: 12,
  }, // → 120
];

describe('computeStudioStats', () => {
  it('sums rates and counts classes', () => {
    const stats = computeStudioStats(classFixtures, tiers);
    expect(stats.totalAmount).toBe(300); // 100 + 80 + 120
    expect(stats.classCount).toBe(3);
  });

  it('computes correct average', () => {
    const stats = computeStudioStats(classFixtures, tiers);
    expect(stats.avgPerClass).toBeCloseTo(100); // 300 / 3
  });

  it('skips zero-student classes', () => {
    const withZero: ParsedClass[] = [
      ...classFixtures,
      {
        studioName: 'Zen Yoga',
        classType: 'Hatha',
        date: '2026-01-12',
        startTime: '09:00',
        endTime: '10:15',
        studentCount: 0,
      },
    ];
    const stats = computeStudioStats(withZero, tiers);
    expect(stats.totalAmount).toBe(300);
    expect(stats.classCount).toBe(3);
  });

  it('returns zeros for empty input', () => {
    const stats = computeStudioStats([], tiers);
    expect(stats.totalAmount).toBe(0);
    expect(stats.classCount).toBe(0);
    expect(stats.avgPerClass).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/invoice/calculator.test.ts
```

Expected: import error — `computeStudioStats` is not exported yet.

**Step 3: Implement `computeStudioStats` in `src/lib/invoice/calculator.ts`**

Replace the full file contents:

```ts
import { RateTier, ParsedClass, AppError } from '../types.js';

export function findRate(tiers: RateTier[], studentCount: number): number {
  for (const tier of tiers) {
    const inMin = studentCount >= tier.minStudents;
    const inMax = tier.maxStudents === null || studentCount <= tier.maxStudents;
    if (inMin && inMax) {
      return tier.rate;
    }
  }

  throw new AppError(`No matching rate tier for ${studentCount} students`, 'NO_MATCHING_TIER');
}

export interface StudioMonthStats {
  totalAmount: number;
  classCount: number; // non-zero-student classes only
  avgPerClass: number; // 0 when classCount is 0
}

export function computeStudioStats(
  classes: ParsedClass[],
  rateTiers: RateTier[]
): StudioMonthStats {
  let totalAmount = 0;
  let classCount = 0;
  for (const cls of classes) {
    if (cls.studentCount === 0) continue;
    totalAmount += findRate(rateTiers, cls.studentCount);
    classCount++;
  }
  return {
    totalAmount,
    classCount,
    avgPerClass: classCount === 0 ? 0 : totalAmount / classCount,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/invoice/calculator.test.ts
```

Expected: all tests PASS (existing `findRate` tests + new `computeStudioStats` tests).

**Step 5: Commit**

```bash
git add src/lib/invoice/calculator.ts tests/invoice/calculator.test.ts
git commit -m "feat: add computeStudioStats to calculator"
```

---

### Task 2: Refactor `generateInvoice` to use `computeStudioStats`

**Files:**

- Modify: `src/lib/invoice/generator.ts`
- Test: `tests/invoice/generator.test.ts` (no changes needed — existing tests verify behaviour is unchanged)

**Step 1: Update `generator.ts` to use `computeStudioStats`**

Replace `src/lib/invoice/generator.ts` with:

```ts
import {
  ParsedClass,
  Invoice,
  InvoiceLineItem,
  InvoicePeriod,
  StudioConfig,
  ParseWarning,
} from '../types.js';
import { findRate, computeStudioStats } from './calculator.js';

export interface GenerateResult {
  invoice: Invoice;
  warnings: ParseWarning[];
}

export function generateInvoice(
  studioName: string,
  classes: ParsedClass[],
  studioConfig: StudioConfig,
  period: InvoicePeriod
): GenerateResult {
  const lineItems: InvoiceLineItem[] = [];
  const warnings: ParseWarning[] = [];

  for (const cls of classes) {
    if (cls.studentCount === 0) {
      warnings.push({
        code: 'ZERO_STUDENTS',
        event: `${cls.studioName} / ${cls.classType}`,
        date: cls.date,
      });
      continue;
    }

    const rate = findRate(studioConfig.rateTiers, cls.studentCount);
    lineItems.push({
      date: cls.date,
      startTime: cls.startTime,
      endTime: cls.endTime,
      classType: cls.classType,
      studentCount: cls.studentCount,
      rateApplied: rate,
      lineTotal: rate,
    });
  }

  const { totalAmount, classCount } = computeStudioStats(classes, studioConfig.rateTiers);

  return {
    invoice: {
      studioName,
      invoicePeriod: period,
      generatedAt: new Date().toISOString(),
      classes: lineItems,
      totalClasses: classCount,
      totalAmount,
    },
    warnings,
  };
}
```

**Step 2: Run all tests to verify nothing broke**

```bash
npm test
```

Expected: all 31+ tests PASS.

**Step 3: Commit**

```bash
git add src/lib/invoice/generator.ts
git commit -m "refactor: generateInvoice uses computeStudioStats for totals"
```

---

### Task 3: Pass `studios` config into CalendarTab

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/components/CalendarTab/index.tsx`

**Step 1: Update `CalendarTab` props interface**

In `src/components/CalendarTab/index.tsx`, update the import and Props:

```ts
import { useState } from 'react';
import { ParsedClass, StudioConfig } from '../../lib/types';
import { CalendarGrid } from './CalendarGrid';
import { studioColor } from '../../lib/studioColors';

interface Props {
  classes: ParsedClass[];
  studios?: Record<string, StudioConfig>;
}
```

Update the function signature:

```ts
export function CalendarTab({ classes, studios = {} }: Props) {
```

**Step 2: Pass `studios` from `App.tsx`**

In `src/App.tsx`, find the CalendarTab render line and update it:

```ts
{activeTab === 'calendar' && <CalendarTab classes={classes} studios={config.studios} />}
```

**Step 3: Run TypeScript check**

```bash
npx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/components/CalendarTab/index.tsx src/App.tsx
git commit -m "feat: pass studios config into CalendarTab"
```

---

### Task 4: Render studio summary pills below the calendar grid

**Files:**

- Modify: `src/components/CalendarTab/index.tsx`

**Step 1: Add import for `computeStudioStats`**

Add to the imports at the top of `src/components/CalendarTab/index.tsx`:

```ts
import { computeStudioStats } from '../../lib/invoice/calculator';
```

**Step 2: Compute per-studio stats for the displayed month**

Inside `CalendarTab`, after the `monthClasses` computation, add:

```ts
// Per-studio stats for the displayed month (configured studios only)
const studioStats = Object.entries(studios)
  .map(([key, studioConfig]) => {
    const studioClasses = monthClasses.filter((c) => c.studioName === key && !c.unconfigured);
    if (studioClasses.length === 0) return null;
    const stats = computeStudioStats(studioClasses, studioConfig.rateTiers);
    return { key, stats };
  })
  .filter(
    (entry): entry is { key: string; stats: ReturnType<typeof computeStudioStats> } =>
      entry !== null
  );
```

**Step 3: Render summary pills below the grid**

Inside the return JSX, after `<CalendarGrid ... />`, add:

```tsx
{
  studioStats.length > 0 && (
    <div className="flex gap-2 flex-wrap items-center pt-1">
      {studioStats.map(({ key, stats }) => {
        const c = studioColor(key);
        return (
          <span
            key={key}
            className={`text-xs px-3 py-1 rounded border ${c.bg} ${c.text} ${c.border}`}
          >
            {key}
            <span className="mx-1.5 opacity-40">·</span>€{stats.totalAmount.toFixed(2)}
            <span className="mx-1.5 opacity-40">·</span>
            avg €{stats.avgPerClass.toFixed(2)}
          </span>
        );
      })}
    </div>
  );
}
```

**Step 4: Run TypeScript check**

```bash
npx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 5: Run all unit tests**

```bash
npm test
```

Expected: all tests PASS.

**Step 6: Browser smoke test**

```bash
npm run dev:vite
# Navigate to http://localhost:1420
# Check Calendar tab — summary pills should appear below the grid
# Navigate months — pills update live
# Check console for errors
pkill -f "vite"
```

**Step 7: Commit**

```bash
git add src/components/CalendarTab/index.tsx
git commit -m "feat: show per-studio monthly summary pills on calendar tab"
```
