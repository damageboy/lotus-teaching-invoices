# Responsive Mobile Layout — Design QA

Date: 2026-08-23

## Blocking method and evidence

- Source truth: agenda `/Users/dmg/.codex/generated_images/01a02b24-27d5-77d1-9031-bc975f316066/exec-74f861f9-5802-4869-92b9-e294761bd780.png`; month/sheet `/Users/dmg/.codex/generated_images/01a02b24-27d5-77d1-9031-bc975f316066/exec-643840fa-7972-41b3-a6e4-0554ad90be89.png`; invoices `/Users/dmg/.codex/generated_images/01a02b24-27d5-77d1-9031-bc975f316066/exec-959aa5df-7a45-4242-bf11-43ac9d040066.png`.
- Implementation: real `com.houmus.teaching_invoices/.MainActivity` Tauri Android build on the isolated `Lotus_QA_API_36` AVD. The user's `Lotus_API_36` data, configuration, OAuth state, and credentials were not opened, reset, deleted, or replaced.
- Display: 1080 × 2400 physical px, 420 dpi, density 2.625, font scale 1.0. Stable WebView viewport: 412 × 915 CSS px, DPR 2.625.
- Deterministic data lived only in the QA app sandbox. A temporary debug-only Calendar transport adapter accepted the isolated fixture token while exercising the production UI, Tauri storage, configuration, SQLite cache, parsing, and interactions. It was removed before final verification and is absent from the committed source.
- Source states were matched before comparison: agenda 24 August/3 classes/€150; month 18 August/Test Studio Pilates/6 students/editing enabled; invoices July 2026/Test Studio/6 classes/€330/ready and enabled.
- Each full and focused comparison was opened with the source and its matching implementation capture in the same image. The 1080 × 2400 implementation was resized aspect-preservingly to the source height; no pixel-identity claim is made because the source rasters do not declare a CSS viewport.

Final implementation captures:

- Agenda: `/tmp/lotus-mobile-calendar-agenda.png` (1080 × 2400).
- Month with lesson sheet: `/tmp/lotus-mobile-calendar-month.png` (1080 × 2400).
- Invoices: `/tmp/lotus-mobile-invoices.png` (1080 × 2400).

Final paired full-view evidence:

- Agenda: `docs/qa/responsive-mobile/agenda-full.png` (1683 × 1844).
- Month/sheet: `docs/qa/responsive-mobile/month-sheet-full.png` (1683 × 1844).
- Invoices: `docs/qa/responsive-mobile/invoices-full.png` (1683 × 1846).

Final paired focused evidence:

- Agenda header, summary, rows, and actions: `docs/qa/responsive-mobile/agenda-focus.png` (1683 × 1080).
- Month grid and lesson sheet: `docs/qa/responsive-mobile/month-sheet-focus.png` (1683 × 1200).
- Invoice status and actions: `docs/qa/responsive-mobile/invoices-focus.png` (1683 × 1450).

## Comparison history

### Iteration 1 — initial real-app findings

- **P1, Android Back escaped the lesson sheet:** the application lost foreground instead of closing the sheet. Fixed in `src/components/CalendarTab/index.tsx` with sheet history/popstate handling and exact origin-focus restoration.
- **P1, cross-tab scroll leakage:** Income and Settings could open at the previous tab's scroll position. Fixed in `src/components/mobile/MobileAppShell.tsx` by resetting the shared content scroller on destination changes.
- **P1, source month-sheet path unreachable:** a month tap only selected a date. Fixed in `src/components/CalendarTab/MobileMonthGrid.tsx` and `MobileCalendar.tsx`; a second tap on a selected single-lesson date opens the sheet.
- **P2, sheet focus remained behind the modal:** fixed in `EventDetailsCard.tsx` with programmatic sheet focus, Tab containment, Escape, and focus restoration.
- **P2, sync state was icon-only:** fixed in `MobileAppShell.tsx` with visible Synced/Syncing/Retry text.

### Iteration 2 — evidence rejected as nonmatching

The first final-looking evidence used live user states that differed materially from the sources: the agenda date/count differed, the month lesson was read-only, and invoices were disabled/unconfigured. Those images remain useful interaction evidence but are not valid blocking visual comparisons. Their earlier pass conclusion is superseded by the deterministic recaptures below.

### Iteration 3 — independent-review findings and fixes

- **P2, backward focus escaped from the focused sheet container:** when `document.activeElement` was the dialog itself, Shift+Tab reached the backdrop. `EventDetailsCard.tsx` now treats the focused container as an entry boundary, routes Shift+Tab to the last enabled control, and wraps first↔last. Explicit backward and forward tests cover all boundaries.
- **P2, agenda rows lacked the source action affordance:** `MobileAgenda.tsx` now shows `Open` with the installed Phosphor `CaretRight`, and the row's accessible name starts with `Open lesson details`.
- **P1, Android gesture pill crossed bottom-nav labels when WebView safe-area was zero:** final paired images exposed the overlap. `MobileAppShell.tsx` now reserves a 1.5rem fallback in addition to the environment safe area; sheet/log offsets use the same floor. All three states were recaptured at the same viewport.

### Iteration 4 — final paired comparison

#### Calendar agenda

- Typography: clear system-sans hierarchy; date, total, time, studio, class, students, amount, and action remain readable without clipping. The source's exact font metrics are concept-specific.
- Spacing: 48px-class touch targets, consistent row padding, and bottom clearance are preserved. No horizontal overflow; fixed navigation clears the gesture pill.
- Colors: real studio purple/teal, indigo interaction color, slate text, and white surfaces are coherent and legible. The implementation uses approved product tokens rather than copying concept-only gradients.
- Image/icon quality: real lotus asset and Phosphor chevrons are crisp at DPR 2.625; no handwritten SVG, CSS art, emoji, or placeholder asset.
- Copy/state: both sides show 24 August, 3 classes, €150 and the matching Cover/Test lessons. The implementation's explicit `Open` affords the same action as the source.
- Responsiveness/states: agenda/month toggle, navigation, summary, lesson rows, log control, and bottom navigation fit 412 CSS px and are scroll-reachable.
- Accessibility: named rows include action and teaching/income context, actions have visible text plus an aria-hidden icon, navigation exposes current state, and focus rings/touch targets are present.
- Remaining P0/P1/P2: none.

#### Calendar month and lesson sheet

- Typography: grid labels and sheet content are legible; title, date, studio, class, student, and amount copy do not truncate.
- Spacing: the grid remains tappable at 412 CSS px; the sheet has safe bottom padding and its enabled actions remain clear of native gestures.
- Colors: selected date, real studio dots, semantic copy, and action contrast communicate state without relying on color alone.
- Image/icon quality: installed Phosphor controls are crisp; concept-only illustration was not replaced with fabricated art.
- Copy/state: both sides select 18 August and show Test Studio Pilates with 6 students in an editable lesson state. The implementation uses the approved shared editing controls rather than the concept's explanatory presenter copy.
- Responsiveness/states: month selection, second-tap sheet opening, enabled edit controls, Escape/Back dismissal, and return focus work at the measured viewport.
- Accessibility: `role="dialog"`, `aria-modal`, initial focus, container Shift+Tab→last, first Shift+Tab→last, last Tab→first, named close/action controls, and exact focus return are verified. On-device keyboard events were prevented at every wrap boundary.
- Remaining P0/P1/P2: none.

#### Invoices

- Typography: July period, Test Studio, ready status, 6-class count, €330 total, and three actions are readable with no clipping.
- Spacing: status and action group remain balanced; the card and bottom navigation clear Android gesture controls and remain scroll-reachable.
- Colors: indigo actions, neutral surfaces, and semantic ready state remain legible. Decorative source gradients are not required application assets.
- Image/icon quality: real lotus and installed Phosphor icons are crisp; no invented imagery.
- Copy/state: both primary states show July 2026, Test Studio, 6 classes, €330, ready to finalize, and enabled PDF actions. The implementation additionally exposes the real Draft Email action. The source's prospective invoice number and secondary August summary are concept-presenter content, not a contradictory live state.
- Responsiveness/states: prior/current switching, enabled actions, scrolling, log sheet, and bottom navigation work at 412 CSS px.
- Accessibility: buttons have explicit names and enabled semantics, warning/status meaning is textual, controls are touch-sized, and the log sheet is dismissible.
- Remaining P0/P1/P2: none.

## Final interaction and safety audit

- Calendar agenda/month, lesson sheet, Invoices, Income, Settings, Google Calendar display name, refresh, all four bottom destinations, Android Back, keyboard input, full-scroll reachability, and log sheet were exercised in the real Android app.
- On-device focus evidence: focused dialog Shift+Tab → `Set Euros…`; first control Shift+Tab → `Set Euros…`; last control Tab → `Close`; all three events were `defaultPrevented`.
- Safe-area evidence: the final agenda, month, and invoice captures all show complete bottom-navigation labels above the native gesture pill.
- Repository check found no QA token or QA calendar hook after removing the temporary adapter.

Accepted P3 differences: concept-only illustration/gradients and explanatory secondary copy, plus small metric differences caused by the source rasters' unspecified CSS viewport. They do not impair the approved workflow, responsiveness, state truth, or accessibility.

final result: passed
