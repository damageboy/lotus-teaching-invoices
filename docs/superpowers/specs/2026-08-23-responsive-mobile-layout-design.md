# Responsive Mobile Layout Design

**Date:** 2026-08-23

**Status:** Approved direction; implementation pending

## Goal

Give the existing Tauri application a phone-specific presentation that matches the approved Android mock-ups while keeping the current desktop presentation and application behavior intact.

The mobile application uses:

- the agenda-first Calendar screen as its default;
- the compact month grid and lesson sheet as a secondary Calendar mode;
- the invoice-first card presentation for Invoices;
- persistent bottom navigation for Calendar, Invoices, Income, and Settings.

All calendar synchronization, editing, invoice calculations, freshness checks, Google authorization, and configuration state remain shared with desktop.

## Scope

This change implements the responsive application shell and phone layouts. It does not replace the existing Android OAuth work, introduce cloud configuration synchronization, or implement Android-native PDF sharing. Mobile invoice actions must call the existing handlers and display their real success or error states; the UI must not simulate unavailable behavior.

The desktop layout at widths of 768 CSS pixels and above remains unchanged. Widths below 768 pixels use the mobile shell. This also makes a narrow desktop window useful without coupling presentation directly to the operating system.

## Visual Sources

### Calendar agenda

The agenda-first mock-up defines the default mobile Calendar screen:

- compact lotus-branded top bar;
- visible synchronization state and refresh action;
- month navigation;
- horizontal date strip with a distinct selected date and quieter today state;
- monthly class and expected-income summary;
- touch-sized lesson rows showing time, studio, class type, students, and expected income;
- a clear action that opens lesson details.

### Calendar month

The month-grid mock-up defines the secondary Calendar mode:

- readable seven-column month grid;
- event dots or short color bars instead of desktop event chips;
- distinct selected-date and today treatments;
- studio legend;
- lesson details presented as a bottom sheet rather than a desktop-positioned popover.

### Invoices

The invoice-first mock-up defines the mobile Invoices screen:

- month context and navigation;
- one vertically grouped invoice card per studio and month;
- visible studio, period, invoice number when available, class count, total, and freshness state;
- prominent Preview, Finalize/Re-finalize, and Draft Email actions when the existing state allows them;
- no desktop table compressed into the phone viewport.

## Architecture

`App` continues to own configuration, calendar data, Google authorization, invoice freshness, and editing hooks. It selects the navigation shell through a small responsive-layout hook based on `matchMedia('(max-width: 767px)')` and passes the resulting layout mode to each feature tab.

The presentation boundary is:

```text
Shared App state and handlers
          |
     responsive shell
       /          \
desktop shell    mobile shell
existing views   mobile presentations
```

Each feature tab retains one controller layer for its state, derived data, and existing operations. That controller selects a desktop or mobile presenter. This prevents invoice finalization, calendar editing, or settings persistence from being implemented twice. Presenters receive typed data and handler props; they do not fetch, persist, or mutate application data directly.

New components must be split by responsibility:

- `useCompactLayout`: subscribes to the media query and handles changes safely.
- `MobileAppShell`: app header, scrollable content region, safe-area padding, bottom navigation, and mobile refresh status.
- `MobileCalendar`: agenda/month state, date selection, and shared lesson selection.
- `MobileAgenda`: groups and renders lessons for the selected date.
- `MobileMonthGrid`: renders compact month indicators and selects a date.
- `MobileLessonSheet`: adapts the existing lesson details/editing workflow to a bottom sheet.
- `MobileInvoices`: renders card-based rows using existing invoice operations.
- `MobileIncome`: renders the existing income report as phone-readable monthly rows and totals instead of a 760-pixel chart.
- `MobileSettings`: presents the existing Rates controller fields in a phone layout with an accessible save action.

`CalendarTab`, `InvoicesTab`, `IncomeTab`, and `RatesTab` retain their current controller responsibilities and select the appropriate presenter. Shared derivation logic must be extracted only when both presenters need it. Existing desktop markup moves only as required to create this boundary; its rendered behavior and styling stay unchanged.

## Mobile Shell

The shell fills the dynamic viewport height and accounts for Android safe-area insets. Content scrolls independently above a fixed bottom navigation bar.

The header uses the existing lotus artwork, the current screen title, and a refresh/synchronization control. It must not reproduce Android status-bar content.

Bottom navigation uses `@phosphor-icons/react` outline icons and text labels. Every item has a minimum 48-pixel touch target, an accessible name, and a clearly visible active state. `Rates & Config` is renamed to `Settings` only in the mobile shell.

The collapsed log indicator sits above the bottom navigation and cannot obscure application content. An expanded mobile log view is a sheet. Desktop log behavior remains unchanged.

## Calendar Behavior

Agenda mode is the initial mobile mode. The initial month follows the existing Calendar rule. Within that month, the selected date is today when visible; otherwise it is the first date containing a lesson, falling back to the first day of the month.

Previous and next month actions preserve a valid selected day. The date strip provides seven nearby days and allows horizontal movement. A compact mode action switches between agenda and month without losing the selected date.

Each agenda row calculates its expected amount with the configured studio tiers and existing overrides. Missing rates or student counts display an explicit unavailable state rather than throwing or inventing a total.

Selecting a lesson opens the mobile lesson sheet. The sheet exposes the same studio, student-count, euro-override, recurrence, confirmation, conflict, and error workflows as the existing desktop lesson card. Closing it restores focus to the selected lesson.

## Invoice Behavior

Rows and totals continue to come from `buildInvoiceRows`, invoice generation, and freshness state. The most recent actionable period is shown first. Each card renders only actions whose existing preconditions are met; disabled actions explain the missing output folder, invoice sequence, freshness verification, email address, or stale state.

Preview, finalize, re-finalize, and draft-email actions call the existing handlers. This design does not claim that Android-native sharing exists. Where the current backend cannot complete an action on Android, the existing error is presented in the card.

## Income and Settings

Mobile Income keeps the year selector, annual total, maximum month, studio colors, month totals, and year-over-year labels. It replaces the fixed-width twelve-column chart with vertically stacked month rows so horizontal scrolling is unnecessary.

Mobile Settings keeps every existing field and calendar selection function. Inputs are single-column, use at least 16-pixel text, and preserve the recently added human calendar-name display. The save control remains visible while dirty. Studio rate tiers may scroll within their card only when their row cannot fit.

## Loading and Errors

- Initial configuration loading uses a centered mobile loading state.
- Calendar refresh status appears in the header without shifting the layout.
- Calendar errors use a compact visible banner with a retry action.
- Empty agenda, invoice, and income states explain what data is missing.
- Mutation errors stay beside the action that failed.
- Google Calendar permission prompts remain modal and must fit within the phone viewport.

## Accessibility

- Minimum touch target: 48 by 48 CSS pixels.
- Body inputs: minimum 16-pixel text to avoid WebView zoom.
- Bottom navigation uses semantic buttons and current-page state.
- Sheets are labelled dialogs, trap focus, close with Android Back/Escape where available, and restore focus.
- Color is never the only indicator for today, selection, freshness, or errors.
- Motion respects `prefers-reduced-motion`.

## Testing and Acceptance

Automated tests must prove:

- the desktop shell remains selected at 768 pixels and above;
- the mobile shell is selected below 768 pixels and reacts to media-query changes;
- all four bottom-navigation destinations work;
- agenda selection, month changes, and agenda/month mode preserve the selected date;
- expected lesson amounts use existing rate calculations and handle missing data;
- selecting a lesson opens the mobile sheet and retains the existing edit handlers;
- invoice card actions call the same preview, finalization, re-finalization, and email paths;
- Income and Settings render without horizontal overflow at 390 CSS pixels;
- the opaque Google calendar ID is never rendered.

Verification gates:

- `bun test`;
- both TypeScript project checks;
- `bun run verify:calendar-editing`;
- production Vite build;
- desktop Tauri E2E at its existing 800-pixel viewport;
- Android emulator capture and interaction check at the Pixel viewport for every mobile tab.

Visual QA compares the implemented Calendar agenda, Calendar month sheet, and Invoices screen against the three approved source mock-ups at the same viewport. P0-P2 differences must be resolved before handoff.

## Non-goals

- Duplicating domain or persistence logic for mobile.
- Replacing the desktop month grid, invoice table, income chart, or settings layout.
- Android-native PDF sharing or storage redesign.
- Cross-device invoice-number synchronization.
- New routes, authentication flows, or business capabilities.
