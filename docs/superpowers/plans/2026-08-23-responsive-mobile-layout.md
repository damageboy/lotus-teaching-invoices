# Responsive Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved agenda-first Android layout below 768 CSS pixels while preserving the current desktop UI and all shared Calendar, invoice, Income, and Settings behavior.

**Architecture:** `App` selects a responsive navigation shell with `useCompactLayout` and passes `layout: 'desktop' | 'mobile'` into the four feature tabs. Each feature tab retains one controller for its state and operations, then selects a desktop or mobile presenter so synchronization, edits, invoice writes, and configuration persistence are never duplicated.

**Tech Stack:** React 19, TypeScript 5.6, Tailwind CSS 4, Tauri 2.10, Vitest 2, JSDOM 26, `@phosphor-icons/react` 2.1.10, Bun, Android WebView.

**Spec:** `docs/superpowers/specs/2026-08-23-responsive-mobile-layout-design.md`

## Global Constraints

- Widths below 768 CSS pixels use mobile presentation; widths of 768 pixels and above retain desktop presentation.
- Calendar synchronization, editing, invoice calculations, freshness checks, Google authorization, and configuration state remain shared with desktop.
- Do not implement Android-native PDF sharing, cloud configuration synchronization, or cross-device invoice numbering in this plan.
- Mobile invoice buttons call the existing real handlers and report real errors; no action may be simulated.
- Use these exact visual sources: agenda `exec-74f861f9-5802-4869-92b9-e294761bd780.png`, month/sheet `exec-643840fa-7972-41b3-a6e4-0554ad90be89.png`, and invoices `exec-959aa5df-7a45-4242-bf11-43ac9d040066.png`, all under `/Users/dmg/.codex/generated_images/01a02b24-27d5-77d1-9031-bc975f316066/`.
- Keep the current desktop markup and behavior unchanged except where a presenter boundary is required.
- Preserve every pre-existing uncommitted Android/OAuth/calendar-name change; stage only files and hunks created by the active task.
- Use 48-by-48 CSS-pixel touch targets, 16-pixel mobile form controls, safe-area insets, semantic navigation, labelled dialogs, visible non-color state, and reduced-motion support.

## File Structure

- `src/hooks/useCompactLayout.ts`: media-query subscription and `AppLayout` type.
- `src/components/mobile/MobileAppShell.tsx`: branded header, content viewport, refresh state, bottom navigation.
- `src/components/mobile/MobileNavigation.tsx`: typed tab buttons and Phosphor icons.
- `src/assets/lotus-icon.png`: app-owned copy of the existing lotus mark.
- `src/components/CalendarTab/mobile-calendar.ts`: pure mobile date and expected-income derivations.
- `src/components/CalendarTab/MobileCalendar.tsx`: agenda/month controller presenter.
- `src/components/CalendarTab/MobileAgenda.tsx`: selected-day lesson rows.
- `src/components/CalendarTab/MobileMonthGrid.tsx`: compact event-indicator month grid.
- `src/components/CalendarTab/EventDetailsCard.tsx`: shared editing controller with popover/sheet presentation.
- `src/components/InvoicesTab/MobileInvoices.tsx`: card presenter for existing invoice row actions.
- `src/components/IncomeTab/MobileIncome.tsx`: vertical monthly income presenter.
- `src/components/RatesTab/MobileSettings.tsx`: mobile wrapper/presenter for existing settings state and callbacks.
- `src/components/LogPanel/index.tsx`: desktop footer or mobile sheet/pill presentation.
- `src/index.css`: dynamic viewport, safe-area, reduced-motion, and mobile overscroll rules.
- `tests/hooks/useCompactLayout.test.tsx`: responsive hook regression tests.
- `tests/components/MobileAppShell.test.tsx`: mobile navigation tests.
- `tests/components/MobileCalendar.test.tsx`: agenda, month, amount, selection, and sheet tests.
- `tests/components/MobileInvoices.test.tsx`: card state and action tests.
- `tests/components/MobileIncome.test.tsx`: mobile income content tests.
- `tests/components/MobileSettings.test.tsx`: settings, calendar-name, save, and log-layout tests.
- `design-qa.md`: final source-versus-emulator comparison report.

---

### Task 1: Responsive Shell and Bottom Navigation

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/assets/lotus-icon.png`
- Create: `src/hooks/useCompactLayout.ts`
- Create: `src/components/mobile/MobileNavigation.tsx`
- Create: `src/components/mobile/MobileAppShell.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Test: `tests/hooks/useCompactLayout.test.tsx`
- Test: `tests/components/MobileAppShell.test.tsx`

**Interfaces:**

- Produces: `type AppLayout = 'desktop' | 'mobile'`.
- Produces: `type AppTab = 'calendar' | 'invoices' | 'income' | 'rates'` from `MobileNavigation.tsx`; `App` uses the same type instead of declaring a duplicate union.
- Produces: `useCompactLayout(): boolean`.
- Produces: `MobileAppShell` with `activeTab`, `onSelectTab`, `calendarLoading`, `calendarError`, `onRefresh`, and `children` props.
- Produces: `layout: AppLayout` passed by `App` to all four feature tabs and `LogPanel`.

- [ ] **Step 1: Install the icon package and copy the existing lotus asset**

Run:

```bash
bun add @phosphor-icons/react@2.1.10
mkdir -p src/assets
cp src-tauri/icons/icon.png src/assets/lotus-icon.png
```

Inspect `package.json` and `bun.lock` afterward. Preserve the existing uncommitted opener dependency and stage only the Phosphor-specific hunks when committing.

- [ ] **Step 2: Write failing responsive-hook and navigation tests**

Create a controllable `matchMedia` fake and assert the initial and changed layout:

```tsx
function Probe() {
  const compact = useCompactLayout();
  return <span>{compact ? 'mobile' : 'desktop'}</span>;
}

it('switches at the 767px media query', async () => {
  const media = installMatchMedia(false);
  render(<Probe />);
  expect(document.body.textContent).toContain('desktop');
  await act(() => media.setMatches(true));
  expect(document.body.textContent).toContain('mobile');
});
```

Test `MobileNavigation` separately:

```tsx
it('selects all four mobile destinations', async () => {
  const onSelect = vi.fn();
  render(<MobileNavigation activeTab="calendar" onSelect={onSelect} />);
  await click(namedButton('Invoices'));
  await click(namedButton('Income'));
  await click(namedButton('Settings'));
  expect(onSelect.mock.calls.map(([tab]) => tab)).toEqual(['invoices', 'income', 'rates']);
});
```

Render `MobileAppShell` with `calendarError="Calendar quota exceeded"`, click `Retry calendar sync`, and assert `onRefresh` is called once. Render it with `calendarLoading` and assert the labelled sync control reports `Syncing` without moving navigation.

- [ ] **Step 3: Run the tests and verify the missing modules fail**

Run:

```bash
bunx vitest run tests/hooks/useCompactLayout.test.tsx tests/components/MobileAppShell.test.tsx
```

Expected: FAIL because `useCompactLayout`, `MobileNavigation`, and `MobileAppShell` do not exist.

- [ ] **Step 4: Implement the hook and mobile shell**

Implement the hook with legacy WebKit listener support:

```ts
export type AppLayout = 'desktop' | 'mobile';

const MOBILE_QUERY = '(max-width: 767px)';

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia(MOBILE_QUERY).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setCompact(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);
  return compact;
}
```

Use `CalendarBlank`, `FileText`, `ChartBar`, `Gear`, and `ArrowsClockwise` from Phosphor. `MobileNavigation` must render `aria-current="page"` only on the active button. `MobileAppShell` must use `min-h-[100dvh]`, safe-area padding, the lotus PNG, a fixed bottom bar, and a content area padded past that bar.

In `App`, keep the existing desktop tab bar byte-for-byte inside the desktop branch and mark its root `data-layout="desktop"`. Render the mobile header/navigation branch only when `useCompactLayout()` is true and mark it `data-layout="mobile"`. Pass `layout` to feature tabs and `LogPanel`.

Add CSS:

```css
@media (max-width: 767px) {
  html,
  body,
  #root {
    min-height: 100dvh;
    overscroll-behavior: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
bunx vitest run tests/hooks/useCompactLayout.test.tsx tests/components/MobileAppShell.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the responsive shell slice**

Stage only Task 1 files and Phosphor-specific package hunks, then run:

```bash
git commit -m "feat: add responsive mobile app shell"
```

### Task 2: Mobile Calendar Agenda and Month Modes

**Files:**

- Create: `src/components/CalendarTab/mobile-calendar.ts`
- Create: `src/components/CalendarTab/MobileAgenda.tsx`
- Create: `src/components/CalendarTab/MobileMonthGrid.tsx`
- Create: `src/components/CalendarTab/MobileCalendar.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Test: `tests/components/MobileCalendar.test.tsx`

**Interfaces:**

- Consumes: `AppLayout` from `src/hooks/useCompactLayout.ts`.
- Produces: `initialMobileDate(year: number, month: number, classes: ParsedClass[], now: Date): string`.
- Produces: `lessonExpectedAmount(lesson: ParsedClass, studio?: StudioConfig): number | null`.
- Produces: `MobileCalendar` with the same lesson-edit callbacks already accepted by `CalendarTab`.

- [ ] **Step 1: Write failing pure derivation tests**

Cover today, first lesson, first-of-month fallback, overrides, tier rates, and missing rates:

```ts
expect(initialMobileDate(2026, 7, lessons, new Date('2026-08-22T12:00:00+02:00'))).toBe(
  '2026-08-22'
);
expect(lessonExpectedAmount(lesson({ studentCount: 8 }), studioWithRate(55))).toBe(55);
expect(
  lessonExpectedAmount(lesson({ studentCount: 8, rateOverride: 61.5 }), studioWithRate(55))
).toBe(61.5);
expect(lessonExpectedAmount(lesson({ studentCount: 0 }), studioWithRate(55))).toBeNull();
```

- [ ] **Step 2: Write failing interaction tests for both modes**

Render `CalendarTab` with `layout="mobile"` and assert:

```tsx
expect(namedButton('Agenda').getAttribute('aria-pressed')).toBe('true');
expect(document.body.textContent).toContain('Monday, August 24, 2026');
await click(namedButton('Month view'));
expect(namedButton('August 24, 2026')).toBeTruthy();
await click(namedButton('August 18, 2026'));
await click(namedButton('Agenda view'));
expect(document.body.textContent).toContain('Tuesday, August 18, 2026');
```

Also assert the agenda lesson accessible name includes studio, class type, time, students, and expected amount.

Add an empty selected-day case and assert the visible state says `No lessons on this day` without removing month navigation.

- [ ] **Step 3: Run the tests and verify the mobile presenter is absent**

Run:

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx
```

Expected: FAIL because the mobile Calendar modules and `layout` prop do not exist.

- [ ] **Step 4: Implement pure date and amount helpers**

Use local date construction, never UTC string truncation, for visible month dates. `lessonExpectedAmount` must return `rateOverride`, then `findRate`, and catch only `AppError` with code `NO_MATCHING_TIER`; it returns `null` for zero/ambiguous students, unknown studios, and unmatched tiers.

- [ ] **Step 5: Implement the agenda and month presenters**

`MobileCalendar` owns `mode: 'agenda' | 'month'` and `selectedDate`. It receives `year`, `month`, navigation callbacks, filtered month classes, studio map, and lesson-selection callback from `CalendarTab`.

`MobileAgenda` renders:

```tsx
<button
  type="button"
  aria-label={`${lesson.studioName}, ${lesson.classType}, ${lesson.startTime}, ${studentLabel}, ${amountLabel}`}
  className="min-h-24 w-full border-b border-slate-100 px-4 py-4 text-left"
  onClick={(event) => onSelectLesson(lesson, event.currentTarget)}
>
```

`MobileMonthGrid` uses 44-pixel minimum day buttons, abbreviated weekday headers, short studio-colored event bars, `aria-current="date"` for today, and `aria-pressed` for the selected date. Do not reuse the desktop 240-pixel cells.

- [ ] **Step 6: Select the presenter in `CalendarTab`**

Add `layout?: AppLayout` with default `'desktop'`. Preserve the existing desktop markup in the desktop branch. The mobile branch receives the same `monthClasses`, `colorMap`, studio stats, and `setSelected` callback.

- [ ] **Step 7: Run Calendar tests and the calendar-editing slice gate**

Run:

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx tests/components/CalendarTab.test.tsx
bun run verify:calendar-editing
```

Expected: all tests and all focused Rust gates pass.

- [ ] **Step 8: Commit the Calendar presentation slice**

```bash
git add src/components/CalendarTab tests/components/MobileCalendar.test.tsx
git commit -m "feat: add mobile calendar agenda and month views"
```

### Task 3: Mobile Lesson Editing Sheet

**Files:**

- Modify: `src/components/CalendarTab/EventDetailsCard.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/components/CalendarTab/ModalDialog.tsx`
- Test: `tests/components/MobileCalendar.test.tsx`
- Test: `tests/components/CalendarEventEditing.test.tsx`

**Interfaces:**

- Consumes: `layout: AppLayout` from `CalendarTab`.
- Produces: `EventDetailsCard` prop `presentation?: 'popover' | 'sheet'`, defaulting to `'popover'`.
- Preserves: every existing editing callback signature and focus-restoration behavior.

- [ ] **Step 1: Add failing sheet and editing tests**

Render mobile `CalendarTab`, open a lesson, and assert:

```tsx
const details = namedElement('dialog', 'Lesson details');
expect(details.getAttribute('data-presentation')).toBe('sheet');
expect(details.className).toContain('bottom-0');
await click(namedButton('Set Students'));
await typeValue(document.querySelector<HTMLInputElement>('#lesson-students')!, '12');
await click(namedButton('Save students'));
expect(onPrepareValueEdit).toHaveBeenCalledWith(lesson, {
  operation: 'setStudents',
  studentCount: 12,
});
```

Add an Escape close test that confirms focus returns to the agenda row. Keep all existing desktop occurrence and recurrence tests unchanged.

- [ ] **Step 2: Run the focused test to establish failure**

Run:

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx tests/components/CalendarEventEditing.test.tsx
```

Expected: the new mobile sheet assertions fail while existing desktop editing tests pass.

- [ ] **Step 3: Add sheet presentation without duplicating editing state**

Keep every hook and handler in `EventDetailsCard`. Only change positioning classes:

```tsx
const placement =
  presentation === 'sheet'
    ? 'fixed inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-3xl border-t bg-white p-5 shadow-2xl'
    : 'fixed w-72 rounded-lg border bg-white p-4 shadow-xl';
```

Apply computed `left/top` only for `popover`. Add a backdrop button for the sheet with `aria-label="Dismiss lesson details"`; retain `aria-label="Close lesson details"` on the visible close action. Pass `presentation="sheet"` from the mobile Calendar branch.

Constrain nested confirmation and value dialogs with `max-h-[calc(100dvh-2rem)] overflow-y-auto`, while leaving their desktop width limits intact.

- [ ] **Step 4: Verify all editing behavior**

Run:

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx tests/components/CalendarEventEditing.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
bun run verify:calendar-editing
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the shared sheet slice**

```bash
git add src/components/CalendarTab tests/components/MobileCalendar.test.tsx tests/components/CalendarEventEditing.test.tsx
git commit -m "feat: present lesson editing as a mobile sheet"
```

### Task 4: Mobile Invoice Cards

**Files:**

- Create: `src/components/InvoicesTab/MobileInvoices.tsx`
- Modify: `src/components/InvoicesTab/index.tsx`
- Test: `tests/components/MobileInvoices.test.tsx`
- Test: `tests/components/InvoicesTab.test.tsx`

**Interfaces:**

- Consumes: `layout: AppLayout`.
- Produces: exported `InvoiceDisplayRow` containing `row`, `rowKey`, `total`, `missingCount`, `blocked`, and `hasStudioConfig`.
- Produces: `MobileInvoices` callbacks `onPreview`, `onFinalize`, `onDraftEmail`, and `onChooseOutputFolder` using the existing controller handlers.

- [ ] **Step 1: Write failing invoice-card tests**

Use the existing Tauri dependency mocks from `InvoicesTab.test.tsx`. Assert the mobile view has no table and exposes real row state:

```tsx
render(<InvoicesTab {...props} layout="mobile" />);
expect(document.querySelector('table')).toBeNull();
expect(namedElement('article', 'Test Studio invoice for July 2026')).toBeTruthy();
expect(document.body.textContent).toContain('6 classes');
expect(document.body.textContent).toContain('€330.00');
await click(namedButton('Preview PDF'));
expect(generateAndOpenPdf).toHaveBeenCalledTimes(1);
```

Add separate cases for stale `Re-finalize PDF`, disabled missing-student state, missing output folder explanation, and Draft Email visibility.

Render with no rows and assert the mobile empty state says `No classes loaded` and contains no invoice action buttons.

- [ ] **Step 2: Run invoice tests to verify failure**

Run:

```bash
bunx vitest run tests/components/MobileInvoices.test.tsx tests/components/InvoicesTab.test.tsx
```

Expected: FAIL because `layout` and `MobileInvoices` are absent.

- [ ] **Step 3: Extract display-row derivation inside the existing controller**

Build display rows once from `rows`, `rowTotals`, studios, and the local date:

```ts
const displayRows = rows.map((row): InvoiceDisplayRow => {
  const rowKey = `${row.studioName}__${row.monthKey}`;
  const missingCount = row.classes.filter(
    (lesson) => lesson.studentCount === 0 && lesson.date < today
  ).length;
  return {
    row,
    rowKey,
    total: rowTotals.get(rowKey) ?? null,
    missingCount,
    blocked: missingCount > 0,
    hasStudioConfig: Boolean(config.studios[row.studioName]),
  };
});
```

The current desktop table consumes `displayRows` with no visible changes. The mobile presenter consumes the same array and existing handlers.

- [ ] **Step 4: Implement faithful mobile invoice cards**

Group cards by descending month. Each card is a labelled `article` with studio, period, class count, total, stale/current state, missing-student warning, and action buttons. Use a full-width indigo Finalize/Re-finalize button, a bordered Preview button, and Draft Email when configured. Display `row.freshness?.invoiceNumber` when known; do not invent a number for unfinalized rows.

When `outputDir` is empty, render a compact setup banner using the existing `chooseOutputFolder` callback. Do not say that app-controlled Android sharing is implemented.

- [ ] **Step 5: Verify invoice behavior and types**

Run:

```bash
bunx vitest run tests/components/MobileInvoices.test.tsx tests/components/InvoicesTab.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all commands exit 0 and existing stale-invoice tests remain green.

- [ ] **Step 6: Commit the invoice presenter**

```bash
git add src/components/InvoicesTab tests/components/MobileInvoices.test.tsx tests/components/InvoicesTab.test.tsx
git commit -m "feat: add mobile invoice action cards"
```

### Task 5: Mobile Income Rows

**Files:**

- Create: `src/components/IncomeTab/MobileIncome.tsx`
- Modify: `src/components/IncomeTab/index.tsx`
- Test: `tests/components/MobileIncome.test.tsx`
- Test: `tests/components/IncomeTab.test.tsx`

**Interfaces:**

- Consumes: `layout: AppLayout`.
- Consumes: the existing `buildIncomeReport` result, selected year, year options, and legend.
- Produces: a vertical mobile presenter without horizontal overflow.

- [ ] **Step 1: Write the failing mobile Income test**

```tsx
const html = renderToStaticMarkup(<IncomeTab classes={classes} config={config} layout="mobile" />);
expect(html).toContain('Income');
expect(html).toContain('Annual total');
expect(html).toContain('January');
expect(html).toContain('€150.00');
expect(html).toContain('+50%');
expect(html).not.toContain('min-w-[760px]');
```

Render an empty report and assert all twelve month rows remain reachable with `€0.00`, while the annual total is `€0.00`.

- [ ] **Step 2: Run the focused Income tests to establish failure**

Run:

```bash
bunx vitest run tests/components/MobileIncome.test.tsx tests/components/IncomeTab.test.tsx
```

Expected: FAIL because the mobile presenter and `layout` prop do not exist.

- [ ] **Step 3: Split derivation from presentation**

Keep year selection and `buildIncomeReport` in `IncomeTab`. Pass `report`, `legend`, `year`, `yearOptions`, and `onSelectYear` into either the existing desktop chart or `MobileIncome`.

Render all twelve months as rows with full month name, total, YoY label, and proportional studio-colored segments. A zero-total month still renders with `€0.00` and an empty neutral track. Use `width: total / yAxisMax * 100%` only for the outer total; calculate studio shares within it from existing segment totals.

- [ ] **Step 4: Verify Income presentations**

Run:

```bash
bunx vitest run tests/components/MobileIncome.test.tsx tests/components/IncomeTab.test.tsx
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: both mobile and existing desktop tests pass.

- [ ] **Step 5: Commit the Income presenter**

```bash
git add src/components/IncomeTab tests/components/MobileIncome.test.tsx tests/components/IncomeTab.test.tsx
git commit -m "feat: add phone-readable income view"
```

### Task 6: Mobile Settings, Logs, and Modal Fit

**Files:**

- Create: `src/components/RatesTab/MobileSettings.tsx`
- Modify: `src/components/RatesTab/index.tsx`
- Modify: `src/components/LogPanel/index.tsx`
- Modify: `src/components/CalendarPermissionPrompt.tsx`
- Test: `tests/components/MobileSettings.test.tsx`
- Test: `tests/components/RatesTab.test.ts`
- Test: `tests/components/CalendarPermissionPrompt.test.tsx`

**Interfaces:**

- Consumes: `layout: AppLayout` in `RatesTab` and `LogPanel`.
- Preserves: `selectedCalendarDisplayName`, calendar loading/selection, all field callbacks, dirty state, and save behavior.
- Produces: mobile Settings presenter with `config`, `isDirty`, `saveError`, field callbacks, calendar state, and studio-card callbacks.

- [ ] **Step 1: Write failing Settings and log-layout tests**

Render mobile Settings with a legacy calendar ID and mocked CalendarList response. Assert:

```tsx
expect(await findText('Classes')).toBeTruthy();
expect(document.body.textContent).not.toContain(opaqueCalendarId);
expect(namedButton('Save settings')).toBeTruthy();
expect(allFormControls().every((control) => control.classList.contains('text-base'))).toBe(true);
```

Render `LogPanel layout="mobile"`, assert the collapsed button is labelled `Open logs`, then open it and assert a labelled `Application logs` sheet exists above navigation.

Add a Calendar permission test at a 390-pixel viewport that asserts the dialog has a viewport-bounded scrolling class.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bunx vitest run tests/components/MobileSettings.test.tsx tests/components/RatesTab.test.ts tests/components/CalendarPermissionPrompt.test.tsx
```

Expected: FAIL because mobile Settings/log presentation is absent.

- [ ] **Step 3: Extract Rates field callbacks into one controller**

Keep `RatesTab` state and mutation functions where they are. Move only markup into desktop and mobile presenters. Pass explicit callbacks for teacher fields, bank fields, invoice number, calendar selection, studio rename/delete/field/color changes, and tier add/remove/update. Do not create a second copy of calendar fetching or config persistence.

`MobileSettings` uses one-column sections, 16-pixel controls, a sticky dirty/save row, touch-sized calendar selection, and existing `StudioCard` content adapted with wrapping tier rows. It must render only `selectedCalendarName`, never `calendarId`.

- [ ] **Step 4: Add mobile LogPanel and modal sizing**

The desktop LogPanel branch stays unchanged. The mobile branch renders a compact count button positioned above the bottom navigation; opening it renders a `role="dialog"`, `aria-label="Application logs"` sheet with a backdrop and Clear/Close buttons.

Add `max-h-[calc(100dvh-2rem)] overflow-y-auto` to `CalendarPermissionPrompt` and ensure its action buttons wrap on narrow widths.

- [ ] **Step 5: Verify Settings, authorization, and calendar-name behavior**

Run:

```bash
bunx vitest run tests/components/MobileSettings.test.tsx tests/components/RatesTab.test.ts tests/components/CalendarPermissionPrompt.test.tsx
bun run verify:calendar-editing
```

Expected: the opaque-ID regression, prompt behavior, settings persistence, TypeScript checks, and focused Rust checks all pass.

- [ ] **Step 6: Commit the Settings/log slice**

Stage only Task 6 changes while preserving pre-existing `RatesTab` calendar-name work as an identifiable hunk:

```bash
git add src/components/RatesTab src/components/LogPanel src/components/CalendarPermissionPrompt.tsx tests/components/MobileSettings.test.tsx tests/components/RatesTab.test.ts tests/components/CalendarPermissionPrompt.test.tsx
git commit -m "feat: adapt settings and logs for mobile"
```

### Task 7: Integrated Verification and Visual QA

**Files:**

- Modify: `tests/e2e/smoke.e2e.ts`
- Create: `design-qa.md`
- Modify: files with visual P0-P2 defects found during comparison.

**Interfaces:**

- Consumes: all mobile presenters and the three source mock-ups.
- Produces: `design-qa.md` with `final result: passed`.

- [ ] **Step 1: Add mobile-independent desktop regression assertions**

Keep the 800-pixel WebDriver flow desktop. Add assertions that the top desktop tab bar remains visible and the mobile bottom navigation is absent:

```ts
await expect($('[data-layout="desktop"]')).toBeDisplayed();
await expect($('[aria-label="Mobile navigation"]')).not.toBeExisting();
```

- [ ] **Step 2: Run the complete automated verification set**

Run:

```bash
bun test
bunx tsc --project tsconfig.app.json --noEmit
bunx tsc --project tsconfig.json --noEmit
bun run verify:calendar-editing
env -u VITE_LOTUS_E2E bun run build:vite
git diff --check
```

Expected: every command exits 0. Record exact test counts in the final handoff.

- [ ] **Step 3: Run desktop Tauri E2E**

Run:

```bash
CARGO_BUILD_JOBS=4 bun run e2e
```

Expected: desktop smoke and calendar-editing specs pass. If the known webdriver-only bridge failure recurs, record its exact output separately; do not describe the full E2E suite as passing.

- [ ] **Step 4: Launch the Android app and exercise every tab**

Start the Pixel AVD and development build:

```bash
emulator -avd Lotus_API_36
bun tauri android dev
```

On the emulator verify Calendar agenda, Calendar month, lesson sheet, Invoices, Income, Settings, Google Calendar name, refresh, bottom navigation, Back behavior, keyboard input, scroll reachability, and log sheet. Capture screenshots with:

```bash
adb exec-out screencap -p > /tmp/lotus-mobile-calendar-agenda.png
adb exec-out screencap -p > /tmp/lotus-mobile-calendar-month.png
adb exec-out screencap -p > /tmp/lotus-mobile-invoices.png
```

- [ ] **Step 5: Run blocking Product Design QA**

Invoke `product-design:design-qa`. Open each source mock-up and matching emulator screenshot at the same viewport/state. Write `design-qa.md` with sections for Calendar agenda, Calendar month/sheet, and Invoices. Each finding includes severity, visible evidence, and the exact component to change.

Fix every P0, P1, and P2 issue, recapture, and compare again. Stop only when the report ends with:

```text
final result: passed
```

- [ ] **Step 6: Re-run verification after QA fixes**

Run:

```bash
bun test
bunx tsc --project tsconfig.app.json --noEmit
bun run verify:calendar-editing
env -u VITE_LOTUS_E2E bun run build:vite
git diff --check
```

Expected: all commands exit 0 after the final visual changes.

- [ ] **Step 7: Commit integrated tests and QA evidence**

```bash
git add tests/e2e/smoke.e2e.ts design-qa.md
git commit -m "test: verify responsive mobile application"
```

- [ ] **Step 8: Handoff**

Provide links to the mobile shell, Calendar, Invoices, Income, Settings, design QA report, and captured emulator screenshots. Report desktop E2E separately from unit/type/build checks. Leave the Android development process running only if the user wants to inspect it immediately.
