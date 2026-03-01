# Extended Config Fields Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add teacher contact/bank info and studio full name + address to `AppConfig`, surface them in the RatesTab UI, and render them in the PDF invoice.

**Architecture:** Restructure `AppConfig.teacherName` → `AppConfig.teacher: TeacherInfo` (breaking change); add `fullName` + `address` to `StudioConfig`. All new fields optional (empty string default). Schema validator is lenient; PDF renders whatever is set.

**Tech Stack:** TypeScript, Vitest, React, @react-pdf/renderer, yaml

---

### Task 1: Update type definitions

**Files:**
- Modify: `src/lib/types.ts`

The `AppConfig` interface currently has a flat `teacherName: string`. Replace it with a nested `teacher: TeacherInfo` object. Also add `fullName` and `address` to `StudioConfig`.

**Step 1: Edit `src/lib/types.ts`**

Replace the `StudioConfig` and `AppConfig` interfaces, and add two new interfaces:

```ts
export interface BankDetails {
  accountOwner: string;
  iban: string;
  bic: string;
}

export interface TeacherInfo {
  name: string;
  address: string;     // free-form, newlines allowed
  taxNumber: string;
  bankDetails: BankDetails;
}

export interface StudioConfig {
  fullName: string;    // display name for PDF; key is still the calendar match string
  address: string;
  rateTiers: RateTier[];
}

export interface AppConfig {
  teacher: TeacherInfo;
  calendarUrl: string;
  outputDir: string;
  studios: Record<string, StudioConfig>;
}
```

**Step 2: Check TypeScript errors across the whole project**

```bash
npx tsc --project tsconfig.json --noEmit 2>&1 | head -40
npx tsc --project tsconfig.app.json --noEmit 2>&1 | head -40
```

Expected: errors in schema.ts, defaults.ts, RatesTab, InvoiceDocument, and the two test files — these are all fixed in subsequent tasks. Note the error list; don't fix anything yet.

**Step 3: Commit the type-only change**

```bash
git add src/lib/types.ts
git commit -m "refactor: restructure AppConfig types for teacher info and studio details"
```

---

### Task 2: Update tests to use the new type shape (they will fail)

**Files:**
- Modify: `tests/config/serialization.test.ts`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/fixtures/config.yaml`

The tests reference `config.teacherName` and `SAMPLE_CONFIG.teacherName`. Update them to use the new shape first — they will fail until the schema is updated in Task 3.

**Step 1: Update `tests/fixtures/config.yaml`**

```yaml
calendarUrl: "https://calendar.google.com/calendar/ical/example/basic.ics"
studios:
  "Zen Yoga":
    fullName: "Zen Yoga Center"
    address: "789 Peace St\nHamburg"
    rateTiers:
      - { minStudents: 1, maxStudents: 5, rate: 80 }
      - { minStudents: 6, maxStudents: 10, rate: 100 }
      - { minStudents: 11, maxStudents: null, rate: 120 }
  "Power House":
    fullName: "Power House Gym"
    address: "101 Fitness Ave\nBerlin"
    rateTiers:
      - { minStudents: 1, maxStudents: 3, rate: 60 }
      - { minStudents: 4, maxStudents: 8, rate: 90 }
      - { minStudents: 9, maxStudents: null, rate: 110 }
```

**Step 2: Update `tests/config/loader.test.ts`**

Replace line 12 (`expect(config.teacherName).toBe('');`) with:

```ts
expect(config.teacher.name).toBe('');
expect(config.teacher.taxNumber).toBe('');
expect(config.teacher.bankDetails.iban).toBe('');
```

**Step 3: Update `tests/config/serialization.test.ts`**

Replace the `SAMPLE_CONFIG` constant and the `teacherName` assertion:

```ts
const SAMPLE_CONFIG: AppConfig = {
  teacher: {
    name: 'Test Teacher',
    address: '123 Main St\nCity 12345',
    taxNumber: 'DE123456789',
    bankDetails: {
      accountOwner: 'Test Teacher',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    },
  },
  calendarUrl: 'https://calendar.google.com/calendar/ical/example%40group.calendar.google.com/basic.ics',
  outputDir: '/tmp/invoices',
  studios: {
    Yogibar: {
      fullName: 'Yogibar Yoga Studio GmbH',
      address: '456 Yoga Lane\nMunich',
      rateTiers: [
        { minStudents: 1,  maxStudents: 5,    rate: 80  },
        { minStudents: 6,  maxStudents: 10,   rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
};
```

Replace the `reparsed.teacherName` assertion (line 29):
```ts
expect(reparsed.teacher.name).toBe(SAMPLE_CONFIG.teacher.name);
expect(reparsed.teacher.bankDetails.iban).toBe(SAMPLE_CONFIG.teacher.bankDetails.iban);
expect(reparsed.studios.Yogibar.fullName).toBe('Yogibar Yoga Studio GmbH');
expect(reparsed.studios.Yogibar.address).toBe('456 Yoga Lane\nMunich');
```

**Step 4: Run tests to confirm they fail**

```bash
npm test 2>&1 | tail -20
```

Expected: test failures referencing `teacher` not being found, `teacherName` undefined, etc. This is correct — the schema hasn't been updated yet.

**Step 5: Commit the updated tests**

```bash
git add tests/config/serialization.test.ts tests/config/loader.test.ts tests/fixtures/config.yaml
git commit -m "test: update config tests for teacher object and studio fullName/address"
```

---

### Task 3: Update the config schema to parse the new shape

**Files:**
- Modify: `src/lib/config/schema.ts`

`validateConfig` currently reads `obj.teacherName`. Replace it to parse the nested `teacher` object and the new studio fields.

**Step 1: Edit `src/lib/config/schema.ts`**

Update the imports at the top to include the new types:

```ts
import { AppConfig, RateTier, TeacherInfo, BankDetails, AppError } from "../types.js";
```

Replace the `teacherName`/`outputDir` block and the `AppConfig` construction in `validateConfig`:

```ts
// Parse teacher object (all fields optional)
const teacherRaw = (typeof obj.teacher === 'object' && obj.teacher !== null)
  ? obj.teacher as Record<string, unknown>
  : {};
const bankRaw = (typeof teacherRaw.bankDetails === 'object' && teacherRaw.bankDetails !== null)
  ? teacherRaw.bankDetails as Record<string, unknown>
  : {};

const teacher: TeacherInfo = {
  name:       typeof teacherRaw.name      === 'string' ? teacherRaw.name      : '',
  address:    typeof teacherRaw.address   === 'string' ? teacherRaw.address   : '',
  taxNumber:  typeof teacherRaw.taxNumber === 'string' ? teacherRaw.taxNumber : '',
  bankDetails: {
    accountOwner: typeof bankRaw.accountOwner === 'string' ? bankRaw.accountOwner : '',
    iban:         typeof bankRaw.iban         === 'string' ? bankRaw.iban         : '',
    bic:          typeof bankRaw.bic          === 'string' ? bankRaw.bic          : '',
  },
};

const outputDir = typeof obj.outputDir === 'string' ? obj.outputDir : '';

// ... (calendarUrl and studios validation unchanged up to here)

const config: AppConfig = {
  teacher,
  calendarUrl: obj.calendarUrl,
  outputDir,
  studios: {},
};
```

In the studio loop, replace the final `config.studios[name] = { rateTiers: ... }` line:

```ts
config.studios[name] = {
  fullName: typeof studio.fullName === 'string' ? studio.fullName : '',
  address:  typeof studio.address  === 'string' ? studio.address  : '',
  rateTiers: tiers.sort((a, b) => a.minStudents - b.minStudents),
};
```

**Step 2: Run the tests — they should now pass**

```bash
npm test
```

Expected: all tests pass (31+ tests).

**Step 3: Type-check**

```bash
npx tsc --project tsconfig.json --noEmit 2>&1 | grep -v "^$"
```

Expected: errors only in `defaults.ts`, `RatesTab`, `InvoiceDocument` (not yet updated) — no errors in `schema.ts` or test files.

**Step 4: Commit**

```bash
git add src/lib/config/schema.ts
git commit -m "feat: update config schema to parse teacher object and studio fullName/address"
```

---

### Task 4: Update defaults and example config

**Files:**
- Modify: `src/lib/config/defaults.ts`
- Modify: `config.example.yaml`

**Step 1: Edit `src/lib/config/defaults.ts`**

Replace the entire `DEFAULT_CONFIG`:

```ts
import { AppConfig } from '../types';

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
  calendarUrl: 'https://calendar.google.com/calendar/ical/ca97afba7cedbe03060b5a536c3637d379c891f93c3afa7b8bae9ec1972552aa%40group.calendar.google.com/private-8a00bedadf09be027a0265c7e8cbb0b1/basic.ics',
  outputDir: '',
  studios: {
    'Yogibar': {
      fullName: '',
      address: '',
      rateTiers: [
        { minStudents: 1,  maxStudents: 5,    rate: 80  },
        { minStudents: 6,  maxStudents: 10,   rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
};
```

**Step 2: Edit `config.example.yaml`**

Replace entire file:

```yaml
teacher:
  name: "Your Name"
  address: "Your Street 1\n12345 Your City\nYour Country"
  taxNumber: "DE123456789"
  bankDetails:
    accountOwner: "Your Name"
    iban: "DE89 3704 0044 0532 0130 00"
    bic: "COBADEFFXXX"
calendarUrl: "https://calendar.google.com/calendar/ical/YOUR_CALENDAR_ID/basic.ics"
outputDir: ""
studios:
  "Yogibar":
    fullName: "Yogibar Yoga Studio GmbH"
    address: "Studio Street 42\n80331 Munich\nGermany"
    rateTiers:
      - { minStudents: 1,  maxStudents: 5,    rate: 80  }
      - { minStudents: 6,  maxStudents: 10,   rate: 100 }
      - { minStudents: 11, maxStudents: null, rate: 120 }
```

**Step 3: Run tests and type-check**

```bash
npm test
npx tsc --project tsconfig.app.json --noEmit 2>&1 | grep -v "^$"
```

Expected: tests pass; type errors only in `RatesTab` and `InvoiceDocument`.

**Step 4: Commit**

```bash
git add src/lib/config/defaults.ts config.example.yaml
git commit -m "feat: update defaults and example config for teacher object structure"
```

---

### Task 5: Update the RatesTab UI

**Files:**
- Modify: `src/components/RatesTab/index.tsx`

The global section currently has `teacherName` and `calendarUrl` inputs. Expand it to cover all teacher fields. The `StudioCard` needs `fullName` and `address` inputs.

**Step 1: Edit `src/components/RatesTab/index.tsx`**

Replace the `updateGlobal` function and add new updaters:

```ts
function updateTeacher(key: keyof Omit<TeacherInfo, 'bankDetails'>, value: string) {
  onUpdate({ ...config, teacher: { ...config.teacher, [key]: value } });
}
function updateBank(key: keyof BankDetails, value: string) {
  onUpdate({ ...config, teacher: { ...config.teacher, bankDetails: { ...config.teacher.bankDetails, [key]: value } } });
}
function updateCalendarUrl(value: string) {
  onUpdate({ ...config, calendarUrl: value });
}
```

Add a new `onUpdateField` prop to `StudioCardProps` and `StudioCard`:

```ts
interface StudioCardProps {
  // ... existing props ...
  onUpdateField: (studioName: string, field: 'fullName' | 'address', value: string) => void;
}
```

Add the handler in `RatesTab`:

```ts
function updateStudioField(studioName: string, field: 'fullName' | 'address', value: string) {
  onUpdate({ ...config, studios: { ...config.studios, [studioName]: { ...config.studios[studioName], [field]: value } } });
}
```

Inside `StudioCard`, add `fullName` and `address` inputs above the rate tiers table:

```tsx
<label className="flex flex-col gap-1">
  <span className="text-xs text-gray-400">Full name (for invoice)</span>
  <input
    className="border border-gray-200 rounded px-2 py-1 text-sm"
    value={studio.fullName}
    onChange={e => onUpdateField(studioName, 'fullName', e.target.value)}
    placeholder="e.g. Yogibar Yoga Studio GmbH"
  />
</label>
<label className="flex flex-col gap-1">
  <span className="text-xs text-gray-400">Address</span>
  <textarea
    className="border border-gray-200 rounded px-2 py-1 text-sm resize-none"
    rows={2}
    value={studio.address}
    onChange={e => onUpdateField(studioName, 'address', e.target.value)}
    placeholder="Street, City"
  />
</label>
```

Replace the global section in `RatesTab`:

```tsx
<div className="flex flex-col gap-3 p-4 rounded border border-gray-200">
  <h3 className="text-sm font-medium text-gray-700">Teacher</h3>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">Name</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm"
      value={config.teacher.name}
      onChange={e => updateTeacher('name', e.target.value)} />
  </label>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">Address</span>
    <textarea className="border border-gray-200 rounded px-2 py-1 text-sm resize-none" rows={3}
      value={config.teacher.address}
      onChange={e => updateTeacher('address', e.target.value)} />
  </label>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">Tax number</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm"
      value={config.teacher.taxNumber}
      onChange={e => updateTeacher('taxNumber', e.target.value)} />
  </label>

  <h3 className="text-sm font-medium text-gray-700 mt-2">Bank details</h3>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">Account owner</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm"
      value={config.teacher.bankDetails.accountOwner}
      onChange={e => updateBank('accountOwner', e.target.value)} />
  </label>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">IBAN</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm font-mono tracking-wide"
      value={config.teacher.bankDetails.iban}
      onChange={e => updateBank('iban', e.target.value)} />
  </label>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">BIC</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
      value={config.teacher.bankDetails.bic}
      onChange={e => updateBank('bic', e.target.value)} />
  </label>

  <h3 className="text-sm font-medium text-gray-700 mt-2">Calendar</h3>
  <label className="flex flex-col gap-1">
    <span className="text-xs text-gray-500">Calendar URL (ICS)</span>
    <input className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
      value={config.calendarUrl}
      onChange={e => updateCalendarUrl(e.target.value)} />
  </label>
</div>
```

Also add the `import` for `BankDetails` and `TeacherInfo` at the top of the file:
```ts
import { AppConfig, RateTier, StudioConfig, TeacherInfo, BankDetails } from '../../lib/types';
```

**Step 2: Type-check the frontend**

```bash
npx tsc --project tsconfig.app.json --noEmit 2>&1 | grep -v "^$"
```

Expected: errors only in `InvoiceDocument.tsx` now.

**Step 3: Commit**

```bash
git add src/components/RatesTab/index.tsx
git commit -m "feat: update RatesTab with teacher and studio address fields"
```

---

### Task 6: Update the PDF invoice template

**Files:**
- Modify: `src/lib/pdf/InvoiceDocument.tsx`

Add teacher contact info (top-left), studio info (top-right), and bank details (footer).

**Step 1: Edit `src/lib/pdf/InvoiceDocument.tsx`**

Add new style entries to the `StyleSheet.create` call:

```ts
const s = StyleSheet.create({
  // ... keep all existing entries, add: ...
  headerRow:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 32 },
  addressBlock:{ flex: 1 },
  addressText: { fontSize: 9, color: '#444', lineHeight: 1.5 },
  footer:      { marginTop: 32, paddingTop: 12, borderTopWidth: 0.5, borderColor: '#ddd' },
  footerLabel: { fontSize: 7, color: '#aaa', textTransform: 'uppercase', marginBottom: 1 },
  footerValue: { fontSize: 8, color: '#555', marginBottom: 6 },
  footerRow:   { flexDirection: 'row', gap: 32 },
});
```

Replace the `<View style={s.header}>` block with a two-column header plus a footer:

```tsx
export function InvoiceDocument({ invoice, config }: Props) {
  const { teacher } = config;
  const studio = config.studios[invoice.studioName];
  const studioDisplay = studio?.fullName || invoice.studioName;
  const studioAddress = studio?.address || '';

  return (
    <Document>
      <Page size="A4" style={s.page}>

        {/* Two-column header */}
        <View style={s.headerRow}>
          <View style={s.addressBlock}>
            <Text style={s.title}>{teacher.name || 'Invoice'}</Text>
            {teacher.address ? (
              <Text style={s.addressText}>{teacher.address}</Text>
            ) : null}
            {teacher.taxNumber ? (
              <Text style={s.addressText}>Tax no.: {teacher.taxNumber}</Text>
            ) : null}
          </View>
          <View style={[s.addressBlock, { alignItems: 'flex-end' }]}>
            <Text style={{ fontSize: 11, fontWeight: 'bold', marginBottom: 4 }}>{studioDisplay}</Text>
            {studioAddress ? (
              <Text style={[s.addressText, { textAlign: 'right' }]}>{studioAddress}</Text>
            ) : null}
          </View>
        </View>

        {/* Invoice period */}
        <View style={s.section}>
          <Text style={s.label}>Invoice period</Text>
          <Text style={s.value}>{invoice.invoicePeriod.from} — {invoice.invoicePeriod.to}</Text>
        </View>

        {/* Class table — unchanged */}
        <View style={s.table}>
          <View style={s.tableHead}>
            <Text style={s.col}>Date</Text>
            <Text style={s.col}>Time</Text>
            <Text style={s.col}>Class</Text>
            <Text style={s.colRight}>Students</Text>
            <Text style={s.colRight}>Rate (€)</Text>
            <Text style={s.colRight}>Total (€)</Text>
          </View>
          {invoice.classes.map((item, i) => (
            <View key={i} style={s.tableRow}>
              <Text style={s.col}>{item.date}</Text>
              <Text style={s.col}>{item.startTime}–{item.endTime}</Text>
              <Text style={s.col}>{item.classType}</Text>
              <Text style={s.colRight}>{item.studentCount}</Text>
              <Text style={s.colRight}>{item.rateApplied}</Text>
              <Text style={s.colRight}>{item.lineTotal}</Text>
            </View>
          ))}
        </View>

        {/* Total */}
        <View style={s.total}>
          <Text>Total: €{invoice.totalAmount}</Text>
        </View>

        {/* Bank details footer */}
        {(teacher.bankDetails.iban || teacher.bankDetails.bic) ? (
          <View style={s.footer}>
            <View style={s.footerRow}>
              {teacher.bankDetails.accountOwner ? (
                <View>
                  <Text style={s.footerLabel}>Account owner</Text>
                  <Text style={s.footerValue}>{teacher.bankDetails.accountOwner}</Text>
                </View>
              ) : null}
              {teacher.bankDetails.iban ? (
                <View>
                  <Text style={s.footerLabel}>IBAN</Text>
                  <Text style={s.footerValue}>{teacher.bankDetails.iban}</Text>
                </View>
              ) : null}
              {teacher.bankDetails.bic ? (
                <View>
                  <Text style={s.footerLabel}>BIC</Text>
                  <Text style={s.footerValue}>{teacher.bankDetails.bic}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

      </Page>
    </Document>
  );
}
```

**Step 2: Full type-check and tests**

```bash
npm test
npx tsc --project tsconfig.app.json --noEmit
npx tsc --project tsconfig.json --noEmit
```

Expected: all tests pass, zero type errors.

**Step 3: Commit**

```bash
git add src/lib/pdf/InvoiceDocument.tsx
git commit -m "feat: render teacher address, tax number, studio info, and bank details in PDF"
```

---

### Task 7: Browser smoke test

**Files:** none (verification only)

**Step 1: Start the Vite dev server**

```bash
npm run dev:vite &
```

Wait ~3 seconds for it to start.

**Step 2: Open in browser and check console**

Navigate to `http://localhost:1420`. Check for errors:

```
browser_console_messages level=error
```

Expected: no errors.

**Step 3: Screenshot the Rates & Config tab**

Click the "Rates & Config" tab. Verify:
- Teacher section shows Name, Address (textarea), Tax number
- Bank Details section shows Account owner, IBAN (monospace), BIC (monospace)
- Calendar section shows the ICS URL input
- Each studio card shows Full name and Address fields above the rate tiers table

**Step 4: Exercise dirty state**

Edit the teacher name field. Verify the "Unsaved changes" indicator appears. Click Save.

**Step 5: Kill dev server**

```bash
pkill -f "vite"
```

---
