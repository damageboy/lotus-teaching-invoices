# Design: Extended Config Fields for PDF Invoices

**Date:** 2026-03-01
**Status:** Approved

## Problem

The PDF invoice currently shows only the teacher name and studio key. To produce professional invoices, the template needs teacher contact info, tax number, bank payment details, and the studio's full legal name and address.

## Solution

Restructure `AppConfig` to group all teacher info under a `teacher` object, and extend `StudioConfig` with `fullName` and `address`. All new fields are optional (empty string default) so existing configs load without changes.

## Data Model

```ts
interface BankDetails {
  accountOwner: string;
  iban: string;
  bic: string;
}

interface TeacherInfo {
  name: string;
  address: string; // free-form, newlines allowed
  taxNumber: string;
  bankDetails: BankDetails;
}

interface StudioConfig {
  fullName: string; // display name for PDF; key remains calendar match key
  address: string;
  rateTiers: RateTier[];
}

interface AppConfig {
  teacher: TeacherInfo; // replaces teacherName
  calendarUrl: string;
  outputDir: string;
  studios: Record<string, StudioConfig>;
}
```

## Config YAML Shape

```yaml
teacher:
  name: Jane Doe
  address: "123 Main St\nCity 12345"
  taxNumber: DE123456789
  bankDetails:
    accountOwner: Jane Doe
    iban: DE89 3704 0044 0532 0130 00
    bic: COBADEFFXXX
calendarUrl: https://...
outputDir: ./invoices
studios:
  Yogibar:
    fullName: Yogibar Yoga Studio GmbH
    address: "456 Yoga Lane\nMunich"
    rateTiers:
      - { minStudents: 1, maxStudents: 5, rate: 80 }
```

## Files to Change

| File                                | Change                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `src/lib/types.ts`                  | Add `BankDetails`, `TeacherInfo`; update `AppConfig`, `StudioConfig`             |
| `src/lib/config/schema.ts`          | Parse `teacher` object; parse `fullName`/`address` in studio loop                |
| `src/lib/config/defaults.ts`        | Restructure `DEFAULT_CONFIG`                                                     |
| `src/components/RatesTab/index.tsx` | Add `teacher.*` fields to global section; add `fullName`/`address` to StudioCard |
| `src/lib/pdf/InvoiceDocument.tsx`   | Render teacher address, tax number, bank details, studio address                 |
| `config.example.yaml`               | Update example                                                                   |
| `tests/fixtures/config.yaml`        | Update fixture                                                                   |
| `tests/`                            | Fix any references to `config.teacherName`                                       |

## PDF Layout

- **Header:** teacher name + address (top-left), studio full name + address (top-right)
- **Body:** invoice period, class line items table (unchanged)
- **Footer:** tax number, bank details (account owner, IBAN, BIC)

## Constraints

- All new fields are optional — validation accepts empty strings
- The studio key (map key in YAML) remains the calendar match string; `fullName` is display-only
- No changes to CLI JSON output format
