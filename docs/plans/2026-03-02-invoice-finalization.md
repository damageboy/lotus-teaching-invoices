# Invoice Finalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a two-tier PDF output system (Preview / Final) where finalized invoices carry a sequential `N/YYYY` invoice number stored in `config.yaml`.

**Architecture:** Pure helper functions (testable) live in `src/lib/invoice/finalization.ts`; Tauri I/O lives in `generatePdf.ts`. The `InvoicesTab` gains a "Finalize Invoice…" button that runs the full finalization guard flow and delegates to `generateAndOpenFinalPdf`. `lastInvoice` is a plain `"N/YYYY"` string in `AppConfig`, validated by the existing Zod schema.

**Tech Stack:** TypeScript, React 19, Tauri 2, `@tauri-apps/plugin-fs` (readDir + mkdir), `@tauri-apps/plugin-dialog` (confirm), `@react-pdf/renderer`, Vitest, bun.

---

## Task 1: Add `lastInvoice` to config types, schema, and defaults

**Files:**

- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `src/lib/config/defaults.ts`
- Modify: `config.example.yaml`
- Test: `tests/config/loader.test.ts`

### Step 1: Write failing tests

Add to the end of `tests/config/loader.test.ts`:

```ts
describe('lastInvoice field', () => {
  it('defaults to empty string when absent', () => {
    const cfg = validateConfig({
      calendarUrl: 'https://example.com/cal.ics',
      studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
    });
    expect(cfg.lastInvoice).toBe('');
  });

  it('accepts a valid N/YYYY string', () => {
    const cfg = validateConfig({
      calendarUrl: 'https://example.com/cal.ics',
      lastInvoice: '7/2026',
      studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
    });
    expect(cfg.lastInvoice).toBe('7/2026');
  });

  it('rejects an invalid format', () => {
    expect(() =>
      validateConfig({
        calendarUrl: 'https://example.com/cal.ics',
        lastInvoice: 'bad',
        studios: { Foo: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 80 }] } },
      })
    ).toThrow(/lastInvoice/);
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
bunx vitest run tests/config/loader.test.ts
```

Expected: 3 new failures.

### Step 3: Add `lastInvoice` to `AppConfig` in `src/lib/types.ts`

In the `AppConfig` interface, add after `outputDir`:

```ts
lastInvoice: string; // "N/YYYY" e.g. "7/2026", or "" if unset
```

Also add `invoiceNumber?: string` to the `Invoice` interface (after `totalAmount`):

```ts
invoiceNumber?: string; // set only on finalized invoices, e.g. "8/2026"
```

### Step 4: Add `lastInvoice` to the Zod schema in `src/lib/config/schema.ts`

In `ConfigSchema`, after `outputDir`:

```ts
lastInvoice: z
  .string()
  .default('')
  .refine((v) => v === '' || /^\d+\/\d{4}$/.test(v), {
    message: 'lastInvoice must be in N/YYYY format or empty',
  }),
```

Also update the `config` object built at the bottom of `validateConfig` to include:

```ts
lastInvoice: configData.lastInvoice,
```

### Step 5: Add `lastInvoice` to `src/lib/config/defaults.ts`

In `DEFAULT_CONFIG`, after `outputDir`:

```ts
lastInvoice: '',
```

### Step 6: Add `lastInvoice` to `config.example.yaml`

After `outputDir: ""`:

```yaml
lastInvoice: ''
```

### Step 7: Run tests to confirm they pass

```bash
bunx vitest run tests/config/loader.test.ts
```

Expected: all tests pass including the 3 new ones.

### Step 8: TypeScript check

```bash
bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit
```

Expected: no errors.

### Step 9: Commit

```bash
git add src/lib/types.ts src/lib/config/schema.ts src/lib/config/defaults.ts config.example.yaml tests/config/loader.test.ts
git commit -m "feat: add lastInvoice field to AppConfig and Invoice types"
```

---

## Task 2: Pure finalization helpers

**Files:**

- Create: `src/lib/invoice/finalization.ts`
- Create: `tests/invoice/finalization.test.ts`

### Step 1: Write the test file first

Create `tests/invoice/finalization.test.ts`:

```ts
import {
  parseLastInvoice,
  formatInvoiceNumber,
  studioSlug,
  previewFilename,
  finalizedFilename,
  extractInvoiceNumberFromFilename,
  matchesFinalizedInvoice,
} from '../../src/lib/invoice/finalization';

describe('parseLastInvoice', () => {
  it('parses a valid string', () => {
    expect(parseLastInvoice('7/2026')).toEqual({ n: 7, year: 2026 });
  });
  it('returns null for empty string', () => {
    expect(parseLastInvoice('')).toBeNull();
  });
  it('returns null for invalid format', () => {
    expect(parseLastInvoice('abc')).toBeNull();
    expect(parseLastInvoice('7-2026')).toBeNull();
  });
});

describe('formatInvoiceNumber', () => {
  it('formats n and year correctly', () => {
    expect(formatInvoiceNumber(8, 2026)).toBe('8/2026');
  });
});

describe('studioSlug', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(studioSlug('Yoga Studio GmbH')).toBe('yoga-studio-gmbh');
  });
  it('strips leading and trailing hyphens', () => {
    expect(studioSlug('--Test--')).toBe('test');
  });
});

describe('previewFilename', () => {
  it('returns slug-year-month.pdf', () => {
    expect(previewFilename('Yoga Studio', '2026-01-01', '2026-01-31')).toBe(
      'yoga-studio-2026-01.pdf'
    );
  });
});

describe('finalizedFilename', () => {
  it('encodes invoice number at the start', () => {
    expect(finalizedFilename('yogibar', '2026', '01', '8/2026')).toBe('8-2026-yogibar-2026-01.pdf');
  });
});

describe('extractInvoiceNumberFromFilename', () => {
  it('extracts from a finalized filename', () => {
    expect(extractInvoiceNumberFromFilename('8-2026-yogibar-2026-01.pdf')).toBe('8/2026');
  });
  it('returns null for a preview filename', () => {
    expect(extractInvoiceNumberFromFilename('yogibar-2026-01.pdf')).toBeNull();
  });
});

describe('matchesFinalizedInvoice', () => {
  it('matches the correct studio/period', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      true
    );
  });
  it('does not match a different month', () => {
    expect(matchesFinalizedInvoice('8-2026-yogibar-2026-02.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
  it('does not match a different studio', () => {
    expect(matchesFinalizedInvoice('8-2026-other-2026-01.pdf', 'yogibar', '2026', '01')).toBe(
      false
    );
  });
});
```

### Step 2: Run test to confirm it fails

```bash
bunx vitest run tests/invoice/finalization.test.ts
```

Expected: fails with module not found.

### Step 3: Create `src/lib/invoice/finalization.ts`

```ts
/** Parse "N/YYYY" → { n, year }, or null if invalid/empty. */
export function parseLastInvoice(s: string): { n: number; year: number } | null {
  const m = /^(\d+)\/(\d{4})$/.exec(s);
  if (!m) return null;
  return { n: parseInt(m[1], 10), year: parseInt(m[2], 10) };
}

/** Format a sequential invoice number as "N/YYYY". */
export function formatInvoiceNumber(n: number, year: number): string {
  return `${n}/${year}`;
}

/** Convert a studio name to a URL/filename-safe slug. */
export function studioSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Filename for a preview PDF.
 * e.g. "yogibar-2026-01.pdf"
 */
export function previewFilename(studioName: string, from: string, _to: string): string {
  const slug = studioSlug(studioName);
  const [year, month] = from.split('-');
  return `${slug}-${year}-${month}.pdf`;
}

/**
 * Filename for a finalized PDF. Invoice number is embedded at the start
 * so it can be recovered later without a registry.
 * e.g. "8-2026-yogibar-2026-01.pdf"
 *
 * @param slug       pre-computed studio slug
 * @param periodYear "2026"
 * @param periodMonth "01"
 * @param invoiceNumber "8/2026"
 */
export function finalizedFilename(
  slug: string,
  periodYear: string,
  periodMonth: string,
  invoiceNumber: string
): string {
  const [n, year] = invoiceNumber.split('/');
  return `${n}-${year}-${slug}-${periodYear}-${periodMonth}.pdf`;
}

/**
 * Extract the invoice number from a finalized filename.
 * Returns "8/2026" from "8-2026-yogibar-2026-01.pdf", or null if not a finalized file.
 */
export function extractInvoiceNumberFromFilename(filename: string): string | null {
  const m = /^(\d+)-(\d{4})-/.exec(filename);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Returns true if `filename` is a finalized invoice for the given studio/period.
 * Used to detect an already-finalized invoice before overwriting.
 */
export function matchesFinalizedInvoice(
  filename: string,
  slug: string,
  periodYear: string,
  periodMonth: string
): boolean {
  return filename.endsWith(`-${slug}-${periodYear}-${periodMonth}.pdf`);
}
```

### Step 4: Run tests to confirm they pass

```bash
bunx vitest run tests/invoice/finalization.test.ts
```

Expected: all 10 tests pass.

### Step 5: Run full suite

```bash
bun test
```

Expected: all tests pass.

### Step 6: Commit

```bash
git add src/lib/invoice/finalization.ts tests/invoice/finalization.test.ts
git commit -m "feat: add pure finalization helpers (slug, filenames, invoice number)"
```

---

## Task 3: Update `generatePdf.ts` — Preview subfolder + Final generation

**Files:**

- Modify: `src/lib/pdf/generatePdf.ts`

The existing `invoiceFilename` slug logic is duplicated into `finalization.ts`. This task rewires `generatePdf.ts` to use the shared helpers and adds:

- `generateAndOpenPdf` routes to `{outputDir}/Preview/`
- New `findExistingFinalInvoice` (Tauri readDir)
- New `generateAndOpenFinalPdf` writes to `{outputDir}/Final/`

### Step 1: Rewrite `src/lib/pdf/generatePdf.ts`

```ts
import React from 'react';
import { pdf, type DocumentProps } from '@react-pdf/renderer';
import { writeFile, mkdir, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { Invoice, AppConfig } from '../types';
import { InvoiceDocument } from './InvoiceDocument';
import {
  studioSlug,
  previewFilename,
  finalizedFilename,
  matchesFinalizedInvoice,
  extractInvoiceNumberFromFilename,
} from '../invoice/finalization';

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function renderPdf(invoice: Invoice, config: AppConfig): Promise<Uint8Array> {
  const element = React.createElement(InvoiceDocument, {
    invoice,
    config,
  }) as unknown as React.ReactElement<DocumentProps>;
  const blob = await pdf(element).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

/** Write preview PDF to {outputDir}/Preview/ and open it. */
export async function generateAndOpenPdf(invoice: Invoice, config: AppConfig): Promise<void> {
  const previewDir = `${config.outputDir}/Preview`;
  await ensureDir(previewDir);
  const filename = previewFilename(
    invoice.studioName,
    invoice.invoicePeriod.from,
    invoice.invoicePeriod.to
  );
  const outputPath = `${previewDir}/${filename}`;
  await writeFile(outputPath, await renderPdf(invoice, config));
  await invoke('open_file', { path: outputPath });
}

/**
 * Scan {outputDir}/Final/ for a previously finalized file matching this studio+period.
 * Returns the filename (not full path) if found, or null.
 * Does not throw if the Final directory does not yet exist.
 */
export async function findExistingFinalInvoice(
  outputDir: string,
  slug: string,
  periodYear: string,
  periodMonth: string
): Promise<string | null> {
  const finalDir = `${outputDir}/Final`;
  try {
    const entries = await readDir(finalDir);
    for (const entry of entries) {
      if (
        !entry.isDirectory &&
        entry.name &&
        matchesFinalizedInvoice(entry.name, slug, periodYear, periodMonth)
      ) {
        return entry.name;
      }
    }
  } catch {
    // Final dir doesn't exist yet — treat as no existing file
  }
  return null;
}

/** Write finalized PDF to {outputDir}/Final/ with invoice number embedded in filename. */
export async function generateAndOpenFinalPdf(
  invoice: Invoice,
  config: AppConfig,
  invoiceNumber: string
): Promise<void> {
  const finalDir = `${config.outputDir}/Final`;
  await ensureDir(finalDir);
  const [periodYear, periodMonth] = invoice.invoicePeriod.from.split('-');
  const slug = studioSlug(invoice.studioName);
  const filename = finalizedFilename(slug, periodYear, periodMonth, invoiceNumber);
  const outputPath = `${finalDir}/${filename}`;
  const invoiceWithNumber: Invoice = { ...invoice, invoiceNumber };
  await writeFile(outputPath, await renderPdf(invoiceWithNumber, config));
  await invoke('open_file', { path: outputPath });
}

/** Extract invoice number from a finalized filename (convenience re-export for InvoicesTab). */
export { extractInvoiceNumberFromFilename };
```

### Step 2: TypeScript check

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors. Fix any that arise (most likely missing imports or type mismatches).

### Step 3: Commit

```bash
git add src/lib/pdf/generatePdf.ts
git commit -m "feat: route preview PDFs to Preview/ subfolder, add generateAndOpenFinalPdf"
```

---

## Task 4: Render invoice number in `InvoiceDocument`

**Files:**

- Modify: `src/lib/pdf/InvoiceDocument.tsx`

### Step 1: Add invoice number display

In `InvoiceDocument`, in the header section, after the `<View style={s.headerRow}>` block opens, find where the invoice period section starts (`<View style={s.section}>`) and add a new section **before** the period section:

```tsx
{
  /* Invoice number — only for finalized invoices */
}
{
  invoice.invoiceNumber ? (
    <View style={s.section}>
      <Text style={s.label}>Invoice No.</Text>
      <Text style={{ ...s.value, fontWeight: 'bold' }}>{invoice.invoiceNumber}</Text>
    </View>
  ) : null;
}
```

Place this immediately before the existing `{/* Invoice period */}` `<View style={s.section}>`.

### Step 2: TypeScript check

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

### Step 3: Commit

```bash
git add src/lib/pdf/InvoiceDocument.tsx
git commit -m "feat: render invoice number in PDF when present"
```

---

## Task 5: Tauri capabilities — ensure readDir and mkdir are permitted

**Files:**

- Modify: `src-tauri/capabilities/default.json`

### Step 1: Check current permissions

Open `src-tauri/capabilities/default.json`. The current list includes `"fs:default"` which covers `allow-mkdir` and `allow-read-dir` in Tauri 2's plugin-fs. However, to be explicit and avoid runtime permission errors, add the specific identifiers:

```json
"fs:allow-read-dir",
"fs:allow-mkdir"
```

Add them after `"fs:write-all"`:

```json
"fs:default",
"fs:allow-app-write",
"fs:write-all",
"fs:allow-read-dir",
"fs:allow-mkdir",
"fs:create-app-specific-dirs",
```

### Step 2: Commit

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat: add explicit fs:allow-read-dir and fs:allow-mkdir capabilities"
```

---

## Task 6: Add `lastInvoice` input to RatesTab

**Files:**

- Modify: `src/components/RatesTab/index.tsx`

### Step 1: Add update handler

In `RatesTab`, after the `updateCalendarUrl` function, add:

```ts
function updateLastInvoice(value: string) {
  onUpdate({ ...config, lastInvoice: value });
}
```

### Step 2: Add input field

In the JSX, after the Calendar URL `<label>` block (which closes with `</label>` before the closing `</div>` of the global settings section), add:

```tsx
<h3 className="text-sm font-medium text-gray-700 mt-2">Invoicing</h3>
<label className="flex flex-col gap-1">
  <span className="text-xs text-gray-500">Last invoice number</span>
  <input
    className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-32"
    value={config.lastInvoice}
    onChange={(e) => updateLastInvoice(e.target.value)}
    placeholder="e.g. 7/2026"
  />
  <span className="text-xs text-gray-400">
    The next finalized invoice will use the following number.
  </span>
</label>
```

### Step 3: TypeScript check

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

### Step 4: Commit

```bash
git add src/components/RatesTab/index.tsx
git commit -m "feat: add last invoice number field to RatesTab settings"
```

---

## Task 7: Add "Finalize Invoice…" button and flow to InvoicesTab

**Files:**

- Modify: `src/components/InvoicesTab/index.tsx`

### Step 1: Add imports at the top

Add to the existing imports:

```ts
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  generateAndOpenFinalPdf,
  findExistingFinalInvoice,
  extractInvoiceNumberFromFilename,
} from '../../lib/pdf/generatePdf';
import { parseLastInvoice, formatInvoiceNumber, studioSlug } from '../../lib/invoice/finalization';
```

### Step 2: Add `handleFinalize` function

Add after `handleGenerate`:

```ts
async function handleFinalize(row: InvoiceRow) {
  if (!config.outputDir) {
    setRowError('Set an output folder first.');
    return;
  }
  if (!config.lastInvoice) {
    setRowError('Set a last invoice number in Settings first (e.g. 0/2026).');
    return;
  }

  const [periodYear, periodMonth] = row.monthKey.split('-');
  const currentYear = new Date().getFullYear().toString();
  if (periodYear !== currentYear) {
    setRowError(
      `Invoice period year (${periodYear}) doesn't match current year (${currentYear}). Update the period or the last invoice number.`
    );
    return;
  }

  const parsed = parseLastInvoice(config.lastInvoice);
  if (!parsed) {
    setRowError('Invalid last invoice number — expected N/YYYY format.');
    return;
  }

  const rowKey = `${row.studioName}__${row.monthKey}`;
  setGenerating(rowKey);
  setRowError(null);

  try {
    const studioConfig = config.studios[row.studioName];
    if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);

    const period = periodForMonthKey(row.monthKey);
    const { invoice } = generateInvoice(row.studioName, row.classes, studioConfig, period);

    const slug = studioSlug(row.studioName);
    const existingFilename = await findExistingFinalInvoice(
      config.outputDir,
      slug,
      periodYear,
      periodMonth
    );

    let invoiceNumber: string;
    let shouldIncrement = true;

    if (existingFilename) {
      const existingNumber =
        extractInvoiceNumberFromFilename(existingFilename) ?? config.lastInvoice;
      const overwrite = await confirm(
        `Invoice ${existingNumber} is already finalized for this period.\n\nOverwrite? The invoice number will be reused — the counter will not increment.`,
        { title: 'Invoice already finalized', kind: 'warning' }
      );
      if (!overwrite) return;
      invoiceNumber = existingNumber;
      shouldIncrement = false;
    } else {
      invoiceNumber = formatInvoiceNumber(parsed.n + 1, parsed.year);
    }

    await generateAndOpenFinalPdf(invoice, config, invoiceNumber);

    if (shouldIncrement) {
      await onSaveConfig({ ...config, lastInvoice: invoiceNumber });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`Finalization failed for ${row.studioName}: ${msg}`);
    setRowError(msg);
  } finally {
    setGenerating(null);
  }
}
```

### Step 3: Add the button to each row

In the table row JSX, the existing `<td className="py-2 text-right">` contains only the "Generate Invoice…" button. Replace it with two buttons:

```tsx
<td className="py-2 text-right">
  <div className="flex items-center justify-end gap-2">
    <button
      onClick={() => handleGenerate(row)}
      disabled={!studioConfig || generating !== null}
      className="text-xs px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
    >
      {generating === rowKey ? 'Generating…' : 'Generate Invoice…'}
    </button>
    <button
      onClick={() => handleFinalize(row)}
      disabled={!studioConfig || generating !== null}
      className="text-xs px-3 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
    >
      {generating === rowKey ? 'Finalizing…' : 'Finalize Invoice…'}
    </button>
  </div>
</td>
```

Note: the loading label for both buttons shows the same `generating === rowKey` — only one can be active at a time (shared `generating` state), so this is correct.

### Step 4: TypeScript check

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

### Step 5: Run full unit test suite

```bash
bun test
```

Expected: all 40+ tests pass.

### Step 6: Commit

```bash
git add src/components/InvoicesTab/index.tsx
git commit -m "feat: add Finalize Invoice button with sequential invoice number flow"
```

---

## Task 8: Browser smoke test

This task verifies the UI changes work correctly in the Vite dev server. Tauri-specific features (file write, open, readDir) can only be fully verified with `bun run dev`.

### Step 1: Start Vite dev server

```bash
bun run dev:vite
```

### Step 2: Open browser and navigate

Navigate to `http://localhost:1420`.

### Step 3: Check for console errors

Use Playwright `browser_console_messages` at level `error`. Expected: no errors.

### Step 4: Verify RatesTab

- Go to "Rates & Config" tab
- Confirm "Invoicing" section and "Last invoice number" input are visible
- Type `7/2026` into the field — confirm it accepts the value

### Step 5: Verify InvoicesTab

- Go to "Invoices" tab
- Confirm each row shows both "Generate Invoice…" (indigo) and "Finalize Invoice…" (green) buttons side by side

### Step 6: Kill dev server

```bash
pkill -f "vite"
```

Or kill by PID from `lsof -i :1420`.

### Step 7: Commit memory update if any patterns were discovered

If any surprises were found during smoke test, update `docs/plans/` or `MEMORY.md` accordingly.

---

## Summary of all changed files

| File                                   | Change                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/types.ts`                     | +`lastInvoice` on AppConfig, +`invoiceNumber?` on Invoice                          |
| `src/lib/config/schema.ts`             | +`lastInvoice` Zod field with regex validation                                     |
| `src/lib/config/defaults.ts`           | +`lastInvoice: ''`                                                                 |
| `config.example.yaml`                  | +`lastInvoice: ""`                                                                 |
| `src/lib/invoice/finalization.ts`      | New — pure helpers (slug, filenames, parse/format)                                 |
| `src/lib/pdf/generatePdf.ts`           | Rewired — Preview subfolder, `generateAndOpenFinalPdf`, `findExistingFinalInvoice` |
| `src/lib/pdf/InvoiceDocument.tsx`      | Render `invoice.invoiceNumber` when present                                        |
| `src-tauri/capabilities/default.json`  | +`fs:allow-read-dir`, +`fs:allow-mkdir`                                            |
| `src/components/RatesTab/index.tsx`    | +lastInvoice input field                                                           |
| `src/components/InvoicesTab/index.tsx` | +`handleFinalize`, +"Finalize Invoice…" button                                     |
| `tests/config/loader.test.ts`          | +3 tests for lastInvoice validation                                                |
| `tests/invoice/finalization.test.ts`   | New — 10 unit tests for pure helpers                                               |
