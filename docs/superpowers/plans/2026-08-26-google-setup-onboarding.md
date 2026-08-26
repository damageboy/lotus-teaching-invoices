# Required Google Setup Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a configured teaching Calendar and authoritative Google Drive invoice root before unlocking Calendar, Invoices, or Income, while keeping setup available through a responsive Welcome wizard and the first section of Rates & Config.

**Architecture:** `App` owns one derived setup-readiness state plus shared Calendar and Drive picker controllers. Drive discovery runs outside the Invoices tab with an empty source set, while full invoice-source construction waits for aggregate setup readiness. Desktop and Android presenters consume the same readiness, onboarding, and picker state; only their layouts differ.

**Tech Stack:** React 19, TypeScript 5.6, Tailwind CSS 4, Vitest, Testing Library, Tauri 2, WebdriverIO, `@phosphor-icons/react` 2.1.10

**Spec:** `docs/superpowers/specs/2026-08-26-google-setup-onboarding-design.md`

## Global Constraints

- Google Drive's remote control file remains the sole authority for the selected Drive root.
- Do not add a persisted onboarding-complete flag, local Drive snapshot, or local selected-root pointer.
- Calendar is configured only when trimmed `config.calendarId` is non-empty.
- Drive is configured only when current Drive authorization exists and the current authorization incarnation has a non-null `DriveStoreSnapshot`.
- Drive discovery must be able to bootstrap and scan with `[]` before invoice sources are available.
- Do not call `buildCurrentInvoiceSources` while aggregate setup is incomplete or unavailable.
- After session-only dismissal, Rates & Config remains enabled and Calendar, Invoices, Income, Calendar Refresh, and equivalent mobile actions remain disabled.
- Invoices renders no content at all when Drive is confirmed unconfigured.
- Suppress `CalendarPermissionPrompt` until aggregate setup is ready.
- Use `CalendarBlank` and `GoogleDriveLogo` for the Welcome stepper and Connections rows; step state must also be expressed in text.
- Preserve stale-async defenses for Calendar A to B to A changes, Drive authorization incarnation changes, and picker close/reopen sessions.
- Keep Android body text at least 16 pixels, actions at least 48 by 48 pixels, and safe-area-aware vertical sizing.
- Do not modify or stage the unrelated `AGENTS.md` edit or generated `src-tauri/plugins/lotus-mobile/android/.tauri/` and `src-tauri/plugins/lotus-mobile/android/build/` directories.
- Reserve `bun run e2e` for the final integrated checkpoint; use focused Vitest and TypeScript gates for intermediate commits.

## File Structure

### New files

- `src/lib/setup/readiness.ts` — pure Calendar/Drive readiness derivation.
- `src/hooks/useSetupOnboarding.ts` — session-only dismissal and current Welcome step.
- `src/hooks/useCalendarPicker.ts` — shared, stale-safe Calendar listing and durable selection controller.
- `src/hooks/useDriveFolderController.ts` — shared Drive authorization, dialog session, activation, config-cleanup retry, and error controller.
- `src/components/setup/SetupWizard.tsx` — responsive desktop/Android two-step modal.
- `src/components/setup/ConnectionsSection.tsx` — responsive Calendar and Drive rows for Rates & Config.
- `src/components/setup/DriveFolderDialog.tsx` — the existing staged Drive browser relocated out of the Invoices feature.
- `tests/lib/setup/readiness.test.ts` — readiness truth table.
- `tests/hooks/useSetupOnboarding.test.tsx` — dismissal, step advancement, remount, and completion-origin behavior.
- `tests/hooks/useCalendarPicker.test.tsx` — interactive listing, durable save, error, cancellation, and stale completion tests.
- `tests/hooks/useDriveFolderController.test.tsx` — authorization, empty-source scan, activation, retry, and session isolation tests.
- `tests/components/SetupWizard.test.tsx` — copy, icons, focus, Escape/Back, nested picker, and responsive behavior.
- `tests/components/ConnectionsSection.test.tsx` — ordering, labels, status, actions, and layout tests.
- `tests/components/App-setup.test.tsx` — App-owned checking, gating, navigation, source-build, and prompt-suppression integration tests.

### Existing files changed

- `src/hooks/useDriveInvoices.ts:35-45,168-552` — separate initial discovery from Invoices-only foreground refresh.
- `src/App.tsx:1-326` — instantiate controllers, derive readiness, gate sources/navigation, render both setup surfaces, and own the relocated dialog.
- `src/components/RatesTab/index.tsx:1-431` — consume shared controllers and render Connections before Teacher.
- `src/components/RatesTab/MobileSettings.tsx:408-628` — accept the Connections node before Teacher and remove the old Calendar section.
- `src/components/InvoicesTab/index.tsx:1-629` — remove Drive setup ownership and return an empty surface when unconfigured.
- `src/components/InvoicesTab/MobileInvoices.tsx:27-151` — remove root display and Drive-folder setup prompt/actions.
- `src/components/mobile/MobileNavigation.tsx:1-45` — expose native disabled destinations with a lock indicator.
- `src/components/mobile/MobileAppShell.tsx:6-101` — forward disabled destinations and disable/suppress Calendar shell actions during setup.
- `tests/hooks/useDriveInvoices.test.tsx` — prove background discovery and Invoices-only focus refresh.
- `tests/components/DriveFolderDialog.test.tsx` — update import path and add Android Back ownership.
- `tests/components/RatesTab-calendar-picker.test.tsx` — update to the shared Calendar controller contract.
- `tests/components/RatesTab.test.ts` — keep existing Rates logic coverage compiling with the new props.
- `tests/components/MobileSettings.test.tsx` — assert Connections precedes Teacher and all touch targets remain safe.
- `tests/components/InvoicesTab.test.tsx` — replace setup-button expectations with an exact empty-surface assertion.
- `tests/components/MobileInvoices.test.tsx` — replace mobile setup-card expectations with an exact empty-surface assertion.
- `tests/components/MobileAppShell.test.tsx` — verify disabled destinations and Calendar refresh suppression.
- `tests/components/App-mobile-calendar.test.tsx` — provide a ready setup fixture so existing Calendar-activation behavior remains covered.
- `tests/e2e/smoke.e2e.ts` — make incomplete first launch and gated navigation the smoke baseline.
- `tests/e2e/drive-invoices.e2e.ts` — select/replace Drive roots through Welcome or Rates & Config rather than Invoices.

---

### Task 1: Pure Setup Readiness

**Files:**

- Create: `src/lib/setup/readiness.ts`
- Create: `tests/lib/setup/readiness.test.ts`

**Interfaces:**

- Consumes: `DriveInvoicesStatus` from `src/hooks/useDriveInvoices.ts` and `DriveStoreSnapshot` from `src/lib/drive/invoiceStore.ts` as type-only inputs.
- Produces: `SetupStep`, `SetupReadinessStatus`, `SetupReadiness`, `SetupReadinessInput`, and `deriveSetupReadiness(input)` for App and onboarding.

- [ ] **Step 1: Write the failing readiness truth-table tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveSetupReadiness,
  type SetupReadinessInput,
} from '../../../src/lib/setup/readiness.js';

const base: SetupReadinessInput = {
  configLoading: false,
  calendarId: 'teaching@example.test',
  authorizationLoading: false,
  hasDrive: true,
  driveStatus: 'ready',
  driveSnapshot: {} as SetupReadinessInput['driveSnapshot'],
};

describe('deriveSetupReadiness', () => {
  it('waits for config, authorization, and authorized Drive discovery', () => {
    expect(deriveSetupReadiness({ ...base, configLoading: true }).status).toBe('checking');
    expect(deriveSetupReadiness({ ...base, authorizationLoading: true }).status).toBe('checking');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'loading', driveSnapshot: null }).status
    ).toBe('checking');
  });

  it('requires a non-blank Calendar id and a current authorized snapshot', () => {
    expect(deriveSetupReadiness({ ...base, calendarId: '  ' })).toMatchObject({
      status: 'incomplete',
      calendarConfigured: false,
      firstIncompleteStep: 'calendar',
    });
    expect(deriveSetupReadiness({ ...base, hasDrive: false, driveSnapshot: null })).toMatchObject({
      status: 'incomplete',
      driveConfigured: false,
      firstIncompleteStep: 'drive',
    });
  });

  it('separates a failed initial discovery from a missing remote root', () => {
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'offline', driveSnapshot: null }).status
    ).toBe('unavailable');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'blocked', driveSnapshot: null }).status
    ).toBe('unavailable');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'unconfigured', driveSnapshot: null }).status
    ).toBe('incomplete');
  });

  it('keeps a loaded root configured through a later transient Drive error', () => {
    expect(deriveSetupReadiness({ ...base, driveStatus: 'offline' })).toMatchObject({
      status: 'ready',
      driveConfigured: true,
      firstIncompleteStep: null,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `bunx vitest run tests/lib/setup/readiness.test.ts`

Expected: FAIL because `src/lib/setup/readiness.ts` does not exist.

- [ ] **Step 3: Implement the exact readiness derivation**

```ts
import type { DriveInvoicesStatus } from '../../hooks/useDriveInvoices.js';
import type { DriveStoreSnapshot } from '../drive/invoiceStore.js';

export type SetupStep = 'calendar' | 'drive';
export type SetupReadinessStatus = 'checking' | 'incomplete' | 'ready' | 'unavailable';

export interface SetupReadinessInput {
  configLoading: boolean;
  calendarId?: string;
  authorizationLoading: boolean;
  hasDrive: boolean;
  driveStatus: DriveInvoicesStatus;
  driveSnapshot: DriveStoreSnapshot | null;
}

export interface SetupReadiness {
  status: SetupReadinessStatus;
  calendarConfigured: boolean;
  driveConfigured: boolean;
  firstIncompleteStep: SetupStep | null;
}

export function deriveSetupReadiness(input: SetupReadinessInput): SetupReadiness {
  const calendarConfigured = Boolean(input.calendarId?.trim());
  const driveConfigured = input.hasDrive && input.driveSnapshot !== null;
  const firstIncompleteStep = !calendarConfigured ? 'calendar' : !driveConfigured ? 'drive' : null;

  if (
    input.configLoading ||
    input.authorizationLoading ||
    (input.hasDrive && input.driveSnapshot === null && input.driveStatus === 'loading')
  ) {
    return { status: 'checking', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  if (calendarConfigured && driveConfigured) {
    return { status: 'ready', calendarConfigured, driveConfigured, firstIncompleteStep: null };
  }
  if (
    input.hasDrive &&
    input.driveSnapshot === null &&
    (input.driveStatus === 'offline' || input.driveStatus === 'blocked')
  ) {
    return { status: 'unavailable', calendarConfigured, driveConfigured, firstIncompleteStep };
  }
  return { status: 'incomplete', calendarConfigured, driveConfigured, firstIncompleteStep };
}
```

- [ ] **Step 4: Run the focused test and type-check the module**

Run: `bunx vitest run tests/lib/setup/readiness.test.ts && bunx tsc --project tsconfig.app.json --noEmit`

Expected: readiness tests PASS and frontend TypeScript exits 0.

- [ ] **Step 5: Commit the readiness model**

```bash
git add src/lib/setup/readiness.ts tests/lib/setup/readiness.test.ts
git commit -m "feat: derive required Google setup readiness"
```

### Task 2: Drive Discovery Outside Invoices

**Files:**

- Modify: `src/hooks/useDriveInvoices.ts:35-45,168-552`
- Modify: `src/App.tsx:80-90`
- Modify: `tests/hooks/useDriveInvoices.test.tsx`

**Interfaces:**

- Consumes: the existing `DriveInvoiceStoreController`, source signature, authorization incarnation, and async-context guards.
- Produces: `UseDriveInvoicesOptions.discoveryEnabled` for one initial bootstrap and `foregroundRefreshEnabled` for focus/visibility refresh only while Invoices is active.

- [ ] **Step 1: Add failing hook tests for separated discovery and foreground refresh**

Add tests using the existing hook harness and store double:

```ts
it('bootstraps an authorized root while Invoices is inactive', async () => {
  const store = storeDouble();
  store.bootstrap.mockResolvedValueOnce(snapshotFor('background'));
  const { result } = renderHook(() =>
    useDriveInvoices({
      store,
      sources: [],
      sourceContextKey: 'setup-discovery',
      authorizationIncarnation: 4,
      discoveryEnabled: true,
      foregroundRefreshEnabled: false,
    })
  );

  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(store.bootstrap).toHaveBeenCalledOnce();
  expect(store.bootstrap).toHaveBeenCalledWith([]);
});

it('refreshes on focus only while foreground refresh is enabled', async () => {
  const store = storeDouble();
  store.bootstrap.mockResolvedValueOnce(snapshotFor('background'));
  store.refresh.mockResolvedValue(snapshotFor('focused'));
  const view = renderHook(
    ({ foregroundRefreshEnabled }) =>
      useDriveInvoices({
        store,
        sources: [],
        sourceContextKey: 'setup-discovery',
        authorizationIncarnation: 4,
        discoveryEnabled: true,
        foregroundRefreshEnabled,
      }),
    { initialProps: { foregroundRefreshEnabled: false } }
  );
  await waitFor(() => expect(view.result.current.status).toBe('ready'));

  window.dispatchEvent(new Event('focus'));
  expect(store.refresh).not.toHaveBeenCalled();
  view.rerender({ foregroundRefreshEnabled: true });
  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(store.refresh).toHaveBeenCalledOnce());
});
```

- [ ] **Step 2: Run the focused hook suite and verify the option-shape failure**

Run: `bunx vitest run tests/hooks/useDriveInvoices.test.tsx`

Expected: FAIL because the hook still accepts only `active`.

- [ ] **Step 3: Split discovery from foreground behavior without weakening async guards**

Replace the option field and the two effect checks:

```ts
export interface UseDriveInvoicesOptions {
  store: DriveInvoiceStoreController;
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  authorizationIncarnation: number;
  discoveryEnabled: boolean;
  foregroundRefreshEnabled: boolean;
}

useEffect(() => {
  if (options.discoveryEnabled) void runRefresh().catch(() => undefined);
}, [
  options.discoveryEnabled,
  options.authorizationIncarnation,
  options.store,
  signature,
  runRefresh,
]);

useEffect(() => {
  const onVisibilityChange = (): void => {
    if (committedOptionsRef.current.foregroundRefreshEnabled && isVisible()) {
      void runRefresh().catch(() => undefined);
    }
  };
  const onFocus = (): void => {
    if (committedOptionsRef.current.foregroundRefreshEnabled && isVisible()) {
      void runRefresh().catch(() => undefined);
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
  };
}, [runRefresh]);
```

In `runRefresh`, make cold discovery independent of invoice validation:

```ts
const snapshot = hasSnapshot ? await store.refresh(sources) : await store.bootstrap([]);
```

This is the only cold-bootstrap source argument. Once setup is ready and the real source signature is published, the signature change runs a normal `refresh(sources)` against the discovered snapshot.

In `App`, preserve the current source behavior for this intermediate commit while changing the call:

```ts
const driveInvoices = useDriveInvoices({
  store: driveStore,
  sources: invoiceSources,
  sourceContextKey: invoiceSourceInputKey,
  authorizationIncarnation: googleAuthorization.authorizationIncarnation,
  discoveryEnabled: !googleAuthorization.isLoading && googleAuthorization.hasDrive,
  foregroundRefreshEnabled: activeTab === 'invoices' && invoiceSourcesReady,
});
```

Do not alter the semantic-incarnation, action-error precedence, mutation queue, or context validation code.

- [ ] **Step 4: Update old inactive-hook assertions and run the Drive hook gate**

Change old tests that equated `active: false` with no bootstrap: use `discoveryEnabled: false` for no bootstrap, and use `foregroundRefreshEnabled: false` only for no focus refresh. Update cold-bootstrap assertions to expect `[]`; keep refresh and activation assertions on the current full source list.

Run: `bunx vitest run tests/hooks/useDriveInvoices.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: hook tests PASS and frontend TypeScript exits 0.

- [ ] **Step 5: Commit background Drive discovery**

```bash
git add src/hooks/useDriveInvoices.ts src/App.tsx tests/hooks/useDriveInvoices.test.tsx
git commit -m "feat: discover Drive setup before opening invoices"
```

### Task 3: Shared Calendar Picker Controller

**Files:**

- Create: `src/hooks/useCalendarPicker.ts`
- Create: `tests/hooks/useCalendarPicker.test.tsx`
- Modify: `src/components/RatesTab/index.tsx:1-118,350-416`
- Modify: `tests/components/RatesTab-calendar-picker.test.tsx`
- Modify: `src/App.tsx:35-44,250-260`

**Interfaces:**

- Consumes: current `AppConfig`, `listCalendars`, `calendarErrorMessage`, and `saveOrThrow(nextConfig)`.
- Produces: `CalendarPickerController` with `calendars`, `listOpen`, `loading`, `saving`, `error`, `selectedName`, `openList()`, `select(calendar)`, and `closeList()`; `RatesTab` consumes that controller.

- [ ] **Step 1: Write failing controller tests**

Create these concrete fixtures at the top of the new test file:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const unconfiguredConfig: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {},
};

const dependencies = { listCalendars: vi.fn<typeof listCalendars>() };

beforeEach(() => {
  dependencies.listCalendars.mockReset();
  dependencies.listCalendars.mockResolvedValue([]);
});
```

```ts
it('does not publish a Calendar selection until durable save succeeds', async () => {
  const pending = deferred<void>();
  const saveConfig = vi.fn(() => pending.promise);
  const view = renderHook(() =>
    useCalendarPicker({ config: unconfiguredConfig, saveConfig }, dependencies)
  );
  await act(() => view.result.current.openList());
  let selection!: Promise<void>;
  act(() => {
    selection = view.result.current.select({
      id: 'calendar-a',
      summary: 'Teaching',
      accessRole: 'owner',
    });
  });

  expect(saveConfig).toHaveBeenCalledWith(
    expect.objectContaining({ calendarId: 'calendar-a', calendarName: 'Teaching' })
  );
  expect(view.result.current.listOpen).toBe(true);
  await act(async () => {
    pending.resolve();
    await selection;
  });
  expect(view.result.current.listOpen).toBe(false);
});

it('keeps the list open and reports a failed config save', async () => {
  const saveConfig = vi.fn(async () => {
    throw new Error('disk full');
  });
  const view = renderHook(() =>
    useCalendarPicker({ config: unconfiguredConfig, saveConfig }, dependencies)
  );
  await act(() => view.result.current.openList());
  await act(() =>
    view.result.current.select({ id: 'calendar-a', summary: 'Teaching', accessRole: 'owner' })
  );
  expect(view.result.current.error).toBe('disk full');
  expect(view.result.current.listOpen).toBe(true);
});

it('ignores a list or save completion from an older close/reopen session', async () => {
  const first = deferred<CalendarListEntry[]>();
  const second = deferred<CalendarListEntry[]>();
  dependencies.listCalendars.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = renderHook(() =>
    useCalendarPicker({ config: unconfiguredConfig, saveConfig: vi.fn() }, dependencies)
  );
  act(() => {
    void view.result.current.openList();
  });
  act(() => view.result.current.closeList());
  act(() => {
    void view.result.current.openList();
  });
  first.resolve([{ id: 'stale', summary: 'Stale' }]);
  second.resolve([{ id: 'current', summary: 'Current' }]);
  await waitFor(() => expect(view.result.current.calendars?.[0]?.id).toBe('current'));
});
```

Also add a rerender test for Calendar A to B to A that proves the first A request cannot publish into the second A incarnation.

- [ ] **Step 2: Run the hook test and verify the missing controller failure**

Run: `bunx vitest run tests/hooks/useCalendarPicker.test.tsx`

Expected: FAIL because `useCalendarPicker` does not exist.

- [ ] **Step 3: Implement the controller with a monotonic context and no speculative config update**

Use this public contract:

```ts
export interface CalendarPickerController {
  calendars: readonly CalendarListEntry[] | null;
  listOpen: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  selectedName: string;
  openList(): Promise<void>;
  select(calendar: CalendarListEntry): Promise<void>;
  closeList(): void;
}

export interface UseCalendarPickerOptions {
  config: AppConfig;
  saveConfig(next: AppConfig): Promise<void>;
}

export interface CalendarPickerDependencies {
  listCalendars: typeof listCalendars;
}
```

Export `useCalendarPicker(options: UseCalendarPickerOptions, dependencies: CalendarPickerDependencies = { listCalendars }): CalendarPickerController` with that exact signature.

Update the existing test `options()` helper to use the same two fields:

```ts
function options(
  overrides: Partial<{
    store: StoreDouble;
    sources: readonly CurrentInvoiceSource[];
    sourceContextKey: string;
    authorizationIncarnation: number;
    discoveryEnabled: boolean;
    foregroundRefreshEnabled: boolean;
  }> = {}
) {
  return {
    store: overrides.store ?? storeDouble(),
    sources: overrides.sources ?? [source()],
    sourceContextKey: overrides.sourceContextKey ?? 'calendar-input-a',
    authorizationIncarnation: overrides.authorizationIncarnation ?? 1,
    discoveryEnabled: overrides.discoveryEnabled ?? true,
    foregroundRefreshEnabled: overrides.foregroundRefreshEnabled ?? true,
  };
}
```

The selection path must build the complete next config, save it first, and close only for the still-current request:

```ts
const next: AppConfig = {
  ...configWithoutAccessRole,
  calendarId: calendar.id,
  calendarName: calendar.summary,
  ...(calendar.accessRole ? { calendarAccessRole: calendar.accessRole } : {}),
};
const request = ++requestRef.current;
setSaving(true);
setError(null);
try {
  await options.saveConfig(next);
  if (request !== requestRef.current) return;
  setListOpen(false);
} catch (cause) {
  if (request === requestRef.current) setError(calendarErrorMessage(cause));
} finally {
  if (request === requestRef.current) setSaving(false);
}
```

`openList()` and `select()` publish their own errors and resolve after a handled failure so button handlers do not create unhandled rejections. Increment a separate semantic-incarnation ref in a layout effect when the effective Calendar identity changes; every async completion validates both request and incarnation. Preserve the existing non-interactive name lookup when `calendarId` exists but `calendarName` is blank.

- [ ] **Step 4: Lift controller ownership into App and simplify RatesTab**

In App:

```ts
const calendarPicker = useCalendarPicker({ config, saveConfig: saveOrThrow });
```

Add `calendarPicker: CalendarPickerController` to `RatesTab` props. Remove RatesTab's local Calendar list/loading/error state and helper functions, then bind the existing desktop/mobile Calendar UI to the controller. Keep the normal Rates Save button on `save`; Calendar selection specifically uses App's throwing save path.

- [ ] **Step 5: Run Calendar controller, Rates, and TypeScript tests**

Run: `bunx vitest run tests/hooks/useCalendarPicker.test.tsx tests/components/RatesTab-calendar-picker.test.tsx tests/components/RatesTab.test.ts tests/components/MobileSettings.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: focused tests PASS and frontend TypeScript exits 0.

- [ ] **Step 6: Commit the shared Calendar controller**

```bash
git add src/hooks/useCalendarPicker.ts src/components/RatesTab/index.tsx src/App.tsx tests/hooks/useCalendarPicker.test.tsx tests/components/RatesTab-calendar-picker.test.tsx tests/components/RatesTab.test.ts tests/components/MobileSettings.test.tsx
git commit -m "refactor: share Calendar setup controller"
```

### Task 4: Shared Drive Folder Controller and Dialog Boundary

**Files:**

- Create: `src/hooks/useDriveFolderController.ts`
- Create: `tests/hooks/useDriveFolderController.test.tsx`
- Create: `src/components/setup/DriveFolderDialog.tsx`
- Delete: `src/components/InvoicesTab/DriveFolderDialog.tsx`
- Modify: `src/App.tsx:18-31,80-90,231-248,268-326`
- Modify: `src/components/InvoicesTab/index.tsx:1-62,227-254,404-423,615-627`
- Modify: `tests/components/DriveFolderDialog.test.tsx`
- Modify: `tests/components/InvoicesTab.test.tsx`

**Interfaces:**

- Consumes: `DriveInvoicesState`, Google Drive authorization action, current config, `saveOrThrow`, the current invoice-source context, `scanFinalFolder`, `DriveFolderService`, and the existing staged `DriveFolderDialog` contract.
- Produces: `DriveFolderController` shared by Welcome and Connections; App owns the one dialog instance.

- [ ] **Step 1: Write failing controller tests for authorization, stale sessions, and cleanup retry**

Create these local fixtures in `tests/hooks/useDriveFolderController.test.tsx`:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const config: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  calendarId: 'calendar-a',
  lastInvoice: '8/2026',
  studios: {},
};

const stagedRoot = {
  root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' },
  rootFile: { id: 'root-a', name: 'Lotus invoices' },
  finalFolder: { id: 'final-a', name: 'Final' },
} as StagedDriveRoot;

function emptyScan(): DriveInvoiceScan {
  return { entries: [], warnings: [], blockingConflicts: [], maxSequenceByYear: {} };
}

function driveState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'unconfigured' as const,
    snapshot: null,
    error: null,
    operationKey: null,
    refresh: vi.fn(async () => undefined),
    activateRoot: vi.fn(async () => undefined),
    ...overrides,
  };
}

function options(
  overrides: Partial<UseDriveFolderControllerOptions> = {}
): UseDriveFolderControllerOptions {
  return {
    hasDriveAuthorization: true,
    authorizeDrive: vi.fn(async () => undefined),
    drive: driveState(),
    config,
    saveConfig: vi.fn(async () => undefined),
    sources: [],
    sourceContextKey: 'setup-discovery',
    scanCandidate: vi.fn(async () => emptyScan()),
    ...overrides,
  };
}
```

```ts
it('authorizes before opening and ignores completion after close/reopen', async () => {
  const first = deferred<void>();
  const authorizeDrive = vi.fn(() => first.promise);
  const view = renderHook(() =>
    useDriveFolderController({ ...options(), hasDriveAuthorization: false, authorizeDrive })
  );
  let staleOpen!: Promise<void>;
  act(() => {
    staleOpen = view.result.current.openDialog();
  });
  act(() => view.result.current.closeDialog());
  await act(async () => {
    first.resolve();
    await staleOpen;
  });
  expect(view.result.current.dialogOpen).toBe(false);
});

it('activates remotely once when legacy-config cleanup needs a retry', async () => {
  const activateRoot = vi.fn(async () => undefined);
  const saveConfig = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(undefined);
  const view = renderHook(() =>
    useDriveFolderController({ ...options(), drive: driveState({ activateRoot }), saveConfig })
  );
  await expect(view.result.current.confirmRoot(stagedRoot)).rejects.toThrow('disk full');
  await view.result.current.confirmRoot(stagedRoot);
  expect(activateRoot).toHaveBeenCalledOnce();
  expect(saveConfig).toHaveBeenCalledTimes(2);
  expect(saveConfig).toHaveBeenLastCalledWith(withoutLegacyInvoiceStorage(config));
});

it('scans with an empty source list when invoice sources are unavailable', async () => {
  const scanCandidate = vi.fn(async () => emptyScan());
  const view = renderHook(() =>
    useDriveFolderController({
      ...options(),
      sources: [],
      sourceContextKey: 'setup-discovery',
      scanCandidate,
    })
  );
  await view.result.current.scanCandidate(stagedRoot);
  expect(scanCandidate).toHaveBeenCalledWith(stagedRoot, []);
});
```

Add a source-context A to B to A rerender test: resolve the first A scan after the second A incarnation begins and assert that the old completion rejects as obsolete rather than publishing into the reopened/current dialog.

- [ ] **Step 2: Run the focused controller test and verify the missing module failure**

Run: `bunx vitest run tests/hooks/useDriveFolderController.test.tsx`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller contract and idempotent cleanup retry**

```ts
export interface DriveFolderController {
  dialogOpen: boolean;
  opening: boolean;
  error: string | null;
  openDialog(): Promise<void>;
  closeDialog(): void;
  scanCandidate(stagedRoot: StagedDriveRoot): Promise<DriveInvoiceScan>;
  confirmRoot(stagedRoot: StagedDriveRoot): Promise<void>;
  retry(): Promise<void>;
}

export interface UseDriveFolderControllerOptions {
  hasDriveAuthorization: boolean;
  authorizeDrive(): Promise<void>;
  drive: Pick<
    DriveInvoicesState,
    'status' | 'snapshot' | 'error' | 'operationKey' | 'refresh' | 'activateRoot'
  >;
  config: AppConfig;
  saveConfig(next: AppConfig): Promise<void>;
  sources: readonly CurrentInvoiceSource[];
  sourceContextKey: string;
  scanCandidate(
    stagedRoot: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveInvoiceScan>;
}

interface PendingConfigCleanup {
  rootKey: string;
  config: AppConfig;
}
```

Track a monotonic source incarnation from `sourceContextKey` plus the sorted source fingerprints. `DriveFolderController.scanCandidate(stagedRoot)` captures the incarnation and current sources, awaits the dependency, and rejects with `Current invoice sources changed before the Drive folder scan completed` unless the captured incarnation is still current.

`openDialog()` requests Drive authorization only when `hasDriveAuthorization` is false or Drive reports `authorizationRequired`, and opens only if its request token remains current. `confirmRoot()` must:

```ts
const rootKey = `${stagedRoot.root.driveId ?? 'my-drive'}:${stagedRoot.root.folderId}`;
let pending = pendingCleanupRef.current;
if (pending?.rootKey !== rootKey) {
  if (pending !== null) {
    await options.saveConfig(pending.config);
    pendingCleanupRef.current = null;
  }
  await options.drive.activateRoot(stagedRoot, options.config.lastInvoice);
  pending = {
    rootKey,
    config: withoutLegacyInvoiceStorage(options.config),
  };
  pendingCleanupRef.current = pending;
}
await options.saveConfig(pending.config);
pendingCleanupRef.current = null;
```

On failure, publish the specific error and rethrow so `DriveFolderDialog` stays on its confirm phase. `retry()` saves pending config cleanup first; otherwise it calls `drive.refresh()`.

- [ ] **Step 4: Relocate DriveFolderDialog and add Android Back ownership**

Move the component to `src/components/setup/DriveFolderDialog.tsx`, adjust relative imports, preserve all browse/scan/confirm behavior, and update the test import. For mobile layout, push one history entry when the dialog opens and consume `popstate` by calling the existing stale-safe close function. Do not dismiss the underlying Welcome wizard from the same Back event.

Add this focused test:

```ts
it('owns Android Back while the mobile folder dialog is open', async () => {
  const onClose = vi.fn();
  render(<DriveFolderDialog {...dialogProps({ layout: 'mobile', onClose })} />);
  fireEvent.popState(window);
  expect(onClose).toHaveBeenCalledOnce();
});
```

- [ ] **Step 5: Let App own the controller and single dialog instance**

Instantiate the controller in App. Its scan callback must never throw merely because invoice-source construction is pending or failed:

```ts
const driveFolder = useDriveFolderController({
  hasDriveAuthorization: googleAuthorization.hasDrive,
  authorizeDrive: googleAuthorization.allowDrive,
  drive: driveInvoices,
  config,
  saveConfig: saveOrThrow,
  sources: invoiceSourcesReady ? invoiceSources : [],
  sourceContextKey: invoiceSourcesReady ? invoiceSourceInputKey : 'setup-discovery',
  scanCandidate: (stagedRoot, sources) => scanFinalFolder(driveApi, stagedRoot, sources),
});
```

Render `DriveFolderDialog` once at App root with `driveFolder.dialogOpen`, `driveFolder.scanCandidate`, `driveFolder.confirmRoot`, and `driveFolder.closeDialog`. Replace InvoicesTab's local dialog/authorization state with a temporary `onChooseDriveFolder={driveFolder.openDialog}` prop; the visible control moves in Task 5.

- [ ] **Step 6: Run controller, dialog, Invoices, and TypeScript tests**

Run: `bunx vitest run tests/hooks/useDriveFolderController.test.tsx tests/components/DriveFolderDialog.test.tsx tests/components/InvoicesTab.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: focused tests PASS and frontend TypeScript exits 0.

- [ ] **Step 7: Commit the shared Drive setup boundary**

```bash
git add src/hooks/useDriveFolderController.ts src/components/setup/DriveFolderDialog.tsx src/components/InvoicesTab/DriveFolderDialog.tsx src/App.tsx src/components/InvoicesTab/index.tsx tests/hooks/useDriveFolderController.test.tsx tests/components/DriveFolderDialog.test.tsx tests/components/InvoicesTab.test.tsx
git commit -m "refactor: share Drive folder setup controller"
```

### Task 5: Connections First and Empty Unconfigured Invoices

**Files:**

- Create: `src/components/setup/ConnectionsSection.tsx`
- Create: `tests/components/ConnectionsSection.test.tsx`
- Modify: `src/components/RatesTab/index.tsx:13-20,258-416`
- Modify: `src/components/RatesTab/MobileSettings.tsx:408-628`
- Modify: `src/components/InvoicesTab/index.tsx:48-61,237-254,404-493,615-627`
- Modify: `src/components/InvoicesTab/MobileInvoices.tsx:27-151`
- Modify: `src/App.tsx:231-260`
- Modify: `tests/components/RatesTab-calendar-picker.test.tsx`
- Modify: `tests/components/MobileSettings.test.tsx`
- Modify: `tests/components/InvoicesTab.test.tsx`
- Modify: `tests/components/MobileInvoices.test.tsx`

**Interfaces:**

- Consumes: `CalendarPickerController`, `DriveFolderController`, and the status/snapshot/error/operation fields of `DriveInvoicesState`.
- Produces: `ConnectionsSection`; RatesTab accepts `calendarPicker`, `drive`, and `driveFolder`; InvoicesTab no longer accepts setup services/actions.

- [ ] **Step 1: Write failing Connections ordering and action tests**

Create exact controller fixtures in the new component test:

```ts
function calendarController(
  overrides: Partial<CalendarPickerController> = {}
): CalendarPickerController {
  return {
    calendars: null,
    listOpen: false,
    loading: false,
    saving: false,
    error: null,
    selectedName: 'Not configured',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
    ...overrides,
  };
}

function driveController(overrides: Partial<DriveFolderController> = {}): DriveFolderController {
  return {
    dialogOpen: false,
    opening: false,
    error: null,
    openDialog: vi.fn(async () => undefined),
    closeDialog: vi.fn(),
    scanCandidate: vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    })),
    confirmRoot: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    ...overrides,
  };
}

function configuredSnapshot(folderName: string): DriveStoreSnapshot {
  return {
    stagedRoot: { root: { folderId: 'root-a', driveId: null, folderName } },
  } as DriveStoreSnapshot;
}

function driveState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'unconfigured' as const,
    snapshot: null,
    error: null,
    operationKey: null,
    ...overrides,
  };
}

function props(overrides: Partial<ConnectionsSectionProps> = {}): ConnectionsSectionProps {
  return {
    layout: 'desktop',
    calendarConfigured: false,
    calendarPicker: calendarController(),
    drive: driveState(),
    driveFolder: driveController(),
    ...overrides,
  };
}
```

```ts
it.each(['desktop', 'mobile'] as const)('renders both Connections rows on %s', (layout) => {
  render(<ConnectionsSection {...props({ layout })} />);
  const text = document.body.textContent ?? '';
  expect(text.indexOf('Connections')).toBeGreaterThanOrEqual(0);
  expect(text).toContain('Google Calendar');
  expect(text).toContain('Google Drive');
  expect(text).toContain('Not configured');
  expect(screen.getByRole('button', { name: 'Pick calendar…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pick Drive folder…' })).toBeTruthy();
});

it('shows configured names, Change actions, a Drive error, and Retry', async () => {
  const onRetry = vi.fn();
  render(
    <ConnectionsSection
      {...props({
        calendarConfigured: true,
        calendarPicker: calendarController({ selectedName: 'Teaching' }),
        drive: driveState({ status: 'offline', snapshot: configuredSnapshot('Lotus invoices') }),
        driveFolder: driveController({ error: 'Google Drive is temporarily unavailable', retry: onRetry }),
      })}
    />
  );
  expect(document.body.textContent).toContain('Teaching');
  expect(document.body.textContent).toContain('Lotus invoices');
  expect(document.body.textContent).toContain('Google Drive is temporarily unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry Google Drive' }));
  expect(onRetry).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the component test and verify the missing component failure**

Run: `bunx vitest run tests/components/ConnectionsSection.test.tsx`

Expected: FAIL because `ConnectionsSection` does not exist.

- [ ] **Step 3: Implement the shared responsive Connections section**

Use this prop contract:

```ts
export interface ConnectionsSectionProps {
  layout: AppLayout;
  calendarConfigured: boolean;
  calendarPicker: CalendarPickerController;
  drive: Pick<DriveInvoicesState, 'status' | 'snapshot' | 'error' | 'operationKey'>;
  driveFolder: DriveFolderController;
}
```

Render a semantic `section` headed `Connections`; each row has its Phosphor icon, service label, selected human name or `Not configured`, action, local error, and Retry where applicable. Use these exact button names:

```ts
const calendarAction = calendarConfigured ? 'Change…' : 'Pick calendar…';
const driveAction = drive.snapshot === null ? 'Pick Drive folder…' : 'Change…';
```

The Drive row error preference is `driveFolder.error ?? drive.error?.message ?? null`. The row is busy when authorization is opening, a Drive mutation is active, or initial Drive discovery is loading. Render the Calendar list below its row when `calendarPicker.listOpen` is true.

- [ ] **Step 4: Put Connections before Teacher in both Rates layouts**

Desktop RatesTab renders `ConnectionsSection` immediately after its save bar and before the Teacher/Bank card. Remove the old Calendar subsection from the Teacher card.

Change `MobileSettingsProps` to accept `connections: ReactNode`, render it immediately after the sticky save bar, and remove the old Calendar section. RatesTab passes:

```tsx
connections={
  <ConnectionsSection
    layout="mobile"
    calendarConfigured={Boolean(config.calendarId?.trim())}
    calendarPicker={calendarPicker}
    drive={drive}
    driveFolder={driveFolder}
  />
}
```

Update the mobile test to compare DOM positions and retain the existing touch checks:

```ts
expect(html.indexOf('Connections')).toBeLessThan(html.indexOf('Teacher'));
```

- [ ] **Step 5: Remove Drive setup from Invoices and enforce the exact empty surface**

Delete root-name display, selection buttons, authorization errors, folder-dialog props, and mobile setup cards. Keep operational Drive refresh and configured-root errors for the normal invoice view.

At the top of `InvoicesTab`, before row building or logging:

```ts
if (
  drive.snapshot === null &&
  (drive.status === 'authorizationRequired' || drive.status === 'unconfigured')
) {
  return null;
}
```

Replace desktop and mobile tests with the exact contract:

```ts
it.each(['desktop', 'mobile'] as const)('renders no invoice content when Drive is unconfigured on %s', (layout) => {
  const { container } = render(
    <InvoicesTab {...props({ layout, drive: driveState('unconfigured') })} />
  );
  expect(container.innerHTML).toBe('');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('table')).toBeNull();
  expect(document.body.textContent).not.toContain('Choose Drive');
});
```

- [ ] **Step 6: Run Connections, Rates, Invoices, mobile, and TypeScript tests**

Run: `bunx vitest run tests/components/ConnectionsSection.test.tsx tests/components/RatesTab-calendar-picker.test.tsx tests/components/MobileSettings.test.tsx tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: focused tests PASS and frontend TypeScript exits 0.

- [ ] **Step 7: Commit the setup-control move**

```bash
git add src/components/setup/ConnectionsSection.tsx src/components/RatesTab/index.tsx src/components/RatesTab/MobileSettings.tsx src/components/InvoicesTab/index.tsx src/components/InvoicesTab/MobileInvoices.tsx src/App.tsx tests/components/ConnectionsSection.test.tsx tests/components/RatesTab-calendar-picker.test.tsx tests/components/MobileSettings.test.tsx tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx
git commit -m "feat: move Google setup into settings connections"
```

### Task 6: Session-Only Welcome Wizard

**Files:**

- Create: `src/hooks/useSetupOnboarding.ts`
- Create: `tests/hooks/useSetupOnboarding.test.tsx`
- Create: `src/components/setup/SetupWizard.tsx`
- Create: `tests/components/SetupWizard.test.tsx`

**Interfaces:**

- Consumes: `SetupReadiness`, `CalendarPickerController`, `DriveFolderController`, Drive state, and `AppLayout`.
- Produces: `SetupOnboardingController` and `SetupWizard`; App wiring occurs in Task 8.

- [ ] **Step 1: Write failing onboarding hook tests**

Define these readiness fixtures in the hook test:

```ts
const calendarMissing: SetupReadiness = {
  status: 'incomplete',
  calendarConfigured: false,
  driveConfigured: false,
  firstIncompleteStep: 'calendar',
};
const driveMissing: SetupReadiness = {
  status: 'incomplete',
  calendarConfigured: true,
  driveConfigured: false,
  firstIncompleteStep: 'drive',
};
const ready: SetupReadiness = {
  status: 'ready',
  calendarConfigured: true,
  driveConfigured: true,
  firstIncompleteStep: null,
};
```

```ts
it('opens at the first incomplete step and dismisses only for the mounted session', () => {
  const { result, unmount } = renderHook(() => useSetupOnboarding(calendarMissing));
  expect(result.current).toMatchObject({ open: true, step: 'calendar', dismissed: false });
  act(() => result.current.dismiss());
  expect(result.current).toMatchObject({ open: false, dismissed: true });
  unmount();

  const fresh = renderHook(() => useSetupOnboarding(calendarMissing));
  expect(fresh.result.current.open).toBe(true);
});

it('advances from Calendar to Drive when readiness changes', () => {
  const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
    initialProps: { readiness: calendarMissing },
  });
  view.rerender({ readiness: driveMissing });
  expect(view.result.current).toMatchObject({ open: true, step: 'drive' });
});

it('closes synchronously when setup becomes ready', () => {
  const view = renderHook(({ readiness }) => useSetupOnboarding(readiness), {
    initialProps: { readiness: driveMissing },
  });
  view.rerender({ readiness: ready });
  expect(view.result.current.open).toBe(false);
});
```

- [ ] **Step 2: Run the hook suite and verify the missing module failure**

Run: `bunx vitest run tests/hooks/useSetupOnboarding.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement session-only dismissal and derived opening**

```ts
export interface SetupOnboardingController {
  open: boolean;
  step: SetupStep;
  dismissed: boolean;
  dismiss(): void;
}

export function useSetupOnboarding(readiness: SetupReadiness): SetupOnboardingController {
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<SetupStep>(readiness.firstIncompleteStep ?? 'calendar');
  const open =
    !dismissed && (readiness.status === 'incomplete' || readiness.status === 'unavailable');

  useEffect(() => {
    if (open && readiness.firstIncompleteStep !== null) {
      setStep(readiness.firstIncompleteStep);
    }
  }, [open, readiness.firstIncompleteStep]);

  return { open, step, dismissed, dismiss: () => setDismissed(true) };
}
```

No storage API may appear in this hook.

- [ ] **Step 4: Write failing desktop and Android wizard tests**

Cover exact copy and behavior:

```ts
function calendarController(
  overrides: Partial<CalendarPickerController> = {}
): CalendarPickerController {
  return {
    calendars: null,
    listOpen: false,
    loading: false,
    saving: false,
    error: null,
    selectedName: 'Not configured',
    openList: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    closeList: vi.fn(),
    ...overrides,
  };
}

function driveController(overrides: Partial<DriveFolderController> = {}): DriveFolderController {
  return {
    dialogOpen: false,
    opening: false,
    error: null,
    openDialog: vi.fn(async () => undefined),
    closeDialog: vi.fn(),
    scanCandidate: vi.fn(async () => ({
      entries: [],
      warnings: [],
      blockingConflicts: [],
      maxSequenceByYear: {},
    })),
    confirmRoot: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    ...overrides,
  };
}

function props(overrides: Partial<SetupWizardProps> = {}): SetupWizardProps {
  return {
    open: true,
    layout: 'desktop',
    step: 'calendar',
    calendarPicker: calendarController(),
    drive: { status: 'unconfigured', error: null },
    driveFolder: driveController(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}
```

```ts
it('renders the approved Calendar step with icon and text progress', () => {
  render(<SetupWizard {...props({ layout: 'desktop', step: 'calendar' })} />);
  expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
  expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  expect(screen.getByText('Choose your teaching calendar')).toBeTruthy();
  expect(screen.getByText('Lotus uses this calendar to find lessons and prepare invoices.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pick calendar…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Set up later' })).toBeTruthy();
  expect(screen.getByText('Next: choose where finalized invoices are stored.')).toBeTruthy();
  expect(screen.getByTestId('setup-step-calendar').querySelector('svg')).toBeTruthy();
  expect(screen.getByTestId('setup-step-drive').querySelector('svg')).toBeTruthy();
});

it('renders the approved Drive step and routes the primary action', async () => {
  const openDialog = vi.fn();
  render(<SetupWizard {...props({ step: 'drive', driveFolder: driveController({ openDialog }) })} />);
  expect(screen.getByText('Step 2 of 2')).toBeTruthy();
  expect(screen.getByText('Choose your invoice folder')).toBeTruthy();
  expect(screen.getByText('Lotus stores finalized invoices in this Google Drive folder.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Pick Drive folder…' }));
  expect(openDialog).toHaveBeenCalledOnce();
  expect(screen.getByText('You can change this later in Rates & Config.')).toBeTruthy();
});
```

Add focus-containment/restoration, reduced-motion classes, `100dvh`, 48-pixel mobile actions, Escape dismissal, Back dismissal, and these nested-interaction assertions:

```ts
it('closes the Calendar list before dismissing the wizard', () => {
  const closeList = vi.fn();
  const onDismiss = vi.fn();
  render(<SetupWizard {...props({ calendarPicker: calendarController({ listOpen: true, closeList }), onDismiss })} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(closeList).toHaveBeenCalledOnce();
  expect(onDismiss).not.toHaveBeenCalled();
});

it('does not consume Back while DriveFolderDialog owns the top interaction', () => {
  const onDismiss = vi.fn();
  render(<SetupWizard {...props({ layout: 'mobile', driveFolder: driveController({ dialogOpen: true }), onDismiss })} />);
  fireEvent.popState(window);
  expect(onDismiss).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Implement the approved responsive wizard**

Use `CalendarBlank` and `GoogleDriveLogo` in a two-position progress row with visible `Calendar`, `Drive`, and `Step N of 2` text. Give the active step a solid-ring treatment, the completed step a check badge, and the pending step a dashed-ring treatment so state does not rely on color. Render one labelled modal with focus containment and restoration. For mobile, push one history entry while the wizard is the top interaction and consume Back exactly once.

The component contract is:

```ts
export interface SetupWizardProps {
  open: boolean;
  layout: AppLayout;
  step: SetupStep;
  calendarPicker: CalendarPickerController;
  drive: Pick<DriveInvoicesState, 'status' | 'error'>;
  driveFolder: DriveFolderController;
  onDismiss(): void;
}
```

When Calendar list is open, render the same entries and `No calendars found` state used in Connections. Show `calendarPicker.error`, `driveFolder.error`, or `drive.error?.message` adjacent to the active action. Disable primary actions while their controller is loading, saving, authorizing, or mutating.

- [ ] **Step 6: Run onboarding hook, wizard, dialog, and TypeScript tests**

Run: `bunx vitest run tests/hooks/useSetupOnboarding.test.tsx tests/components/SetupWizard.test.tsx tests/components/DriveFolderDialog.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: focused tests PASS and frontend TypeScript exits 0.

- [ ] **Step 7: Commit the Welcome wizard**

```bash
git add src/hooks/useSetupOnboarding.ts src/components/setup/SetupWizard.tsx tests/hooks/useSetupOnboarding.test.tsx tests/components/SetupWizard.test.tsx
git commit -m "feat: add required Google setup wizard"
```

### Task 7: Disabled Desktop and Android Destinations

**Files:**

- Modify: `src/components/mobile/MobileNavigation.tsx:1-45`
- Modify: `src/components/mobile/MobileAppShell.tsx:6-101`
- Modify: `tests/components/MobileAppShell.test.tsx`

**Interfaces:**

- Consumes: `readonly AppTab[]` disabled destinations and `calendarActionsEnabled` from App.
- Produces: native disabled mobile navigation buttons, lock indicators, and a shell that suppresses Calendar status/actions while setup is blocked.

- [ ] **Step 1: Add failing mobile shell tests**

```ts
it('cannot select disabled destinations and exposes native disabled semantics', async () => {
  const onSelect = vi.fn();
  render(
    <MobileNavigation
      activeTab="rates"
      onSelect={onSelect}
      disabledTabs={['calendar', 'invoices', 'income']}
    />
  );
  for (const name of ['Calendar', 'Invoices', 'Income']) {
    const destination = namedButton(name);
    expect(destination.disabled).toBe(true);
    expect(destination.querySelector('[data-lock]')).toBeTruthy();
    await click(destination);
  }
  expect(namedButton('Settings').disabled).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
});

it('suppresses Calendar refresh and Calendar errors while setup is blocked', () => {
  render(
    <MobileAppShell
      activeTab="rates"
      onSelectTab={vi.fn()}
      disabledTabs={['calendar', 'invoices', 'income']}
      calendarActionsEnabled={false}
      calendarLoading={false}
      calendarError="No calendar configured"
      onRefresh={vi.fn()}
    >
      <div>Settings</div>
    </MobileAppShell>
  );
  expect(document.body.textContent).not.toContain('No calendar configured');
  expect(namedButton('Refresh calendar').disabled).toBe(true);
});
```

- [ ] **Step 2: Run the mobile shell suite and verify prop failures**

Run: `bunx vitest run tests/components/MobileAppShell.test.tsx`

Expected: FAIL because disabled navigation and Calendar-action props do not exist.

- [ ] **Step 3: Implement disabled mobile destinations and shell forwarding**

Add `disabledTabs?: readonly AppTab[]` to `MobileNavigation`; compute `disabled`, set the native attribute, suppress `onSelect`, use reduced contrast, and render `LockSimple` with `data-lock` and `aria-hidden="true"`. Add `disabledTabs` and `calendarActionsEnabled` to `MobileAppShell`; forward navigation state, disable header refresh, and render no Calendar error banner while actions are disabled.

Use this button rule:

```tsx
<button
  type="button"
  disabled={disabled}
  onClick={() => {
    if (!disabled) onSelect(id);
  }}
  aria-current={active ? 'page' : undefined}
>
  <Icon size={22} aria-hidden="true" />
  {disabled && <LockSimple data-lock size={12} aria-hidden="true" />}
  {label}
</button>
```

- [ ] **Step 4: Run mobile shell and TypeScript tests**

Run: `bunx vitest run tests/components/MobileAppShell.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: mobile shell tests PASS and frontend TypeScript exits 0.

- [ ] **Step 5: Commit disabled mobile navigation support**

```bash
git add src/components/mobile/MobileNavigation.tsx src/components/mobile/MobileAppShell.tsx tests/components/MobileAppShell.test.tsx
git commit -m "feat: disable app destinations during setup"
```

### Task 8: App-Owned Setup Orchestration and Invoice-Source Gate

**Files:**

- Create: `tests/components/App-setup.test.tsx`
- Modify: `src/App.tsx:1-326`
- Modify: `tests/components/App-mobile-calendar.test.tsx`

**Interfaces:**

- Consumes: all preceding readiness, onboarding, Calendar picker, Drive picker, wizard, Connections, and disabled-shell interfaces.
- Produces: the complete desktop/Android first-run flow, completion navigation semantics, empty-source Drive bootstrap, and delayed invoice-source validation.

- [ ] **Step 1: Write failing App integration tests with mutable hook fixtures**

Use the existing App mock pattern, but keep mutable `configState`, `authorizationState`, and `driveState` fixtures. Add these tests:

```ts
let compactLayout = false;
let configState: AppConfig = {
  teacher: {
    name: 'Teacher',
    address: '',
    taxNumber: '',
    bankDetails: { accountOwner: '', iban: '', bic: '' },
  },
  studios: {},
};
let authorizationState = {
  isLoading: false,
  isAuthorizing: false,
  hasCalendarWrite: false,
  hasDrive: false,
  authorizationIncarnation: 0,
  promptOpen: false,
  error: null,
  allowCalendarEditing: vi.fn(async () => undefined),
  allowDrive: vi.fn(async () => undefined),
  dismissCalendarEditingPrompt: vi.fn(async () => undefined),
  openCalendarEditingPrompt: vi.fn(),
};
const readyDriveState: DriveInvoicesState = {
  status: 'ready' as const,
  snapshot: { stagedRoot: { root: { folderId: 'root-a', driveId: null, folderName: 'Lotus invoices' } } } as DriveStoreSnapshot,
  error: null,
  operationKey: null,
  refresh: vi.fn(async () => undefined),
  activateRoot: vi.fn(async () => undefined),
  finalize: vi.fn(async () => {
    throw new Error('finalize is not used by setup tests');
  }),
  refinalize: vi.fn(async () => {
    throw new Error('refinalize is not used by setup tests');
  }),
  recoverReservation: vi.fn(async () => undefined),
  downloadVerified: vi.fn(async () => new Uint8Array()),
};
let driveState: DriveInvoicesState = {
  ...readyDriveState,
  status: 'authorizationRequired',
  snapshot: null,
};
const mocks = {
  buildCurrentInvoiceSources: vi.fn(async () => []),
  calendarPermissionOpen: false,
};

function renderApp(options: { compact?: boolean } = {}) {
  compactLayout = options.compact ?? compactLayout;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<App />));
  return { container, rerender: () => act(() => root.render(<App />)) };
}

function renderIncompleteApp() {
  configState = { ...configState, calendarId: undefined };
  authorizationState = { ...authorizationState, hasDrive: false };
  driveState = { ...driveState, status: 'authorizationRequired', snapshot: null };
  return renderApp();
}

function renderDriveStepApp() {
  configState = { ...configState, calendarId: 'calendar-a', calendarName: 'Teaching' };
  authorizationState = { ...authorizationState, hasDrive: true };
  driveState = { ...driveState, status: 'unconfigured', snapshot: null };
  return renderApp();
}
```

Mock `useConfig`, `useGoogleAuthorization`, and `useDriveInvoices` to return the current mutable fixture values on every render. Mock `buildCurrentInvoiceSources` with `mocks.buildCurrentInvoiceSources`. Mock `CalendarPermissionPrompt` as a component that assigns its `open` prop to `mocks.calendarPermissionOpen`. Use the existing `namedButton`, `click`, root cleanup, Tauri dependency mocks, and simple Calendar/Invoices/Income/Rates presenter doubles from `tests/components/App-mobile-calendar.test.tsx` so this file mounts the real App orchestration without invoking platform APIs.

```ts
it('shows only loading while authorized Drive discovery is unresolved', () => {
  authorizationState = { ...authorizationState, isLoading: false, hasDrive: true };
  driveState = { ...driveState, status: 'loading', snapshot: null };
  renderApp();
  expect(document.body.textContent).toBe('Loading…');
  expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
});

it('opens Welcome over Rates and gates every other desktop destination', () => {
  configState = { ...configState, calendarId: undefined };
  authorizationState = { ...authorizationState, isLoading: false, hasDrive: false };
  driveState = { ...driveState, status: 'authorizationRequired', snapshot: null };
  renderApp({ compact: false });
  expect(screen.getByRole('dialog', { name: 'Welcome to Lotus' })).toBeTruthy();
  expect(document.body.textContent).toContain('Rates content');
  expect(namedButton('Calendar').disabled).toBe(true);
  expect(namedButton('Invoices').disabled).toBe(true);
  expect(namedButton('Income').disabled).toBe(true);
  expect(namedButton('Rates & Config').disabled).toBe(false);
});

it('dismisses for the session, keeps Rates active, and does not build invoice sources', async () => {
  renderIncompleteApp();
  await click(namedButton('Set up later'));
  expect(screen.queryByRole('dialog', { name: 'Welcome to Lotus' })).toBeNull();
  expect(document.body.textContent).toContain('Rates content');
  expect(mocks.buildCurrentInvoiceSources).not.toHaveBeenCalled();
});

it('unlocks and selects Calendar when completion came from Welcome', () => {
  const view = renderDriveStepApp();
  driveState = readyDriveState;
  authorizationState = { ...authorizationState, hasDrive: true };
  view.rerender();
  expect(document.body.textContent).toContain('Calendar content');
  expect(namedButton('Invoices').disabled).toBe(false);
});

it('unlocks without leaving Rates when completion came after dismissal', async () => {
  const view = renderDriveStepApp();
  await click(namedButton('Set up later'));
  driveState = readyDriveState;
  view.rerender();
  expect(document.body.textContent).toContain('Rates content');
});

it('suppresses optional Calendar editing permission until setup is ready', () => {
  authorizationState = { ...authorizationState, promptOpen: true };
  renderIncompleteApp();
  expect(mocks.calendarPermissionOpen).toBe(false);
});
```

Also cover: Calendar already configured starts on Drive; Drive already configured starts on Calendar; unavailable Drive shows its specific Retry error; active destination is forced back to Rates if readiness becomes incomplete; layout changes preserve dismissal; invoice source errors appear only after ready.

- [ ] **Step 2: Run the App tests and verify orchestration failures**

Run: `bunx vitest run tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx`

Expected: FAIL because App has not derived or applied setup readiness.

- [ ] **Step 3: Derive readiness immediately after the Drive hook and gate source building**

Pass an empty source context until the build is current:

```ts
const driveSources = invoiceSourcesReady ? invoiceSources : [];
const driveSourceContextKey = invoiceSourcesReady ? invoiceSourceInputKey : 'setup-discovery';
const driveInvoices = useDriveInvoices({
  store: driveStore,
  sources: driveSources,
  sourceContextKey: driveSourceContextKey,
  authorizationIncarnation: googleAuthorization.authorizationIncarnation,
  discoveryEnabled: !googleAuthorization.isLoading && googleAuthorization.hasDrive,
  foregroundRefreshEnabled: activeTab === 'invoices' && invoiceSourcesReady,
});
const setupReadiness = deriveSetupReadiness({
  configLoading,
  calendarId: config.calendarId,
  authorizationLoading: googleAuthorization.isLoading,
  hasDrive: googleAuthorization.hasDrive,
  driveStatus: driveInvoices.status,
  driveSnapshot: driveInvoices.snapshot,
});
```

Change the source-build effect:

```ts
useEffect(() => {
  if (setupReadiness.status !== 'ready') {
    setInvoiceSourceBuild({ inputKey: null, sources: [], error: null });
    return;
  }
  let current = true;
  void buildCurrentInvoiceSources(classes, config).then(
    (sources) => {
      if (!current) return;
      setInvoiceSourceBuild({ inputKey: invoiceSourceInputKey, sources, error: null });
    },
    (cause) => {
      if (!current) return;
      const sourceMessage = cause instanceof Error ? cause.message : String(cause);
      logInfo(`Current invoice sources unavailable: ${sourceMessage}`);
      setInvoiceSourceBuild({
        inputKey: invoiceSourceInputKey,
        sources: [],
        error: sourceMessage,
      });
    }
  );
  return () => {
    current = false;
  };
}, [classes, config, invoiceSourceInputKey, setupReadiness.status]);
```

Keep the existing `visibleCurrentInvoiceSourceBuild` input-key guard. The cleanup's `current` check prevents a late build from publishing after readiness leaves `ready`.

- [ ] **Step 4: Apply synchronous visible-tab gating and completion navigation**

```ts
const setupBlocked = setupReadiness.status !== 'ready';
const visibleActiveTab: AppTab = setupBlocked ? 'rates' : activeTab;
const disabledTabs: readonly AppTab[] = setupBlocked ? ['calendar', 'invoices', 'income'] : [];
const onboarding = useSetupOnboarding(setupReadiness);
const previousWizardOpenRef = useRef(false);

useEffect(() => {
  if (setupBlocked && activeTab !== 'rates') {
    setMobileTabState((state) => ({ ...state, activeTab: 'rates' }));
  }
}, [activeTab, setupBlocked]);

useEffect(() => {
  if (setupReadiness.status === 'ready' && previousWizardOpenRef.current) {
    setMobileTabState((state) => selectMobileTab(state, 'calendar'));
  }
  previousWizardOpenRef.current = onboarding.open;
}, [onboarding.open, setupReadiness.status]);
```

Use `visibleActiveTab` for all tab content and shell active styling. Desktop tab buttons get `disabled={disabledTabs.includes(tab.id)}`, reduced contrast, and a `LockSimple` icon. Mobile receives the same `disabledTabs`. Calendar Refresh is disabled and Calendar shell errors are hidden while setup is blocked.

- [ ] **Step 5: Render Welcome, Connections controllers, and the one Drive dialog**

Render `SetupWizard` after the shell but before `DriveFolderDialog` in DOM order. The wizard uses `onDismiss={onboarding.dismiss}`. Rates receives the shared picker controllers; both wizard and Connections call the same controller instances.

Suppress the optional prompt exactly:

```tsx
<CalendarPermissionPrompt
  open={setupReadiness.status === 'ready' && googleAuthorization.promptOpen}
  reason={googleAuthorization.hasCalendarWrite ? 'calendarReadOnly' : 'scopeMissing'}
  isAuthorizing={googleAuthorization.isAuthorizing}
  error={googleAuthorization.error}
  onAllow={googleAuthorization.allowCalendarEditing}
  onDismiss={googleAuthorization.dismissCalendarEditingPrompt}
/>
```

For `checking`, return the existing centered `Loading…` surface before rendering UpdateNotification, tabs, or Welcome. Preserve fatal config handling.

- [ ] **Step 6: Update existing App mobile Calendar fixture to ready**

Give its mocked authorization `hasDrive: true` and its mocked Drive hook a non-null ready snapshot. Keep its original assertions unchanged so repeated Calendar activation remains protected after gating.

- [ ] **Step 7: Run all setup-focused frontend tests and TypeScript**

Run: `bunx vitest run tests/lib/setup/readiness.test.ts tests/hooks/useSetupOnboarding.test.tsx tests/hooks/useCalendarPicker.test.tsx tests/hooks/useDriveFolderController.test.tsx tests/hooks/useDriveInvoices.test.tsx tests/components/SetupWizard.test.tsx tests/components/ConnectionsSection.test.tsx tests/components/DriveFolderDialog.test.tsx tests/components/RatesTab-calendar-picker.test.tsx tests/components/MobileSettings.test.tsx tests/components/InvoicesTab.test.tsx tests/components/MobileInvoices.test.tsx tests/components/MobileAppShell.test.tsx tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx && bunx tsc --project tsconfig.app.json --noEmit`

Expected: all focused tests PASS and frontend TypeScript exits 0.

- [ ] **Step 8: Commit App orchestration**

```bash
git add src/App.tsx tests/components/App-setup.test.tsx tests/components/App-mobile-calendar.test.tsx
git commit -m "feat: require Calendar and Drive setup"
```

### Task 9: End-to-End Flow and Integrated Validation

**Files:**

- Modify: `tests/e2e/smoke.e2e.ts`
- Modify: `tests/e2e/drive-invoices.e2e.ts`

**Interfaces:**

- Consumes: the finished desktop/Android setup flow and the existing fake Calendar/Drive server controls.
- Produces: regression proof for first launch, dismissal, locked navigation, setup completion, restart, configured invoice behavior, and Drive-root replacement from Rates & Config.

- [ ] **Step 1: Replace obsolete smoke assertions with the first-launch contract**

The smoke fixture starts with Calendar and Drive unconfigured. Assert:

```ts
it('opens required setup on Calendar without exposing invoice errors', async () => {
  await expect($('[role="dialog"]')).toBeDisplayed();
  await expect($('h2=Welcome to Lotus')).toBeDisplayed();
  await expect($('button=Pick calendar…')).toBeDisplayed();
  await expect($('button=Invoices')).toBeDisabled();
  expect(
    await browser.execute(() =>
      document.body.innerText.includes('invoice input contains unbillable classes')
    )
  ).toBe(false);
});

it('dismisses only to Rates & Config and keeps other destinations locked', async () => {
  await $('button=Set up later').click();
  await expect($('h2=Rates & Config')).toBeDisplayed();
  await expect($('button=Calendar')).toBeDisabled();
  await expect($('button=Invoices')).toBeDisabled();
  await expect($('button=Income')).toBeDisabled();
  await expect($('button=Rates & Config')).toBeEnabled();
  const headings = await $$('h3');
  expect(await headings[0].getText()).toBe('Connections');
});
```

Retain Rates editing/save/version/log coverage after dismissal. Delete the old smoke checks for an Invoices Drive header and `Choose Drive folder` inside Invoices.

- [ ] **Step 2: Update Drive E2E selectors to Welcome and Connections**

Change `createAndActivateRoot` so its entry action is either the visible Welcome `Pick Drive folder…` button or the Rates & Config Connections action. After successful Welcome activation, wait for Calendar to become active, then click Invoices and wait for the invoice table. For configured-root replacement, navigate to Rates & Config and click the Google Drive row's `Change…` action.

Replace every wait for `Drive folder:` inside Invoices with a wait for one of these authoritative outcomes:

```ts
await browser.waitUntil(
  async () =>
    (await $('button=Invoices').isEnabled()) &&
    (await browser.execute(() => document.body.innerText.includes('Welcome to Lotus'))) === false,
  { timeout: 45_000, timeoutMsg: 'required Google setup did not become ready' }
);
await $('button=Invoices').click();
await expect($('table')).toBeDisplayed();
```

Keep all existing remote authority, adoption, finalization, stale detection, download, Gmail draft, conflict, and cold-reload assertions.

- [ ] **Step 3: Add restart-after-dismissal and configured-start assertions**

Using the existing runtime seeding helper:

- seed incomplete setup, dismiss, refresh the page, and assert Welcome opens again;
- seed Calendar plus a configured remote root, refresh, and assert Welcome is absent and Calendar opens;
- seed Calendar with Drive authorization but no control file, refresh, and assert Welcome starts at `Step 2 of 2`;
- force a cold initial Drive offline response, assert `Google Drive is temporarily unavailable` plus Retry, then restore the fake server and verify Retry resolves discovery.

- [ ] **Step 4: Run focused setup and Drive gates before the cold integrated suite**

Run: `bun run verify:drive-invoices`

Expected: OAuth scan, Drive/unit/component tests, both TypeScript projects, and focused Rust tests PASS.

Run: `bun run verify:calendar-editing`

Expected: Calendar editing tests, both TypeScript projects, and focused Calendar Rust tests PASS.

- [ ] **Step 5: Run the complete unit and type gates**

Run: `bun test`

Expected: all Vitest tests PASS.

Run: `bunx tsc --project tsconfig.app.json --noEmit && bunx tsc --project tsconfig.json --noEmit`

Expected: both TypeScript projects exit 0.

- [ ] **Step 6: Run the isolated Tauri E2E suite once**

Run: `bun run e2e`

Expected: Boot/setup, Calendar, Invoices, Rates, Drive lifecycle, and log-panel scenarios PASS in the isolated app.

- [ ] **Step 7: Smoke the approved Android flow on the Google Play emulator**

Run: `bun run android:debug:emulator`

On `Lotus_API_36`, verify these exact interactions without logging tokens:

1. Fresh incomplete launch shows the Android Welcome layout within `100dvh`.
2. Android Back dismisses Welcome to Settings and leaves the other three destinations disabled.
3. Opening Drive picker and pressing Back closes only the picker, leaving Welcome open.
4. Completing Calendar then Drive unlocks navigation and selects Calendar.
5. Force-stopping and reopening while incomplete shows Welcome again; reopening after completion does not.

- [ ] **Step 8: Inspect scope and commit E2E coverage**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned source/test changes plus the pre-existing unrelated paths are present.

```bash
git add tests/e2e/smoke.e2e.ts tests/e2e/drive-invoices.e2e.ts
git commit -m "test: cover required Google setup flow"
```

- [ ] **Step 9: Record final evidence without touching unrelated files**

Run: `git log --oneline -9 && git status --short`

Expected: the nine scoped feature commits are present; `AGENTS.md` and generated Android directories remain unstaged and unchanged by this work.
