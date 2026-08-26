# Mobile Calendar Navigation Design

**Date:** 2026-08-26  
**Status:** Approved in brainstorming

## Goal

Make the Android Calendar tab month-first and navigation-driven: selecting a day opens its agenda, Android Back returns to the month, and days containing unconfigured classes are visibly identifiable.

Desktop Calendar behavior remains unchanged.

## User Experience

### Entry and reset behavior

The mobile Calendar always enters at the month view. The Agenda/Month button row is removed.

Tapping the Calendar destination in the bottom navigation resets the Calendar to the month view even when Calendar is already active. Returning to Calendar from another tab also starts at the month view. Resetting the view closes any open lesson sheet and invalidates Calendar-owned navigation depth so stale Agenda or lesson states cannot reappear visually later.

The bottom navigation remains visible and operable while the mobile lesson-details sheet is open, so Calendar reselection is physically reachable from every Calendar level. Resetting an already-active Calendar preserves its currently displayed year and month. Returning after the Calendar component has been unmounted retains the app's existing default-month behavior.

### Forward navigation

The mobile Calendar has three ordered levels:

1. **Month**
2. **Agenda for a selected day**
3. **Lesson details**

Tapping any month-grid day opens Agenda for that date. This includes days with no lessons; Agenda shows the existing `No lessons on this day` empty state so users receive clear confirmation that their tap was registered.

Month cells no longer open lesson details directly, including when a selected day contains exactly one lesson. Lesson details open only from a lesson row in Agenda.

The existing Agenda date strip remains available. Selecting another date in the strip changes the Agenda date without adding another navigation level.

### Back behavior

Android Back unwinds one Calendar-owned level at a time:

- Lesson details → Agenda, with focus restored to the lesson row.
- Agenda → Month.
- Back from Month is not intercepted by Calendar and retains normal Android/webview behavior.

The Calendar uses one coordinated navigation state machine and one history handler. Independent Agenda and lesson-sheet `popstate` handlers are avoided because both could react to one Back gesture and collapse two levels at once.

### Focus behavior

Month → Agenda moves focus to a programmatically focusable Agenda heading so the selected date is announced. Agenda → Month through Back restores focus to the selected day button. Lesson details → Agenda restores focus to the lesson row that opened the sheet; if refreshed data removed that lesson, focus falls back to the Agenda heading. A reset initiated by the bottom navigation does not steal focus from the clicked destination button.

### Lesson sheet and bottom navigation

On mobile, lesson details become a non-modal bottom sheet positioned above the persistent bottom navigation. Its backdrop covers Calendar content but stops above the navigation. While the sheet is open, the obscured Calendar content is `inert`, preventing pointer, keyboard, and assistive-technology interaction; the bottom navigation is outside that inert subtree and remains operable. The sheet does not claim `aria-modal`, and its keyboard handling does not trap focus away from the bottom navigation. The sheet still receives initial focus, retains labelled dialog semantics, closes from its explicit controls/backdrop/Back gesture, and restores focus as described above. Desktop popover behavior is unchanged.

## State and History Architecture

`CalendarTab` coordinates the mobile-only navigation state while preserving the current desktop branch. Mobile state represents Month, Agenda with its selected date, or lesson details with the selected lesson and focus anchor. Desktop lesson selection is held separately so responsive transitions cannot leak a mobile sheet into desktop or make desktop interaction push Calendar history.

Each mobile Calendar mount creates a unique owner/session ID. Month → Agenda pushes a history entry tagged with that owner and `agenda`; Agenda → lesson details pushes one tagged with the same owner and `details`. A single `popstate` handler decides from the **destination** `PopStateEvent.state`, the active owner ID, and the visible level:

- A destination matching the current visible Calendar level causes no Calendar transition. This is what lets Back close a foreign overlay such as `LogPanel` without also changing Calendar.
- Details with a destination tagged as the same owner's Agenda closes only details.
- Agenda with a destination that is not tagged as that owner's Agenda returns to Month.
- Entries owned by an expired Calendar session, entries owned by another feature, and unrecognized states never trigger a forward or stale Calendar restoration.

This protocol coexists with the existing independently owned `LogPanel` history entry. For example, with Logs open over Agenda, the first Back lands on the still-current Agenda entry: Logs close while Calendar sees no level change. The second Back lands below the Agenda entry and returns Calendar to Month.

Programmatic lesson close calls `history.back()` only when the current history entry matches the active owner's expected Details tag; the destination event performs the visible transition. If the entry is no longer owned, Calendar closes the stale visible sheet directly without traversing foreign history. This prevents one close action from also collapsing Agenda.

The app emits a monotonically changing Calendar activation/reset signal whenever the mobile Calendar destination is selected, including reselection while already active. `CalendarTab` observes this signal and returns mobile state to Month. Reset/leave cleanup may call `history.go(-ownedDepth)` only when the **current** entry is the active owner's expected top entry and the known Calendar entries beneath it were pushed contiguously by that owner. Before traversal, the owner is invalidated and cleanup events are suppressed. If the current entry is foreign or ownership cannot be proven, Calendar resets visually and invalidates the session without traversing history. It never skips through an unrelated entry.

When Calendar remains mounted after an active reset, it immediately rotates to a fresh owner/session ID before accepting another Month → Agenda transition. Old-owner entries remain invalid even if later traversal reaches them, while new navigation is tagged only with the fresh ID. A tab leave or mobile → desktop transition does not create a replacement owner until mobile Calendar mounts/activates again. Forward entries from invalidated sessions are ignored; the next push from the current position truncates them normally.

Responsive changes are explicit cleanup boundaries. Mobile → desktop invalidates and safely cleans contiguous mobile-owned history, closes the mobile sheet, and leaves desktop lesson selection empty. Desktop → mobile creates a new owner and starts at Month. The currently displayed year/month remains shared and is preserved across a live layout transition.

Month navigation and the displayed year/month otherwise remain where they are today. Agenda selection changes do not duplicate class data or rate calculations.

## Month Grid Warning Marker

A day containing one or more unconfigured classes displays one warning marker in its upper-right corner:

- 12 × 12 CSS pixels.
- 3 pixels from the top and right edges.
- Red circular background.
- Centered white cross.
- Circle and cross drawn in one self-contained SVG coordinate system to prevent separate subpixel snapping.

The marker appears once per affected day, regardless of how many unconfigured classes occur that day.

Normal studio-color bars represent configured classes only. A mixed day displays both its configured-class bars and the unconfigured warning marker. A day containing only unconfigured classes displays the warning marker without a studio-color bar.

The month legend continues to list configured studios and adds a compact red-cross key labelled `Unconfigured` whenever the displayed month contains an unconfigured class. Unconfigured studio names are not presented as normal configured-studio color keys.

The SVG is decorative and hidden from assistive technology. The enclosing day button's accessible name reports the date and unconfigured-class count, using singular or plural wording as appropriate.

## Components Affected

- `src/App.tsx`
  - Emit a Calendar activation/reset signal for every mobile Calendar destination selection.
- `src/components/mobile/MobileNavigation.tsx`
  - Preserve active-destination reselection and remain reachable above the mobile lesson sheet.
- `src/components/mobile/MobileAppShell.tsx`
  - Provide the persistent navigation stacking/spacing contract used by the non-modal lesson sheet.
- `src/components/CalendarTab/index.tsx`
  - Coordinate the mobile Month → Agenda → lesson-details state machine, tagged browser-history ownership, responsive cleanup, and focus restoration.
  - Keep desktop selection and behavior separate.
- `src/components/CalendarTab/MobileCalendar.tsx`
  - Remove view-toggle controls.
  - Render Month or Agenda from the coordinated mobile state.
- `src/components/CalendarTab/MobileMonthGrid.tsx`
  - Make every day tap select the date.
  - Render configured bars and the single-SVG unconfigured marker.
  - Expose selected-day focus restoration and accessible warning counts.
- `src/components/CalendarTab/MobileAgenda.tsx`
  - Expose an Agenda-heading focus fallback.
- `src/components/CalendarTab/EventDetailsCard.tsx`
  - Keep the mobile sheet above content but below/clear of persistent navigation, and use non-modal focus semantics on mobile only.
- Existing mobile Calendar, app-shell, LogPanel interaction, responsive-layout, and desktop Calendar tests.

No calendar fetching, parsing, editing, invoice, or rate-calculation behavior changes.

## Edge Cases

- Empty day: opens Agenda and shows the empty state.
- Multiple unconfigured lessons on one day: one marker, accessible count reflects all lessons.
- Mixed configured/unconfigured day: configured bars plus one marker.
- Back with lesson details open: closes only details.
- Back from Agenda: returns only to Month.
- Calendar bottom destination tapped from details or Agenda: remains reachable, resets directly to Month, invalidates owned depth, and leaves focus on the navigation button.
- Calendar tab left while a deeper level is open: safely cleans only contiguous proven-owned history without changing the new active tab.
- LogPanel opened over Agenda: first Back closes only Logs; the next Back returns Agenda to Month. Opening Logs from behind the lesson-details sheet is not a required interaction.
- Foreign current history entry during reset/cleanup: invalidate Calendar state without traversing the foreign entry.
- Calendar data refresh while in Agenda: retain the selected date when valid and continue using existing date normalization behavior.
- Calendar data refresh removes the open lesson: close/back returns to Agenda and focuses its heading fallback rather than retaining a stale focus target.
- Mobile → desktop: invalidate mobile history and close mobile details; desktop → mobile starts at Month while preserving the displayed year/month.
- Desktop layout: lesson interaction does not push Calendar history and otherwise remains unchanged.

## Testing and Validation

Focused tests will verify:

1. Mobile Calendar initially renders Month and has no Agenda/Month toggle row.
2. Configured, unconfigured, mixed, and empty dates render the correct indicators.
3. The single-SVG warning appears once per affected day and day accessible names contain accurate counts.
4. Every month day opens Agenda, including an empty day.
5. Month cells never open lesson details directly.
6. Agenda lesson rows open details.
7. Tagged `pushState` entries carry unique owner IDs and the expected Agenda/Details destination metadata.
8. Real or instrumented history traversal plus destination-state `popstate` events unwind details → Agenda → Month one level at a time; Back from Month is not consumed.
9. Programmatic detail close calls Back once and does not also collapse Agenda; cleanup events are suppressed after reset.
10. Depth-one and depth-two reset/tab-leave cleanup traverse only when the current entry proves contiguous ownership.
11. A foreign sentinel entry is never skipped or removed, and stale/forward entries from an invalidated owner do not restore Calendar UI.
12. Active reset rotates the owner ID within the same mount; later Agenda/details entries use the new ID and traversal to an old-owner entry cannot restore stale UI.
13. Logs over Agenda close on the first Back while Agenda remains visible; the second Back returns to Month.
14. An App-level test proves every Calendar destination selection emits a new activation signal, including active reselection.
15. A sheet integration/E2E test opens details and physically taps the still-visible Calendar destination to reset.
16. Focus transitions cover day → Agenda heading, Back → selected day, details → lesson row, missing-lesson → Agenda heading, and bottom-navigation reset retention.
17. While details are open, Calendar content is inert but the persistent bottom navigation remains focusable and clickable.
18. Responsive tests cover mobile → desktop cleanup, desktop → mobile Month entry, shared displayed month, and no desktop history pushes.
19. Marker tests assert 12×12 dimensions, 3px offsets, one marker per day, one combined circle/cross SVG, configured-only bars, mixed-day coexistence, conditional legend, and singular/plural accessible names.
20. Existing desktop Calendar interactions continue to pass.

Validation commands:

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx tests/components/MobileAppShell.test.tsx
bun test
bunx tsc --project tsconfig.app.json --noEmit
bun run verify:calendar-editing
bun run e2e
```

A final Android smoke check should confirm month entry, empty-day feedback, the warning marker, nested Back behavior, Calendar reselection from Agenda and details, LogPanel precedence over Agenda, responsive/orientation behavior, and bottom-navigation switching on the target emulator/device.

## Implementation Constraints

The working tree already contains unrelated Android build, generated-permission, instrumentation-test, and plugin-build changes. Implementation must not reset, overwrite, stage, reformat, or otherwise alter those changes. Final status and diff inspection must distinguish the intended Calendar/UI/test files from all pre-existing work.

## Out of Scope

- Desktop Calendar redesign.
- Calendar data-model or parser changes.
- New routes or a routing framework.
- Changes to Agenda lesson-card content.
- Changes to event editing, rates, invoice generation, or synchronization.
