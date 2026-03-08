# Missing Student Count Indicator Design

## Goal

Surface a visual warning for past classes with missing student counts, and block invoice generation for studio/month groups that contain such classes.

## Changes

### 1. CalendarTab — EventChip visual indicator

Classes where `studentCount === 0` and `date < today` get a new visual state:

- Icon: `⚠` with amber styling (dashed border, amber-50 bg, amber-700 text)
- Tooltip: `"{studioName} — missing student count"`
- Visually distinct from red `❓` (ambiguous count) and gray `⚠` (unconfigured studio)

No change for future classes (`date >= today`) — they render normally since students haven't attended yet.

### 2. InvoicesTab — blocked row with disabled buttons

For each studio/month row, check: `row.classes.some(c => c.studentCount === 0 && c.date < todayString)`.

If true:

- Disable all action buttons (Generate Invoice, Finalize Invoice, Draft Email)
- Show amber `⚠` indicator next to the row with tooltip: "N class(es) missing student count"
- Buttons stay visually grayed out so the user understands why they can't proceed

### No data layer changes

`studentCount: 0` is already set by the parser for missing counts. We're only surfacing it in the UI.
