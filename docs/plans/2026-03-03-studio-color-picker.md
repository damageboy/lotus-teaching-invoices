# Studio Color Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users assign an explicit hex color to each studio via a popup with a swatch tab and a radial color picker, fixing the hash-collision problem where two studios land on the same color.

**Architecture:** Add `color?: string` (hex) to `StudioConfig`; rewrite `studioColors.ts` to derive light/dark/border from a single base hex via HSL math, replacing the Tailwind class approach with React `style` objects; new `ColorPickerPopup` component with `react-colorful`'s `HexColorPicker`; wire the dot trigger into each `StudioCard` in `RatesTab`; auto-assign palette colors on creation.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, `react-colorful` (HexColorPicker), Vitest, Zod

---

### Task 1: Install react-colorful

**Files:**

- Modify: `package.json` (via bun add)

**Step 1: Install the package**

```bash
bun add react-colorful
```

**Step 2: Verify it appears in package.json**

```bash
grep react-colorful package.json
```

Expected output contains: `"react-colorful": "^x.x.x"`

**Step 3: Run existing tests to confirm nothing broke**

```bash
bun test
```

Expected: 57 pass, 0 fail

**Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add react-colorful dependency"
```

---

### Task 2: Add `color` field to types and schema

**Files:**

- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `tests/fixtures/config.yaml`
- Modify: `tests/config/loader.test.ts`

**Step 1: Write failing schema tests**

In `tests/config/loader.test.ts`, add a new `describe` block at the end of the file:

```ts
describe('studio color field', () => {
  const base = {
    studios: {
      Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] },
    },
  };

  it('accepts absent color (defaults to undefined)', () => {
    const cfg = validateConfig(base);
    expect(cfg.studios['Foo'].color).toBeUndefined();
  });

  it('accepts a valid hex color', () => {
    const cfg = validateConfig({
      ...base,
      studios: { Foo: { ...base.studios['Foo'], color: '#7c3aed' } },
    });
    expect(cfg.studios['Foo'].color).toBe('#7c3aed');
  });

  it('accepts uppercase hex', () => {
    const cfg = validateConfig({
      ...base,
      studios: { Foo: { ...base.studios['Foo'], color: '#7C3AED' } },
    });
    expect(cfg.studios['Foo'].color).toBe('#7C3AED');
  });

  it('rejects an invalid color string', () => {
    expect(() =>
      validateConfig({
        ...base,
        studios: { Foo: { ...base.studios['Foo'], color: 'violet' } },
      })
    ).toThrow(/color/);
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bunx vitest run tests/config/loader.test.ts
```

Expected: the 4 new tests fail with something like "color is not defined".

**Step 3: Add `color` to `StudioConfig` in `src/lib/types.ts`**

Current `StudioConfig`:

```ts
export interface StudioConfig {
  fullName: string;
  address: string;
  rateTiers: RateTier[];
}
```

Replace with:

```ts
export interface StudioConfig {
  fullName: string;
  address: string;
  rateTiers: RateTier[];
  color?: string; // hex, e.g. "#7c3aed"; absent = auto-assigned from palette
}
```

**Step 4: Add `color` to `StudioConfigSchema` in `src/lib/config/schema.ts`**

Current `StudioConfigSchema` (around line 78):

```ts
const StudioConfigSchema = z.object({
  fullName: z.string().default(''),
  address: z.string().default(''),
  rateTiers: z
    .array(RateTierSchema, { required_error: 'must have a rateTiers array' })
    .min(1, 'has no rate tiers defined')
    .superRefine(validateContiguity),
});
```

Replace with:

```ts
const StudioConfigSchema = z.object({
  fullName: z.string().default(''),
  address: z.string().default(''),
  rateTiers: z
    .array(RateTierSchema, { required_error: 'must have a rateTiers array' })
    .min(1, 'has no rate tiers defined')
    .superRefine(validateContiguity),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex string e.g. #7c3aed')
    .optional(),
});
```

Also update the studio config spread in `validateConfig` (around line 150) to include `color`:

```ts
config.studios[name] = {
  ...studio,
  rateTiers: sortedTiers,
  color: studio.color,
};
```

**Step 5: Add color to one fixture studio in `tests/fixtures/config.yaml`**

Add `color: "#7c3aed"` to the `Zen Yoga` studio entry:

```yaml
studios:
  'Zen Yoga':
    fullName: 'Zen Yoga Center'
    address: "789 Peace St\nHamburg"
    color: '#7c3aed'
    rateTiers:
      - { minStudents: 1, maxStudents: 5, rate: 80 }
      - { minStudents: 6, maxStudents: 10, rate: 100 }
      - { minStudents: 11, maxStudents: null, rate: 120 }
```

**Step 6: Run all tests to confirm pass**

```bash
bun test
```

Expected: 61 pass, 0 fail (57 existing + 4 new).

**Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/config/schema.ts tests/fixtures/config.yaml tests/config/loader.test.ts
git commit -m "feat: add optional color field to StudioConfig"
```

---

### Task 3: Rewrite `studioColors.ts`

**Files:**

- Modify: `src/lib/studioColors.ts`
- Create: `tests/lib/studioColors.test.ts`

**Step 1: Write failing tests**

Create `tests/lib/studioColors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { studioColor, nextUnusedColor, PALETTE_HEX } from '../../src/lib/studioColors';

describe('PALETTE_HEX', () => {
  it('has 6 entries, all valid hex', () => {
    expect(PALETTE_HEX).toHaveLength(6);
    for (const h of PALETTE_HEX) {
      expect(h).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('studioColor', () => {
  it('returns an object with backgroundColor, color, borderColor', () => {
    const s = studioColor('My Studio');
    expect(s).toHaveProperty('backgroundColor');
    expect(s).toHaveProperty('color');
    expect(s).toHaveProperty('borderColor');
  });

  it('uses provided hex when given', () => {
    const s = studioColor('Any Name', '#ff0000');
    // red hue → h ≈ 0; light bg should be very light reddish
    expect(s.backgroundColor).toContain('hsl(');
    expect(s.color).toContain('hsl(');
    expect(s.borderColor).toContain('hsl(');
  });

  it('two studios with same palette index get same color when no hex override', () => {
    // Both should be deterministic for same name
    expect(studioColor('Yogibar')).toEqual(studioColor('Yogibar'));
  });

  it('backgroundColor is lighter than borderColor (higher lightness)', () => {
    const s = studioColor('Test', '#059669');
    // bg is hsl(h,s%,93%), border is hsl(h,s%,70%) — bg lightness number is higher
    const bgL = parseInt(s.backgroundColor.match(/(\d+)%\)/)![1]);
    const borderL = parseInt(s.borderColor.match(/(\d+)%\)/)![1]);
    expect(bgL).toBeGreaterThan(borderL);
  });
});

describe('nextUnusedColor', () => {
  it('returns the first palette color when none are used', () => {
    expect(nextUnusedColor([])).toBe(PALETTE_HEX[0]);
  });

  it('skips already-used colors', () => {
    expect(nextUnusedColor([PALETTE_HEX[0]])).toBe(PALETTE_HEX[1]);
    expect(nextUnusedColor([PALETTE_HEX[0], PALETTE_HEX[1]])).toBe(PALETTE_HEX[2]);
  });

  it('wraps around when all palette colors are used', () => {
    expect(nextUnusedColor(PALETTE_HEX)).toBe(PALETTE_HEX[0]);
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bunx vitest run tests/lib/studioColors.test.ts
```

Expected: FAIL (functions not found / wrong return type).

**Step 3: Rewrite `src/lib/studioColors.ts`**

Replace the entire file:

```ts
export const PALETTE_HEX = [
  '#7c3aed', // violet
  '#0284c7', // sky
  '#059669', // emerald
  '#d97706', // amber
  '#e11d48', // rose
  '#0d9488', // teal
];

function hashString(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

export function studioColor(
  name: string,
  hex?: string
): { backgroundColor: string; color: string; borderColor: string } {
  const baseHex = hex ?? PALETTE_HEX[hashString(name) % PALETTE_HEX.length];
  const [h, s] = hexToHsl(baseHex);
  return {
    backgroundColor: `hsl(${h}, ${s}%, 93%)`,
    color: `hsl(${h}, ${s}%, 25%)`,
    borderColor: `hsl(${h}, ${s}%, 70%)`,
  };
}

export function nextUnusedColor(usedHexes: string[]): string {
  const used = new Set(usedHexes);
  return PALETTE_HEX.find((h) => !used.has(h)) ?? PALETTE_HEX[0];
}
```

**Step 4: Run tests**

```bash
bun test
```

Expected: 68 pass (61 existing + 7 new), 0 fail.

**Step 5: Commit**

```bash
git add src/lib/studioColors.ts tests/lib/studioColors.test.ts
git commit -m "feat: rewrite studioColors with hex palette, HSL derivation, nextUnusedColor"
```

---

### Task 4: Update `EventChip` to use style-based colors

`EventChip` currently calls `studioColor(cls.studioName)` and uses `color.bg`, `color.text`, `color.border` as Tailwind classNames. After this task it will receive the stored hex and apply an inline `style`.

**Files:**

- Modify: `src/components/CalendarTab/EventChip.tsx`
- Modify: `src/components/CalendarTab/CalendarGrid.tsx`
- Modify: `src/components/CalendarTab/index.tsx`

**Step 1: Update `EventChip.tsx`**

Replace the entire file:

```tsx
import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
  studioHex?: string;
}

export function EventChip({ cls, studioHex }: Props) {
  const c = studioColor(cls.studioName, studioHex);
  if (cls.unconfigured) {
    return (
      <div
        title={`${cls.studioName} — no rates configured`}
        style={{ ...c, opacity: 0.7, borderStyle: 'dashed' }}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border cursor-default"
      >
        ⚠ {cls.startTime} {cls.classType}
      </div>
    );
  }
  if (cls.ambiguousStudentCount) {
    return (
      <div
        title={`${cls.studioName} — ambiguous student count`}
        className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border border-dashed border-red-400 bg-red-50 text-red-700 opacity-90 cursor-default"
      >
        ❓ {cls.startTime} {cls.classType}
      </div>
    );
  }
  return (
    <div
      title={`${cls.studioName} — ${cls.studentCount} students`}
      style={c}
      className="text-xs rounded px-1 py-0.5 mb-0.5 truncate border cursor-default"
    >
      {cls.startTime} {cls.classType}
    </div>
  );
}
```

**Step 2: Update `CalendarGrid.tsx`**

Add `colorMap` prop and pass `studioHex` to `EventChip`.

Replace the entire file:

```tsx
import { ParsedClass } from '../../lib/types';
import { EventChip } from './EventChip';

interface Props {
  year: number;
  month: number; // 0-indexed (0 = January)
  classes: ParsedClass[];
  colorMap?: Record<string, string | undefined>;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  // Returns 0=Mon … 6=Sun
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7;
}

export function CalendarGrid({ year, month, classes, colorMap = {} }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = getFirstDayOfWeek(year, month);

  // Build a map: "YYYY-MM-DD" -> ParsedClass[]
  const byDate = new Map<string, ParsedClass[]>();
  for (const cls of classes) {
    const list = byDate.get(cls.date) ?? [];
    list.push(cls);
    byDate.set(cls.date, list);
  }

  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded">
      {DAY_LABELS.map((d) => (
        <div key={d} className="bg-gray-50 text-center text-xs font-medium text-gray-500 py-1">
          {d}
        </div>
      ))}
      {cells.map((day, i) => {
        if (day === null) {
          return <div key={`empty-${i}`} className="bg-gray-50 min-h-[240px]" />;
        }
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayClasses = byDate.get(dateStr) ?? [];
        const isToday =
          today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

        return (
          <div key={dateStr} className="bg-white min-h-[240px] p-1">
            <div
              className={`text-xs font-medium mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : 'text-gray-700'
              }`}
            >
              {day}
            </div>
            {dayClasses.map((cls) => (
              <EventChip
                key={`${cls.date}-${cls.startTime}-${cls.studioName}`}
                cls={cls}
                studioHex={colorMap[cls.studioName]}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

**Step 3: Update `CalendarTab/index.tsx`** to compute `colorMap` and pass it to `CalendarGrid`, and switch legend/stats chips to inline styles.

Replace the import of `studioColor` and the entire component. The relevant changes are:

1. Add `useMemo` to imports (already present).
2. Compute `colorMap` from `studios`.
3. Switch legend chips from `className` to `style`.
4. Switch stats chips from `className` to `style`.
5. Pass `colorMap` to `CalendarGrid`.

Replace the entire file:

```tsx
import { useState, useMemo } from 'react';
import { ParsedClass, StudioConfig } from '../../lib/types';
import { CalendarGrid } from './CalendarGrid';
import { studioColor } from '../../lib/studioColors';
import { computeStudioStats, StudioMonthStats } from '../../lib/invoice/calculator';

interface Props {
  classes: ParsedClass[];
  studios?: Record<string, StudioConfig>;
  onAddStudio?: (name: string) => void;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function CalendarTab({ classes, studios = {}, onAddStudio }: Props) {
  const now = new Date();
  const defaultInPrevMonth = now.getDate() <= 15;
  const defaultMonth = defaultInPrevMonth
    ? now.getMonth() === 0
      ? 11
      : now.getMonth() - 1
    : now.getMonth();
  const defaultYear =
    defaultInPrevMonth && now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(defaultMonth);

  const monthClasses = classes.filter((cls) => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return cls.date.startsWith(prefix);
  });

  // Map from studio name to stored hex color (undefined = use hash fallback)
  const colorMap = useMemo(
    () =>
      Object.fromEntries(Object.entries(studios).map(([name, cfg]) => [name, cfg.color])) as Record<
        string,
        string | undefined
      >,
    [studios]
  );

  // Per-studio stats for the displayed month (configured studios only)
  const studioStats = Object.entries(studios)
    .map(([key, studioConfig]) => {
      const studioClasses = monthClasses.filter((c) => c.studioName === key && !c.unconfigured);
      if (studioClasses.length === 0) return null;
      const stats = computeStudioStats(studioClasses, studioConfig.rateTiers);
      return { key, stats };
    })
    .filter((entry): entry is { key: string; stats: StudioMonthStats } => entry !== null);

  // Unique studios for legend — split configured vs unconfigured
  const configuredStudios = [
    ...new Set(classes.filter((c) => !c.unconfigured).map((c) => c.studioName)),
  ].sort();
  const unconfiguredStudios = [
    ...new Set(classes.filter((c) => c.unconfigured).map((c) => c.studioName)),
  ].sort();

  function prevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else setMonth((m) => m + 1);
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Month switcher */}
      <div className="flex items-center gap-4">
        <button onClick={prevMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ‹
        </button>
        <h2 className="text-lg font-semibold w-44 text-center">
          {MONTH_NAMES[month]} {year}
        </h2>
        <button onClick={nextMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ›
        </button>
        <span className="ml-4 text-sm text-gray-400">
          {monthClasses.filter((c) => !c.unconfigured).length} classes
          {monthClasses.some((c) => c.unconfigured) && (
            <span className="ml-1 text-gray-300">
              + {monthClasses.filter((c) => c.unconfigured).length} unconfigured
            </span>
          )}
        </span>
      </div>

      {/* Legend */}
      {(configuredStudios.length > 0 || unconfiguredStudios.length > 0) && (
        <div className="flex gap-2 flex-wrap items-center">
          {configuredStudios.map((s) => (
            <span
              key={s}
              style={studioColor(s, colorMap[s])}
              className="text-xs px-2 py-0.5 rounded border"
            >
              {s}
            </span>
          ))}
          {unconfiguredStudios.length > 0 && configuredStudios.length > 0 && (
            <span className="text-gray-200">|</span>
          )}
          {unconfiguredStudios.map((s) => (
            <span
              key={s}
              style={{ ...studioColor(s, colorMap[s]), opacity: 0.7, borderStyle: 'dashed' }}
              className="text-xs px-2 py-0.5 flex items-center gap-2 rounded border"
              title="No rates configured"
            >
              <span>⚠ {s}</span>
              {onAddStudio && (
                <button
                  onClick={() => onAddStudio(s)}
                  className="text-[10px] uppercase font-bold text-indigo-500 hover:text-indigo-700 hover:underline"
                  title="Quick add studio config"
                >
                  Configure
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <CalendarGrid year={year} month={month} classes={monthClasses} colorMap={colorMap} />

      {studioStats.length > 0 && (
        <div className="flex gap-2 flex-wrap items-center pt-1">
          {studioStats.map(({ key, stats }) => (
            <span
              key={key}
              style={studioColor(key, colorMap[key])}
              className="text-xs px-3 py-1 rounded border"
            >
              {key}
              <span className="mx-1.5 opacity-40">·</span>€{stats.totalAmount.toFixed(2)}
              <span className="mx-1.5 opacity-40">·</span>
              avg €{stats.avgPerClass.toFixed(2)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Run all tests**

```bash
bun test
```

Expected: 68 pass, 0 fail.

**Step 5: Commit**

```bash
git add src/components/CalendarTab/EventChip.tsx src/components/CalendarTab/CalendarGrid.tsx src/components/CalendarTab/index.tsx
git commit -m "feat: switch CalendarTab/EventChip to style-based studio colors"
```

---

### Task 5: Create `ColorPickerPopup` component

**Files:**

- Create: `src/components/ColorPickerPopup/index.tsx`

No unit tests for this component — it is purely presentational. It will be verified visually in Task 7.

**Step 1: Create `src/components/ColorPickerPopup/index.tsx`**

```tsx
import { useState, useEffect, useRef } from 'react';
import { HexColorPicker } from 'react-colorful';
import { PALETTE_HEX, studioColor } from '../../lib/studioColors';

interface Props {
  currentColor: string;
  onColorChange: (hex: string) => void;
  onClose: () => void;
}

type Tab = 'swatches' | 'radial';

export function ColorPickerPopup({ currentColor, onColorChange, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('swatches');
  const [radialColor, setRadialColor] = useState(currentColor);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click-outside
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  function handleSwatchClick(hex: string) {
    onColorChange(hex);
    onClose();
  }

  function handleRadialChange(hex: string) {
    setRadialColor(hex);
    onColorChange(hex);
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-50 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg p-3 w-52"
      style={{ top: '100%', left: 0 }}
    >
      {/* Tab bar */}
      <div className="flex gap-1 mb-3 border-b border-gray-100 pb-2">
        {(['swatches', 'radial'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`text-xs px-2 py-0.5 rounded capitalize ${
              activeTab === tab
                ? 'bg-gray-100 text-gray-800 font-medium'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Swatches tab */}
      {activeTab === 'swatches' && (
        <div className="flex flex-wrap gap-2 justify-center">
          {PALETTE_HEX.map((hex) => {
            const isActive = hex.toLowerCase() === currentColor.toLowerCase();
            return (
              <button
                key={hex}
                onClick={() => handleSwatchClick(hex)}
                title={hex}
                style={{ backgroundColor: hex }}
                className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                  isActive ? 'border-gray-800 scale-110' : 'border-transparent'
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Radial tab */}
      {activeTab === 'radial' && (
        <div className="flex flex-col gap-2">
          <HexColorPicker
            color={radialColor}
            onChange={handleRadialChange}
            style={{ width: '100%', height: 160 }}
          />
          <div className="flex items-center gap-2 mt-1">
            <div
              className="w-5 h-5 rounded border border-gray-200 flex-shrink-0"
              style={{ backgroundColor: radialColor }}
            />
            <span className="text-xs font-mono text-gray-500">{radialColor}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Run tests (should all still pass)**

```bash
bun test
```

Expected: 68 pass, 0 fail.

**Step 3: Commit**

```bash
git add src/components/ColorPickerPopup/index.tsx
git commit -m "feat: add ColorPickerPopup with swatch and radial tabs"
```

---

### Task 6: Wire color picker into `RatesTab` / `StudioCard`

**Files:**

- Modify: `src/components/RatesTab/index.tsx`

**Step 1: Update `StudioCardProps` interface** — add `onUpdateColor` and extend `onUpdateField` to include `'color'`:

In the `StudioCardProps` interface (around line 13), change:

```ts
onUpdateField: (studioName: string, field: 'fullName' | 'address', value: string) => void;
```

to:

```ts
onUpdateColor: (studioName: string, hex: string) => void;
onUpdateField: (studioName: string, field: 'fullName' | 'address', value: string) => void;
```

**Step 2: Update the `StudioCard` component**

Add `onUpdateColor` to the destructured props. Add `pickerOpen` state. Add a color dot trigger in the header. Render `ColorPickerPopup` when open.

Replace the entire `StudioCard` function:

```tsx
function StudioCard({
  studioName,
  studio,
  onRename,
  onDelete,
  onUpdateTier,
  onAddTier,
  onRemoveTier,
  onUpdateField,
  onUpdateColor,
}: StudioCardProps) {
  const [draftName, setDraftName] = useState(studioName);
  const [isOpen, setIsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    setDraftName(studioName);
  }, [studioName]);

  const dotColor = studio.color
    ? studioColor(studioName, studio.color).backgroundColor
    : studioColor(studioName).backgroundColor;

  // Compute a saturated version for the dot itself (use borderColor as it's more vivid)
  const dotBorder = studio.color
    ? studioColor(studioName, studio.color).borderColor
    : studioColor(studioName).borderColor;

  return (
    <div className="rounded border border-gray-200">
      {/* Header — always visible, click to toggle */}
      <div
        className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"
        onClick={() => setIsOpen((o) => !o)}
      >
        <span className="text-gray-400 text-xs w-3">{isOpen ? '▾' : '▸'}</span>

        {/* Color dot trigger */}
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            title="Change studio color"
            style={{ backgroundColor: dotBorder }}
            className="w-4 h-4 rounded-full border border-gray-300 flex-shrink-0 hover:scale-110 transition-transform"
          />
          {pickerOpen && (
            <ColorPickerPopup
              currentColor={studio.color ?? PALETTE_HEX[0]}
              onColorChange={(hex) => onUpdateColor(studioName, hex)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        <span className="flex-1 text-sm font-medium truncate">{draftName}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(studioName);
          }}
          className="text-xs text-red-400 hover:text-red-600"
        >
          Delete
        </button>
      </div>

      {/* Body — only when open */}
      {isOpen && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-gray-100">
          <div className="flex items-center gap-2 pt-3">
            <input
              className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-medium"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                if (draftName !== studioName) onRename(studioName, draftName);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Full name (for invoice)</span>
            <input
              className="border border-gray-200 rounded px-2 py-1 text-sm"
              value={studio.fullName}
              onChange={(e) => onUpdateField(studioName, 'fullName', e.target.value)}
              placeholder="e.g. Yogibar Yoga Studio GmbH"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Address</span>
            <textarea
              className="border border-gray-200 rounded px-2 py-1 text-sm resize-none"
              rows={2}
              value={studio.address}
              onChange={(e) => onUpdateField(studioName, 'address', e.target.value)}
              placeholder="Street, City"
            />
          </label>

          {/* Rate tiers table */}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pb-1 font-normal">Min students</th>
                <th className="pb-1 font-normal">Max students</th>
                <th className="pb-1 font-normal">Rate (€)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {studio.rateTiers.map((tier, i) => (
                <tr key={i}>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      min={1}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.minStudents}
                      onChange={(e) => onUpdateTier(studioName, i, 'minStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      placeholder="∞"
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.maxStudents ?? ''}
                      onChange={(e) => onUpdateTier(studioName, i, 'maxStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      min={0}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.rate}
                      onChange={(e) => onUpdateTier(studioName, i, 'rate', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => onRemoveTier(studioName, i)}
                      className="text-gray-300 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => onAddTier(studioName)}
            className="text-xs text-indigo-500 hover:text-indigo-700 self-start"
          >
            + Add tier
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Add imports and `updateStudioColor` in `RatesTab`**

At the top of the file, add imports:

```ts
import { ColorPickerPopup } from '../ColorPickerPopup';
import { studioColor, PALETTE_HEX, nextUnusedColor } from '../../lib/studioColors';
```

In the `RatesTab` function body, add a new handler after `updateStudioField`:

```ts
function updateStudioColor(studioName: string, hex: string) {
  onUpdate({
    ...config,
    studios: {
      ...config.studios,
      [studioName]: { ...config.studios[studioName], color: hex },
    },
  });
}
```

**Step 4: Pass `onUpdateColor` in the `StudioCard` render in `RatesTab`**

In the `Object.entries(config.studios).map(...)` block, add the prop:

```tsx
<StudioCard
  key={idx}
  studioName={studioName}
  studio={studio}
  onRename={updateStudioName}
  onDelete={deleteStudio}
  onUpdateTier={updateTier}
  onAddTier={addTier}
  onRemoveTier={removeTier}
  onUpdateField={updateStudioField}
  onUpdateColor={updateStudioColor}
/>
```

**Step 5: Run all tests**

```bash
bun test
```

Expected: 68 pass, 0 fail.

**Step 6: Commit**

```bash
git add src/components/RatesTab/index.tsx src/components/ColorPickerPopup/index.tsx
git commit -m "feat: wire ColorPickerPopup into StudioCard header"
```

---

### Task 7: Auto-assign color on studio creation

**Files:**

- Modify: `src/components/RatesTab/index.tsx`
- Modify: `src/App.tsx`

**Step 1: Update `addStudio` in `RatesTab`**

Find the `addStudio` function (currently around line 233). It currently creates a studio without a `color`. Update it to call `nextUnusedColor` with the hex values of all existing studios:

Replace:

```ts
function addStudio() {
  const name = `New Studio ${Object.keys(config.studios).length + 1}`;
  onUpdate({
    ...config,
    studios: {
      ...config.studios,
      [name]: {
        fullName: '',
        address: '',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
      },
    },
  });
}
```

With:

```ts
function addStudio() {
  const name = `New Studio ${Object.keys(config.studios).length + 1}`;
  const usedColors = Object.values(config.studios)
    .map((s) => s.color)
    .filter((c): c is string => c !== undefined);
  onUpdate({
    ...config,
    studios: {
      ...config.studios,
      [name]: {
        fullName: '',
        address: '',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
        color: nextUnusedColor(usedColors),
      },
    },
  });
}
```

**Step 2: Update `handleAddStudio` in `src/App.tsx`**

Find `handleAddStudio` (around line 24). It creates a studio config without a `color`. Update it similarly.

First, add imports at the top of `App.tsx`:

```ts
import { nextUnusedColor } from './lib/studioColors';
```

Then replace `handleAddStudio`:

```ts
function handleAddStudio(name: string) {
  const usedColors = Object.values(config.studios)
    .map((s) => s.color)
    .filter((c): c is string => c !== undefined);
  updateConfig({
    ...config,
    studios: {
      ...config.studios,
      [name]: {
        fullName: name,
        address: '',
        rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
        color: nextUnusedColor(usedColors),
      },
    },
  });
  setActiveTab('rates');
}
```

**Step 3: Run all tests**

```bash
bun test
```

Expected: 68 pass, 0 fail.

**Step 4: Run TypeScript type check**

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/components/RatesTab/index.tsx src/App.tsx
git commit -m "feat: auto-assign unique palette color on studio creation"
```

---

### Task 8: Smoke test

Start the Vite dev server and verify the feature visually:

```bash
bun run dev:vite &
```

Navigate to `http://localhost:1420` and check:

1. **Rates & Config tab** — each studio card shows a color dot in the header.
2. Click a color dot → popup opens with Swatches tab active (6 colored circles).
3. Switch to Radial tab → HSL color wheel appears.
4. Pick a color → dot updates immediately, CalendarTab chips update when switching tabs.
5. Add a new studio → it gets a different color from any existing studio.
6. Save config → color persists across reload.
7. **Calendar tab** — chips and legend use studio colors correctly; no two configured studios share the same color.
8. Check browser console for errors.

```bash
# When done
pkill -f "vite"
```

**Commit any fixes found during smoke test**, then run the full e2e suite:

```bash
bun run e2e
```

Expected: all 14 existing tests pass.

**Final commit if e2e clean:**

```bash
git add -A
git commit -m "test: verify studio color picker with smoke test and e2e suite"
```
