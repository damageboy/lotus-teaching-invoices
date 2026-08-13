# Studio Name Trimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize configured studio names before they can break calendar matching, while reporting empty and duplicate names clearly.

**Architecture:** `validateConfig` normalizes studio record keys at every load/save boundary. A pure `renameStudio` helper owns blur-time normalization and validation; `RatesTab` applies successful changes and `StudioCard` renders the helper's errors. WebdriverIO verifies the real Tauri blur-and-save flow.

**Tech Stack:** TypeScript, React 19, Zod, Vitest, YAML, Tauri 2, WebdriverIO

---

## File map

- Modify `src/lib/config/schema.ts`: normalize and validate studio keys while constructing `AppConfig`.
- Create `src/lib/config/studioNames.ts`: pure studio rename result type and normalization helper.
- Modify `src/components/RatesTab/index.tsx`: consume the helper on blur and show inline validation errors.
- Modify `package.json` and `bun.lock`: add jsdom React component-test dependencies.
- Modify `tests/config/loader.test.ts`: config-boundary regression tests.
- Modify `tests/config/serialization.test.ts`: normalized-key persistence regression test.
- Modify `tests/components/RatesTab.test.ts`: helper and real React component tests for successful, invalid, duplicate, and no-op renames.
- Modify `tests/e2e/smoke.e2e.ts`: real UI blur, error, recovery, and YAML persistence coverage.

### Task 1: Normalize studio keys at config boundaries

**Files:**

- Modify: `tests/config/loader.test.ts`
- Modify: `tests/config/serialization.test.ts`
- Modify: `src/lib/config/schema.ts:162-182`

- [ ] **Step 1: Write failing config normalization tests**

Add tests proving that `validateConfig` changes `{ '  Test Studio  ': studio }` to the key `Test Studio`, rejects the key `'   '` with `Studio name cannot be empty.`, and rejects `{ Studio: a, ' Studio ': b }` with `A studio named "Studio" already exists.`.

- [ ] **Step 2: Write the failing persistence test**

In `tests/config/serialization.test.ts`, validate a config with a padded key, stringify the validated result, parse it again, and assert the YAML and reparsed record contain only `Test Studio`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `bunx vitest run tests/config/loader.test.ts tests/config/serialization.test.ts`

Expected: the normalization assertion fails and invalid normalized keys do not throw.

- [ ] **Step 4: Implement minimal config-key normalization**

In the existing `Object.entries(configData.studios)` loop:

```ts
const normalizedName = name.trim();
if (!normalizedName) {
  throw new AppError('Studio name cannot be empty.', 'INVALID_CONFIG');
}
if (Object.hasOwn(config.studios, normalizedName)) {
  throw new AppError(`A studio named "${normalizedName}" already exists.`, 'INVALID_CONFIG');
}
// Assign the sorted studio to config.studios[normalizedName].
```

Do not trim studio field values or internal whitespace.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `bunx vitest run tests/config/loader.test.ts tests/config/serialization.test.ts`

Expected: both files pass.

- [ ] **Step 6: Commit the boundary behavior**

```bash
git add src/lib/config/schema.ts tests/config/loader.test.ts tests/config/serialization.test.ts
git commit -m "fix: normalize studio names in config"
```

### Task 2: Normalize and validate UI renames before synchronization

**Files:**

- Create: `src/lib/config/studioNames.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tests/components/RatesTab.test.ts`
- Modify: `tests/e2e/smoke.e2e.ts`
- Modify: `src/components/RatesTab/index.tsx:31-129,294-299`

- [ ] **Step 1: Add the component-test harness**

Run: `bun add --dev @testing-library/react jsdom`

Mark `tests/components/RatesTab.test.ts` with `// @vitest-environment jsdom` and import `render`, `fireEvent`, `screen`, and `cleanup` from Testing Library. Call `cleanup` after each test.

- [ ] **Step 2: Write failing rename-helper tests**

Add tests for the following contract:

```ts
type StudioRenameResult =
  | { ok: true; name: string; studios: Record<string, StudioConfig>; changed: boolean }
  | { ok: false; error: string };

renameStudio(studios, 'Studio', '  New Studio  ');
// => ok, name: 'New Studio', changed: true, key renamed

renameStudio(studios, 'Studio', '  Studio  ');
// => ok, name: 'Studio', changed: false, same record

renameStudio(studios, 'Studio', '   ');
// => { ok: false, error: 'Studio name cannot be empty.' }

renameStudio({ Studio: a, Other: b }, 'Studio', ' Other ');
// => { ok: false, error: 'A studio named "Other" already exists.' }
```

Also assert that `New  Studio` preserves its two internal spaces and failed results do not expose a changed studio record.

- [ ] **Step 3: Write failing React component tests**

Render `RatesTab` with mock `onUpdate` and `onSave`, open the studio card, and drive the accessible studio-name input with `fireEvent.change` and `fireEvent.blur`. Prove:

- A whitespace-only blur renders `Studio name cannot be empty.` and never calls `onUpdate`.
- A duplicate normalized name renders `A studio named "Other" already exists.` and never calls `onUpdate`.
- `  Studio  ` is normalized back to `Studio`, calls no update, and is treated as a valid no-op.
- After first rendering an empty-name error, a blur with `  New Studio  ` clears the error, changes the displayed input to `New Studio`, and calls `onUpdate` once with only the normalized key.

- [ ] **Step 4: Write the failing Tauri E2E regression**

After the existing add-studio test, open the new studio card and locate its accessible studio-name input. Verify this sequence:

1. Enter only whitespace and blur; `Studio name cannot be empty.` appears and the original generated studio key remains in memory.
2. Enter `Test Studio` and blur; the duplicate error appears and the original generated studio key remains.
3. Enter `  Trimmed Studio  ` and blur; the input value becomes `Trimmed Studio`, the previous error disappears, and unsaved changes remain visible.
4. Click Save; `readTmpConfig()` contains `Trimmed Studio` and contains neither the padded key nor the original generated key.

- [ ] **Step 5: Run component and E2E tests and verify RED**

Run: `bunx vitest run tests/components/RatesTab.test.ts`

Expected: helper import/function failure and component behavior assertions fail because `renameStudio` and inline name errors do not exist.

Run: `bun run e2e`

Expected: the new E2E test fails because the input has no accessible studio-name label and a padded name is not normalized on blur.

- [ ] **Step 6: Implement the minimal pure helper**

Create `src/lib/config/studioNames.ts`. Trim the proposed name, check empty, treat the normalized old name as a successful no-op before duplicate detection, detect an existing exact key with `Object.hasOwn`, and rebuild the record without mutating it.

- [ ] **Step 7: Wire the result contract into the UI**

Change `StudioCardProps.onRename` to return `StudioRenameResult`. Add `nameError` state. On every blur, call the callback even if the raw draft equals the current name so normalization/no-op semantics stay centralized:

```tsx
const result = onRename(studioName, draftName);
if (result.ok) {
  setDraftName(result.name);
  setNameError(null);
} else {
  setNameError(result.error);
}
```

Add `aria-label={`Studio name: ${studioName}`}`, red error styling, and an inline `<span>` for `nameError`. In the parent, call `renameStudio`; invoke `onUpdate` only for a successful result with `changed: true`; always return the result to the card.

- [ ] **Step 8: Run component tests and verify GREEN**

Run: `bunx vitest run tests/components/RatesTab.test.ts`

Expected: helper and real component interaction tests pass.

- [ ] **Step 9: Run required post-UI E2E and TypeScript checks**

Run: `bunx tsc --project tsconfig.app.json --noEmit && bun run e2e`

Expected: typecheck and all WebdriverIO tests pass, including the new rename regression.

- [ ] **Step 10: Commit the UI behavior and its RED/GREEN coverage**

```bash
git add package.json bun.lock src/lib/config/studioNames.ts src/components/RatesTab/index.tsx tests/components/RatesTab.test.ts tests/e2e/smoke.e2e.ts
git commit -m "fix: validate studio names on rename"
```

### Task 3: Run the full regression suite

**Files:**

- Modify: `docs/superpowers/plans/2026-08-13-studio-name-trimming.md`

- [ ] **Step 1: Run the complete required verification**

Run:

```bash
bun test
bunx tsc --project tsconfig.app.json --noEmit
bunx tsc --project tsconfig.json --noEmit
bun run e2e
git diff --check HEAD~3
```

Expected: zero test failures, zero type errors, E2E pass, and no whitespace errors.

- [ ] **Step 2: Commit the reviewed implementation plan**

```bash
git add docs/superpowers/plans/2026-08-13-studio-name-trimming.md
git commit -m "docs: plan studio name trimming"
```
