# Invoice Finalization Flow — Design

**Date:** 2026-03-02
**Status:** Approved

## Overview

Introduce a two-tier output structure (Preview / Final) for generated PDFs, with finalized invoices carrying a sequential invoice number stored in `config.yaml`.

---

## Config Layer

- Add `lastInvoice?: string` to `AppConfig` (and `DEFAULT_CONFIG`).
- Format: `"N/YYYY"` — e.g. `"7/2026"`.
- Schema: optional field, validated against `/^\d+\/\d{4}$/` or empty string.
- Displayed and editable as a plain text input in the RatesTab global settings section.
- `config.example.yaml` gets `lastInvoice: ""`.

---

## Folder Structure

Both output subfolders live under `config.outputDir`:

| Purpose | Path                   |
| ------- | ---------------------- |
| Preview | `{outputDir}/Preview/` |
| Final   | `{outputDir}/Final/`   |

Both directories are created recursively on first write if they do not exist.

The existing "Generate Invoice…" button is updated to route into `Preview/`.

---

## Filename Format

**Preview** (studio slug + period, unchanged logic):

```
yogibar-2026-01.pdf
```

**Final** (invoice number prepended):

```
8-2026-yogibar-2026-01.pdf
```

Pattern: `{N}-{YYYY}-{studio-slug}-{period-year}-{period-month}.pdf`

The invoice number is recoverable from the filename via regex: `/^(\d+)-(\d{4})-/`.

---

## Invoice Type & PDF

- Add `invoiceNumber?: string` to the `Invoice` type.
- `InvoiceDocument` renders "Invoice No. {invoiceNumber}" when the field is present.

---

## Finalization Flow

1. User clicks **"Finalize Invoice…"** on a row.
2. **Year check:** if `invoice period year ≠ current year` → error dialog, abort.
3. **`lastInvoice` check:** if empty → error "Set a last invoice number in Settings first", abort.
4. Parse `N` from `lastInvoice`. Candidate = `N+1`, candidate string = `"${N+1}/${currentYear}"`.
5. **Existence check:** scan `{outputDir}/Final/` for `*-{studio-slug}-{period-year}-{period-month}.pdf`.
   - **Found:** extract invoice number from filename → confirm dialog:
     _"Invoice {foundNum} already finalized. Overwrite? The invoice number will be reused — the counter will not increment."_
     → Cancel: abort. Confirm: use `foundNum`, skip counter increment.
   - **Not found:** proceed with candidate number, will increment counter.
6. Generate PDF with `invoiceNumber` set, write to `Final/` subfolder, open file.
7. If counter should increment: save updated `lastInvoice` to config via `onSaveConfig`.

---

## UI Changes

### InvoicesTab

- Each row: add **"Finalize Invoice…"** button to the right of "Generate Invoice…".
- Both buttons share `generating` state (only one active at a time).
- Finalize button styled with a green tint to distinguish from preview (indigo).

### RatesTab

- Add **"Last invoice number"** text input in the global settings section.
- Placeholder: `e.g. 7/2026`.
- Validated on blur (must match `N/YYYY` or be empty).

---

## Error States

| Condition                        | Behaviour                                        |
| -------------------------------- | ------------------------------------------------ |
| Period year ≠ current year       | Error dialog, no action                          |
| `lastInvoice` not set            | Error message in UI, no action                   |
| Final file exists, user cancels  | Abort, no change                                 |
| Final file exists, user confirms | Overwrite with same number, no counter increment |
| Output dir not set               | Existing "Set an output folder first" guard      |

---

## Out of Scope

- No registry/ledger in config beyond `lastInvoice`.
- No CLI support for finalization (Tauri-only feature).
- No batch finalization (one row at a time).
