# src/components/CalendarTab

| File                  | Purpose                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CalendarGrid.tsx`    | Exports desktop `CalendarGrid`; consumes shared `buildMonthGrid` model and preserves chronological lesson rendering. See change: cross-platform-dedup.                         |
| `index.tsx`           | Exports `CalendarTab`; owns shared month selection/stats and switches desktop/mobile presenters. See change: cross-platform-dedup.                                             |
| `mobile-calendar.ts`  | Exports calendar derivations, `MONTH_NAMES`, `WEEKDAYS`, and `buildMonthGrid`; preserves Monday-first padded cells and lesson status counts. See change: cross-platform-dedup. |
| `MobileCalendar.tsx`  | Exports mobile calendar presenter; consumes shared month names and month-grid children. See change: cross-platform-dedup.                                                      |
| `MobileMonthGrid.tsx` | Exports touch calendar grid; consumes shared `buildMonthGrid` model and preserves focus/date selection behavior. See change: cross-platform-dedup.                             |
