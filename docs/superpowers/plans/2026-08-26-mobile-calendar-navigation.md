# Mobile Calendar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Android Calendar month-first, navigate Month → Agenda → lesson details with one-level Back behavior, and mark dates containing unconfigured classes with the approved warning SVG.

**Architecture:** Keep desktop Calendar selection unchanged and add a co-located mobile navigation hook that owns a unique history session, visible level, selected date/lesson, cleanup, and focus intent. Keep history-state parsing in a pure helper, keep date rendering in the existing mobile presenters, and let `App` pass a monotonically changing Calendar activation key for active bottom-navigation reselection.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, browser History API, Vitest/jsdom, Tauri/WebdriverIO validation.

---

## Scope and file responsibilities

- Create `src/components/CalendarTab/mobile-calendar-history.ts`: pure history tag/owner helpers; no React or DOM side effects.
- Create `src/components/CalendarTab/useMobileCalendarNavigation.ts`: mobile Month/Agenda/details state machine, owned-history traversal, reset/session rotation, responsive cleanup, and focus intent.
- Modify `src/App.tsx`: maintain mobile Calendar activation count and pass it into `CalendarTab`.
- Create `src/components/mobile/mobile-tab-state.ts`: pure active-tab/Calendar-activation transition used by `App` and tests.
- Modify `src/components/CalendarTab/index.tsx`: keep desktop selection separate; wire the mobile hook, inert Calendar content, and details sheet.
- Modify `src/components/CalendarTab/MobileCalendar.tsx`: remove mode buttons, become controlled by the mobile state machine, and coordinate date/heading/day focus.
- Modify `src/components/CalendarTab/MobileMonthGrid.tsx`: date-only taps, configured-only bars, warning SVG, accessible counts, selected-day focus target.
- Modify `src/components/CalendarTab/MobileAgenda.tsx`: expose a focusable heading/fallback.
- Modify `src/components/CalendarTab/EventDetailsCard.tsx`: mobile non-modal sheet above persistent navigation; desktop popover unchanged.
- Modify `src/components/mobile/MobileAppShell.tsx`: publish one navigation-height CSS custom property and keep bottom navigation above sheets.
- Modify `tests/components/MobileCalendar.test.tsx`: update month-first expectations and cover marker/date/Agenda behavior.
- Create `tests/components/MobileCalendarNavigation.test.tsx`: focused history, reset, focus, LogPanel, and responsive integration tests.
- Modify `tests/components/MobileAppShell.test.tsx`: active Calendar callback and persistent-nav/sheet integration.
- Create `tests/components/App-mobile-calendar.test.tsx`: App-level activation-key wiring and mobile/desktop selection integration with mocked services.
- Modify `src/components/LogPanel/index.tsx`: mobile-only stacking order above persistent navigation; preserve behavior and desktop markup.
- Modify `tests/components/CalendarPermissionPrompt.test.tsx` only for LogPanel destination-state/stacking assertions.

Do not touch or stage the pre-existing Android/generated/plugin changes listed in the approved spec.

## In-place baseline and commit-safety protocol

Before Task 1, record the exact starting state and require an empty index:

```bash
git status --short
git diff
git diff --cached
git diff --cached --quiet || { echo "Refusing to start with staged changes"; exit 1; }
git rev-parse HEAD > "$(git rev-parse --git-dir)/mobile-calendar-implementation-base"
git status --short > "$(git rev-parse --git-dir)/mobile-calendar-preexisting-status"
```

Before every implementation commit:

1. Run `git diff --cached --quiet` before staging; abort if it fails.
2. Stage only the exact paths listed for that task.
3. Inspect `git diff --cached --name-only` and `git diff --cached --check`.
4. Commit with `git commit --only ... -- <exact paths>`.
5. Confirm `git diff --cached --quiet` after the commit.

This is mandatory because the implementation is in-place beside unrelated unstaged Android/generated/plugin work.

---

### Task 1: Pure Calendar history ownership protocol

**Files:**

- Create: `src/components/CalendarTab/mobile-calendar-history.ts`
- Create: `tests/components/mobile-calendar-history.test.ts`

- [ ] **Step 1: Write failing tests for unique owners and tagged destinations**

Cover:

```ts
const first = createMobileCalendarOwnerId();
const second = createMobileCalendarOwnerId();
expect(first).not.toBe(second);

const state = calendarHistoryState({ foreign: true }, first, 'agenda');
expect(state).toEqual({
  foreign: true,
  lotusCalendar: { ownerId: first, level: 'agenda' },
});
expect(calendarHistoryLevel(state, first)).toBe('agenda');
expect(calendarHistoryLevel(state, second)).toBeNull();
```

Also cover `null`, arrays, primitive history state, malformed tags, an old owner ID, and `details`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
bunx vitest run tests/components/mobile-calendar-history.test.ts
```

Expected: FAIL because `mobile-calendar-history.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Use this public shape:

```ts
export type MobileCalendarHistoryLevel = 'agenda' | 'details';

export interface MobileCalendarHistoryEntry {
  ownerId: string;
  level: MobileCalendarHistoryLevel;
}

export function createMobileCalendarOwnerId(): string;
export function calendarHistoryState(
  currentState: unknown,
  ownerId: string,
  level: MobileCalendarHistoryLevel
): Record<string, unknown>;
export function calendarHistoryLevel(
  state: unknown,
  ownerId: string
): MobileCalendarHistoryLevel | null;
```

Create one per-runtime nonce with `globalThis.crypto.randomUUID()` and a fallback combining time plus `Math.random()`, then append a module-local incrementing counter for each mount. This prevents owner collisions with history entries surviving a document reload. Tests must stub/fallback only when needed and never depend on the exact string. Preserve foreign object keys but never mutate the input. Validate both owner and level when reading.

- [ ] **Step 4: Run the helper test and existing Calendar tests**

```bash
bunx vitest run tests/components/mobile-calendar-history.test.ts tests/components/MobileCalendar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit only the helper and test**

```bash
git diff --cached --quiet
git add src/components/CalendarTab/mobile-calendar-history.ts tests/components/mobile-calendar-history.test.ts
git diff --cached --name-only
git diff --cached --check
git commit --only -m "test: define mobile calendar history ownership" -- src/components/CalendarTab/mobile-calendar-history.ts tests/components/mobile-calendar-history.test.ts
git diff --cached --quiet
```

---

### Task 2: Unconfigured warning marker in the existing month grid

**Files:**

- Modify: `tests/components/MobileCalendar.test.tsx`
- Modify: `src/components/CalendarTab/MobileMonthGrid.tsx`
- Modify: `src/components/CalendarTab/MobileCalendar.tsx`

- [ ] **Step 1: Add failing marker/accessibility tests without changing navigation yet**

Switch to the existing Month control, then build test classes for:

- one configured lesson on August 6;
- two unconfigured lessons on August 12;
- one configured plus one unconfigured lesson on August 21.

Assert:

```ts
expect(namedButton('August 12, 2026, 2 unconfigured classes')).toBeTruthy();
expect(namedButton('August 21, 2026, 1 unconfigured class')).toBeTruthy();
expect(
  document
    .querySelector('[aria-label="Month calendar"]')
    ?.querySelectorAll('[data-unconfigured-marker="true"]')
).toHaveLength(2);
```

For each marker assert `h-3`, `w-3`, `top-[3px]`, `right-[3px]`, one SVG containing both `<circle>` and `<path>`, and `aria-hidden="true"`. Assert configured-only day has one colored bar, unconfigured-only day has no colored bar, mixed day has one bar plus one marker, and the legend contains one `Unconfigured` key only when needed.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx
```

Expected: FAIL because unconfigured lessons still render normal bars and no warning SVG/legend/accessibility count exists. Keep the current Agenda/Month controls and all existing Agenda/sheet tests green during this task.

- [ ] **Step 3: Implement the approved single SVG in `MobileMonthGrid`**

Keep `onSelectLesson` temporarily so existing navigation remains reachable until Task 3. Split each date's lessons:

```ts
const configuredLessons = lessons.filter((lesson) => !lesson.unconfigured);
const unconfiguredCount = lessons.length - configuredLessons.length;
```

The day accessible label is the plain localized date when count is zero, otherwise:

```ts
`${dateLabel(year, month, day)}, ${unconfiguredCount} unconfigured ${
  unconfiguredCount === 1 ? 'class' : 'classes'
}`;
```

Preserve the existing click branch temporarily. Render at most the first three configured bars. Add one absolute SVG per affected day:

```tsx
<svg
  data-unconfigured-marker="true"
  aria-hidden="true"
  viewBox="0 0 12 12"
  className="absolute right-[3px] top-[3px] h-3 w-3"
>
  <circle cx="6" cy="6" r="6" fill="#dc2626" />
  <path
    d="M3.88 2.82 6 4.94 8.12 2.82 9.18 3.88 7.06 6 9.18 8.12 8.12 9.18 6 7.06 3.88 9.18 2.82 8.12 4.94 6 2.82 3.88Z"
    fill="white"
  />
</svg>
```

Ensure the button is `relative`.

- [ ] **Step 4: Fix the existing Month legend without removing view controls**

List only configured studio names and append the same compact SVG plus `Unconfigured` legend entry when any class is unconfigured. The legend SVG must not carry `data-unconfigured-marker`; that attribute identifies affected day-cell markers only. Leave local mode initialization, controls, Agenda reachability, and details behavior unchanged until Task 3.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx
```

Expected: PASS with no React act warnings.

- [ ] **Step 6: Commit the warning-marker slice**

```bash
git diff --cached --quiet
git add src/components/CalendarTab/MobileCalendar.tsx src/components/CalendarTab/MobileMonthGrid.tsx tests/components/MobileCalendar.test.tsx
git diff --cached --name-only
git diff --cached --check
git commit --only -m "feat: mark unconfigured mobile calendar dates" -- src/components/CalendarTab/MobileCalendar.tsx src/components/CalendarTab/MobileMonthGrid.tsx tests/components/MobileCalendar.test.tsx
git diff --cached --quiet
```

---

### Task 3: One mobile Month → Agenda → details state machine

**Files:**

- Create: `src/components/CalendarTab/useMobileCalendarNavigation.ts`
- Create: `tests/components/MobileCalendarNavigation.test.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/components/CalendarTab/MobileCalendar.tsx`
- Modify: `src/components/CalendarTab/MobileMonthGrid.tsx`
- Modify: `src/components/CalendarTab/MobileAgenda.tsx`
- Modify: `src/components/CalendarTab/mobile-calendar.ts`
- Modify: `tests/components/MobileCalendar.test.tsx`

- [ ] **Step 1: Write failing month-first and forward-navigation tests**

In the new integration test, render mobile `CalendarTab` with one populated and one empty date. Assert:

1. Month appears initially, the Calendar view-toggle row is absent, and Agenda is absent.
2. Clicking the populated date pushes one `agenda` state and shows Agenda, not details.
3. Clicking the empty date also shows Agenda and `No lessons on this day`.
4. Selecting another date in the Agenda strip does not push another history entry.
5. Clicking an Agenda lesson pushes `details` and opens the sheet.

Spy on `window.history.pushState`, but assert the real pushed state through `calendarHistoryLevel` rather than duplicating the tag structure. Move—not delete—the existing Agenda lesson/sheet assertions from `MobileCalendar.test.tsx` as needed so useful coverage remains active while the new path changes how Agenda is reached.

- [ ] **Step 2: Run the navigation test and verify RED**

```bash
bunx vitest run tests/components/MobileCalendarNavigation.test.tsx
```

Expected: FAIL because day taps do not yet enter controlled Agenda and details use the independent legacy history path.

- [ ] **Step 3: Implement the hook's state and forward transitions**

Use a discriminated level plus selected data:

```ts
export type MobileCalendarLevel = 'month' | 'agenda' | 'details';

export interface UseMobileCalendarNavigationOptions {
  enabled: boolean;
  activationKey: number;
  year: number;
  month: number;
  classes: ParsedClass[];
}
```

The hook owns:

- `level`, initialized to `month`;
- one in-flight traversal guard so repeated Escape/backdrop/close actions issue at most one Back before a destination event;
- `selectedDate` initialized with `initialMobileDate`;
- selected lesson and its Agenda-row anchor;
- current owner ID and owned depth;
- initial-cache selection behavior currently in `MobileCalendar`;
- month changes via a new exported `selectedDateForMonth` pure helper;
- `openAgenda`, `selectAgendaDate`, `openDetails`, `closeDetails` callbacks;
- focus request/cause values consumed by presenters.

On `openAgenda`, push an owner-tagged Agenda entry before setting level. On `openDetails`, push Details and retain the Agenda row. Do not create a second `popstate` listener elsewhere.

- [ ] **Step 4: Refactor presenters and `CalendarTab` around the hook**

At this point—and not in Task 2—remove the Agenda/Month button row, remove `MobileMonthGrid.onSelectLesson`, and make every day click call the coordinated `openAgenda`. `MobileCalendar` becomes controlled:

```ts
interface Props {
  mode: 'month' | 'agenda';
  selectedDate: string;
  onOpenAgenda: (date: string, anchor: HTMLButtonElement) => void;
  onSelectAgendaDate: (date: string) => void;
  onSelectLesson: (lesson: ParsedClass, anchor: HTMLButtonElement) => void;
  // existing month/data props plus focus request props
}
```

`CalendarTab` adds `mobileActivation?: number` with a default of `0`, preserving all existing direct desktop/mobile callers while App supplies the real count. It uses separate `desktopSelected` state for desktop and the hook's selected lesson for mobile. Remove the legacy mobile lesson history ref/listener from `CalendarTab`; desktop close remains direct and never pushes history.

Add `tabIndex={-1}` and a ref/focus-request prop to the Agenda `<h2>`. A Month day click records the date and enters Agenda; the heading receives focus after render.

- [ ] **Step 5: Run navigation and legacy Calendar tests**

```bash
bunx vitest run tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileCalendar.test.tsx tests/components/CalendarTab.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Define a deterministic History API test harness**

Before each test, use `history.replaceState({ testBase: true }, '')`, clear spies, and record pushed states. Mock `history.back/go` as asynchronous requests: the test explicitly updates the real destination with `history.replaceState(destination, '')` before dispatching `new window.PopStateEvent('popstate', { state: destination })`. Restore all History methods and base state after each test so state and assertions cannot leak between cases; do not assert global `history.length`, because jsdom's accumulated stack length cannot be reset with `replaceState`.

- [ ] **Step 7: Write failing Back/focus/precedence tests**

Use destination-state `PopStateEvent`s matching actual target entries:

- Details + destination Agenda → details closes only; original lesson row focused.
- Details + refreshed classes removing the row → Agenda heading focused.
- Agenda + base/foreign destination → Month; selected day button focused.
- Month + base destination → no state update and no `history.back/go` call.
- Details explicit close/backdrop/Escape → exactly one `history.back()` while the current entry is owned; visible state changes only after destination popstate.
- If current state is foreign, explicit close removes stale details directly and never calls Back.
- Two rapid explicit close attempts before destination delivery call `history.back()` only once.
- Logs open over Agenda: the LogPanel Back destination closes Logs while Calendar remains Agenda; the next base destination returns Calendar to Month.

- [ ] **Step 8: Implement the single destination-state popstate handler**

The handler follows the spec exactly:

```ts
const destination = calendarHistoryLevel(event.state, ownerRef.current);

if (levelRef.current === 'details' && destination === 'details') return;
if (levelRef.current === 'details' && destination === 'agenda') {
  showAgendaAndRestoreLessonFocus();
  return;
}
if (levelRef.current === 'agenda' && destination === 'agenda') return;
if (levelRef.current === 'agenda') showMonthAndRestoreDayFocus();
```

Clear the in-flight guard when the expected destination arrives or when ownership is invalidated. Ignore events during invalidated-owner cleanup. Never infer a transition only from current React state when the destination says the same Calendar level.

- [ ] **Step 9: Run Back/focus tests and verify GREEN**

```bash
bunx vitest run tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileCalendar.test.tsx tests/components/CalendarTab.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit the coordinated state machine**

```bash
git diff --cached --quiet
git add src/components/CalendarTab/useMobileCalendarNavigation.ts src/components/CalendarTab/index.tsx src/components/CalendarTab/MobileCalendar.tsx src/components/CalendarTab/MobileAgenda.tsx src/components/CalendarTab/MobileMonthGrid.tsx src/components/CalendarTab/mobile-calendar.ts tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileCalendar.test.tsx
git diff --cached --name-only
git diff --cached --check
git commit --only -m "feat: coordinate mobile calendar navigation" -- src/components/CalendarTab/useMobileCalendarNavigation.ts src/components/CalendarTab/index.tsx src/components/CalendarTab/MobileCalendar.tsx src/components/CalendarTab/MobileAgenda.tsx src/components/CalendarTab/MobileMonthGrid.tsx src/components/CalendarTab/mobile-calendar.ts tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileCalendar.test.tsx
git diff --cached --quiet
```

---

### Task 4: Active Calendar reset, owner rotation, and responsive cleanup

**Files:**

- Create: `src/components/mobile/mobile-tab-state.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/components/CalendarTab/useMobileCalendarNavigation.ts`
- Modify: `tests/components/MobileAppShell.test.tsx`
- Create: `tests/components/App-mobile-calendar.test.tsx`
- Modify: `tests/components/MobileCalendarNavigation.test.tsx`

- [ ] **Step 1: Write failing activation-state tests**

Define and test the pure transition used by `App`:

```ts
export const initialMobileTabState: MobileTabState = {
  activeTab: 'calendar',
  calendarActivation: 0,
};

let state = initialMobileTabState;
state = selectMobileTab(state, 'calendar');
expect(state.calendarActivation).toBe(1);
state = selectMobileTab(state, 'calendar');
expect(state.calendarActivation).toBe(2);
state = selectMobileTab(state, 'invoices');
expect(state.activeTab).toBe('invoices');
expect(state.calendarActivation).toBe(2);
```

Also retain the existing test proving `MobileNavigation` calls `onSelect` when destinations are clicked; add an explicit active Calendar click.

- [ ] **Step 2: Write a failing App-level activation wiring test**

In `tests/components/App-mobile-calendar.test.tsx`, mock external service hooks/Tauri boundaries and lightweight non-Calendar tabs, render the real `App` under a mobile `matchMedia`, and capture the real `CalendarTab` props through a thin test mock. Prove:

1. Initial render passes `mobileActivation={0}`.
2. Clicking active Calendar passes `1` while Calendar remains active.
3. Clicking Invoices then Calendar passes `2` on return.
4. A desktop Calendar tab click does not increment activation.
5. The `handleAddStudio` route to Rates changes the active tab without incrementing Calendar activation.

Use functional state transitions in assertions so two rapid Calendar clicks cannot collapse into one increment. Mock `useConfig`, `useCalendarData`, Google authorization/editing, Drive invoice hooks/services, updater/dialog/process boundaries, and invoice-source building only as far as necessary to render App deterministically; restore modules after the file.

- [ ] **Step 3: Write failing reset/ownership tests**

Cover:

- Agenda depth one + active reset → Month and `history.go(-1)` only when current state is the expected owner Agenda entry.
- Details depth two + active reset → Month and `history.go(-2)` only when current state is expected owner Details.
- A foreign current sentinel → Month without `history.go`.
- Cleanup popstate after reset → ignored.
- Same-mount navigation after reset uses a fresh owner ID; old-owner destination cannot restore UI.
- Leaving mobile Calendar safely cleans owned contiguous depth.
- Mobile → desktop cleans/invalidate mobile state, preserves year/month, and desktop lesson click performs no history push.
- Desktop → mobile starts at Month with a fresh owner.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
bunx vitest run tests/components/MobileAppShell.test.tsx tests/components/App-mobile-calendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx
```

Expected: FAIL because App has no activation count and the hook has no reset/session-rotation cleanup.

- [ ] **Step 5: Implement mobile tab state and App wiring**

Use:

```ts
export interface MobileTabState {
  activeTab: AppTab;
  calendarActivation: number;
}

export function selectMobileTab(state: MobileTabState, tab: AppTab): MobileTabState {
  return {
    activeTab: tab,
    calendarActivation: state.calendarActivation + (tab === 'calendar' ? 1 : 0),
  };
}
```

Export `initialMobileTabState` from the helper. `App` stores this state, uses the pure transition only for mobile bottom navigation, and passes `mobileActivation={calendarActivation}` to `CalendarTab`. Use a functional state updater. Desktop tab clicks and `handleAddStudio` update only `activeTab` while retaining the current activation count.

- [ ] **Step 6: Implement safe reset/leave/responsive cleanup**

In the hook:

1. Prove the current entry matches the active owner and expected top level.
2. Invalidate that owner and suppress its cleanup destination event.
3. Call `history.go(-ownedDepth)` only when proof succeeds.
4. Otherwise reset visible state without traversal.
5. On active reset while still enabled, immediately create a fresh owner.
6. On disable/unmount, do not create the replacement until mobile enable/mount.

Do not traverse a foreign current state. Old-owner destination events are inert.

- [ ] **Step 7: Run focused and desktop regression tests**

```bash
bunx vitest run tests/components/MobileAppShell.test.tsx tests/components/App-mobile-calendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarTab.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit activation and cleanup behavior**

```bash
git diff --cached --quiet
git add src/App.tsx src/components/mobile/mobile-tab-state.ts src/components/CalendarTab/index.tsx src/components/CalendarTab/useMobileCalendarNavigation.ts tests/components/MobileAppShell.test.tsx tests/components/App-mobile-calendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx
git diff --cached --name-only
git diff --cached --check
git commit --only -m "feat: reset mobile calendar from bottom navigation" -- src/App.tsx src/components/mobile/mobile-tab-state.ts src/components/CalendarTab/index.tsx src/components/CalendarTab/useMobileCalendarNavigation.ts tests/components/MobileAppShell.test.tsx tests/components/App-mobile-calendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx
git diff --cached --quiet
```

---

### Task 5: Keep navigation operable with a non-modal lesson sheet

**Files:**

- Modify: `src/components/mobile/MobileAppShell.tsx`
- Modify: `src/components/CalendarTab/EventDetailsCard.tsx`
- Modify: `src/components/CalendarTab/index.tsx`
- Modify: `src/components/LogPanel/index.tsx`
- Modify: `tests/components/MobileAppShell.test.tsx`
- Modify: `tests/components/MobileCalendar.test.tsx`
- Modify: `tests/components/MobileCalendarNavigation.test.tsx`
- Modify: `tests/components/CalendarPermissionPrompt.test.tsx`

- [ ] **Step 1: Write failing sheet/nav accessibility tests**

Render `MobileAppShell` with a mobile `CalendarTab`, open Agenda and details, then assert:

- bottom `Calendar` button is displayed/focusable and clicking it resets to Month;
- the details dialog has no `aria-modal="true"`;
- obscured Calendar content has `inert` while the persistent navigation does not;
- the details sheet and backdrop use `bottom-[var(--mobile-navigation-height)]`;
- exact mobile stacking is Calendar backdrop `z-30` < Calendar sheet `z-40` < persistent navigation `z-50` < LogPanel backdrop `z-60` < LogPanel dialog `z-70`;
- the closed LogPanel opener remains visually/pointer-stacked below the Calendar details backdrop; the Calendar content inert boundary supplies the keyboard/assistive-technology exclusion;
- sheet initial focus still lands on the dialog;
- Tab is not trapped inside the sheet, while Escape/backdrop still close it;
- destination reset leaves focus on the Calendar bottom button.

Replace the old tests that expect forward/backward sheet focus wrapping; those semantics are intentionally removed.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bunx vitest run tests/components/MobileAppShell.test.tsx tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
```

Expected: FAIL because the current modal backdrop covers navigation, the sheet traps focus, and current z-index classes do not satisfy the full Calendar/navigation/LogPanel ordering.

- [ ] **Step 3: Define one navigation-height contract in `MobileAppShell`**

Set a root style custom property equivalent to:

```css
--mobile-navigation-height: calc(3rem + max(env(safe-area-inset-bottom), 1.5rem));
```

Use it for main-content bottom padding. Set persistent navigation to `z-50`. Use mobile-only Calendar backdrop `z-30` and sheet `z-40`, while retaining desktop popover `z-50`. Raise only the open mobile LogPanel backdrop/dialog to `z-60`/`z-70`; keep its closed opener `z-20`. Do not change safe-area padding, touch targets, LogPanel modality, or desktop LogPanel/popover stacking.

- [ ] **Step 4: Convert only the mobile details presentation to non-modal**

For `presentation="sheet"`:

- position backdrop and sheet above the nav with `bottom-[var(--mobile-navigation-height)]` and the exact `z-30`/`z-40` classes;
- remove `aria-modal`;
- remove sheet Tab-loop handling but retain Escape and initial dialog focus;
- remove the sheet's duplicate safe-area bottom padding because navigation now owns it;
- keep `role="dialog"`, label, explicit close, backdrop close, and desktop popover behavior.

Wrap the underlying mobile Calendar surface in an inert container while details are selected:

```tsx
<div inert={mobileSelected ? true : undefined}>
  <MobileCalendar ... />
</div>
```

The portal-rendered sheet and `MobileAppShell` navigation must remain outside this subtree.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
bunx vitest run tests/components/MobileAppShell.test.tsx tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit sheet/navigation behavior**

```bash
git diff --cached --quiet
git add src/components/mobile/MobileAppShell.tsx src/components/CalendarTab/EventDetailsCard.tsx src/components/CalendarTab/index.tsx src/components/LogPanel/index.tsx tests/components/MobileAppShell.test.tsx tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
git diff --cached --name-only
git diff --cached --check
git commit --only -m "fix: keep mobile navigation available above lesson details" -- src/components/mobile/MobileAppShell.tsx src/components/CalendarTab/EventDetailsCard.tsx src/components/CalendarTab/index.tsx src/components/LogPanel/index.tsx tests/components/MobileAppShell.test.tsx tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarPermissionPrompt.test.tsx
git diff --cached --quiet
```

---

### Task 6: Complete component regression and diagnostics

**Files:**

- Modify only when a failing regression has a new focused test: intended Calendar/mobile/test paths already listed above

The Logs-over-Agenda destination-state test was written RED and made GREEN in Task 3 before the handler commit. This task re-runs it with the final sheet/stacking changes; it must not defer that core behavior until after implementation.

- [ ] **Step 1: Re-run history precedence and sheet stacking coverage**

```bash
bunx vitest run tests/components/MobileCalendarNavigation.test.tsx tests/components/CalendarPermissionPrompt.test.tsx tests/components/MobileAppShell.test.tsx
```

Expected: PASS. Verify the test uses real recorded destination states, the first Back closes Logs while Agenda remains, and the final CSS-class assertions prove `z-30 < z-40 < z-50 < z-60 < z-70` without relying on jsdom hit testing.

- [ ] **Step 2: Run all component/calendar tests**

```bash
bunx vitest run tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileAppShell.test.tsx tests/components/CalendarPermissionPrompt.test.tsx tests/components/CalendarTab.test.tsx tests/components/CalendarEventEditing.test.tsx
```

Expected: PASS with no uncaught exceptions, act warnings, or focus failures.

- [ ] **Step 3: Run LSP diagnostics before broader builds**

When the implementation environment provides it, use `lsp_diagnostics` on:

- `src/App.tsx`
- `src/components/CalendarTab/`
- `src/components/mobile/`
- all changed test files

Expected: zero TypeScript errors.

- [ ] **Step 4: Commit any test-driven regression fix only if needed**

If a regression failed, first add a focused failing assertion, implement the minimum fix, and rerun the affected suite. Then follow the global index-safety protocol and use `git commit --only` with only the paths actually changed. Do not create an empty integration commit.

---

### Task 7: Simplify, verify, and inspect the in-place working tree

**Files:**

- Modify: only files already changed by Tasks 1–6 if simplification is needed
- Do not modify: unrelated Android/generated/plugin paths

- [ ] **Step 1: Invoke `superpowers:simplify` on the implementation diff**

Look specifically for duplicate history checks, stale refs, repeated focus scheduling, oversized component bodies, and duplicated warning SVG markup. Extract a small `UnconfiguredMarker` component only if it removes real duplication between grid and legend without obscuring the exact SVG.

- [ ] **Step 2: Re-run focused tests after any refactor**

```bash
bunx vitest run tests/components/mobile-calendar-history.test.ts tests/components/MobileCalendar.test.tsx tests/components/MobileCalendarNavigation.test.tsx tests/components/MobileAppShell.test.tsx tests/components/CalendarTab.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run full TypeScript and unit validation**

```bash
bun test
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: all tests pass; TypeScript exits 0.

- [ ] **Step 4: Run the project Calendar slice gate**

```bash
bun run verify:calendar-editing
```

Expected: focused frontend tests, both TypeScript projects, and focused Rust Calendar tests pass.

- [ ] **Step 5: Run the required isolated Tauri E2E suite**

```bash
bun run e2e
```

Expected: full isolated E2E suite passes. If a known webdriver/bridge infrastructure failure occurs, record its exact output and do not claim the suite passed.

- [ ] **Step 6: Run an Android emulator/device smoke check when available**

Verify:

1. Calendar opens in Month.
2. Configured/unconfigured/mixed/empty dates look correct.
3. Empty date opens Agenda with feedback.
4. Lesson details → Back → Agenda → Back → Month.
5. Logs over Agenda close before Calendar moves back.
6. Calendar reselection resets from Agenda and details.
7. Bottom navigation remains usable with details open.
8. Rotation/responsive transition returns mobile to Month without stale details.

- [ ] **Step 7: Inspect diagnostics and final diff/status**

Run:

```bash
BASE=$(cat "$(git rev-parse --git-dir)/mobile-calendar-implementation-base")
git diff --check "$BASE"..HEAD
git status --short
git diff --stat "$BASE"..HEAD
git diff "$BASE"..HEAD -- src/App.tsx src/components/CalendarTab src/components/mobile tests/components
git log --format='commit %H %s' --name-only "$BASE"..HEAD
git diff --cached --check
git diff --cached --quiet
```

Compare current unrelated-path status with `$(git rev-parse --git-dir)/mobile-calendar-preexisting-status`. Inspect every commit path from `<base>..HEAD`; no commit may contain the pre-existing Android/generated/plugin paths. Then run `lens_diagnostics` with `mode="all"` when available. The mandatory repository type gate remains `bunx tsc --project tsconfig.app.json --noEmit`.

- [ ] **Step 8: Commit final cleanup only if needed**

```bash
git diff --cached --quiet
git add <only intended Calendar/mobile/test paths changed by cleanup>
git diff --cached --name-only
git diff --cached --check
git commit --only -m "refactor: simplify mobile calendar navigation" -- <the same exact intended paths>
git diff --cached --quiet
```

Do not create an empty commit.

- [ ] **Step 9: Use `superpowers:requesting-code-review` and address blocking findings**

Provide the approved spec, this plan, implementation commits, tests run, and explicit unrelated working-tree exclusions to the reviewer. Re-run affected validation after any fix.
