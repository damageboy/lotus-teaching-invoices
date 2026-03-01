# Bun Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace npm with bun as the package manager across the project, CI, and pre-commit hooks.

**Architecture:** Swap the lockfile from `package-lock.json` to `bun.lockb`, update `.husky/pre-commit` to use `bunx`/`bun run`, and update the GitHub Actions workflow to use `oven-sh/setup-bun`. No runtime changes — tsx, vitest, vite, and tauri all continue to be invoked via `bun run <script>`.

**Tech Stack:** bun (package manager), husky (git hooks), GitHub Actions

---

### Task 1: Generate bun lockfile and remove npm lockfile

**Files:**

- Delete: `package-lock.json`
- Create: `bun.lockb` (generated)

**Step 1: Install bun if not already installed**

```bash
which bun || curl -fsSL https://bun.sh/install | bash
```

Expected: prints a path like `/Users/you/.bun/bin/bun` or runs the installer.

**Step 2: Run bun install**

```bash
bun install
```

Expected: resolves packages and writes `bun.lockb` in the project root. Output ends with something like `N packages installed`.

**Step 3: Verify node_modules looks correct**

```bash
ls node_modules/.bin/vite node_modules/.bin/vitest node_modules/.bin/tsc
```

Expected: all three paths exist (no errors).

**Step 4: Delete package-lock.json**

```bash
rm package-lock.json
```

**Step 5: Run the test suite to confirm nothing broke**

```bash
bun run test
```

Expected: `6 passed (6)`, `40 passed (40)` (same as before).

**Step 6: Commit**

```bash
git add bun.lockb
git rm package-lock.json
git commit -m "chore: switch to bun — replace package-lock.json with bun.lockb"
```

---

### Task 2: Update pre-commit hook

**Files:**

- Modify: `.husky/pre-commit`

**Step 1: Open the file and read current contents**

Current `.husky/pre-commit`:

```
npx lint-staged
npx tsc --project tsconfig.app.json --noEmit
npx tsc --project tsconfig.json --noEmit
npm test
```

**Step 2: Replace the file contents**

Write `.husky/pre-commit` with exactly:

```
bunx lint-staged
bunx tsc --project tsconfig.app.json --noEmit
bunx tsc --project tsconfig.json --noEmit
bun run test
```

**Step 3: Verify the hook fires correctly with a test commit**

Stage any trivial change (e.g., add a blank line to a `.md` file), then attempt a commit. The hook should run and pass.

```bash
echo "" >> README.md
git add README.md
git commit -m "test: verify pre-commit hook with bun"
```

Expected: lint-staged runs (formats the file), both tsc checks pass, tests pass, commit succeeds.

If the blank line commit is unwanted, amend or reset it:

```bash
git reset HEAD~1  # undo the test commit, keep changes staged
git restore README.md  # discard the blank line
```

**Step 4: Commit the hook change**

```bash
git add .husky/pre-commit
git commit -m "chore: update pre-commit hook to use bunx/bun run"
```

---

### Task 3: Update GitHub Actions workflow

**Files:**

- Modify: `.github/workflows/build-macos.yml`

**Step 1: Read the current workflow**

Current relevant steps:

```yaml
- name: Set up Node.js
  uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: npm

- name: Install Node dependencies
  run: npm ci

- name: Build Tauri app (universal binary)
  run: npm run build -- --target universal-apple-darwin
```

**Step 2: Replace the three steps**

Replace the `Set up Node.js` step with:

```yaml
- name: Set up bun
  uses: oven-sh/setup-bun@v2
```

Replace the `Install Node dependencies` step with:

```yaml
- name: Install dependencies
  run: bun install --frozen-lockfile
```

Replace `npm run build` with `bun run build`:

```yaml
- name: Build Tauri app (universal binary)
  run: bun run build -- --target universal-apple-darwin
```

**Step 3: Verify the workflow file is valid YAML**

```bash
bunx js-yaml .github/workflows/build-macos.yml > /dev/null && echo "valid"
```

Expected: prints `valid` (or no error if js-yaml isn't available — skip if so).

**Step 4: Commit**

```bash
git add .github/workflows/build-macos.yml
git commit -m "ci: switch GitHub Actions workflow from npm to bun"
```

---

### Task 4: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

**Step 1: Update the Commands section**

In the `## Commands` block, replace each `npm run` with `bun run` and `npm test` with `bun test`. The updated block should read:

```bash
# Run the Tauri desktop app (dev mode)
bun run dev

# Run just the Vite frontend (no Tauri window, for fast UI iteration)
bun run dev:vite

# Run the CLI (original Node.js tool)
bun run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run

# Build the desktop app
bun run build

# Run all tests
bun test

# Run a single test file
bunx vitest run tests/invoice/calculator.test.ts
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md commands to use bun"
```

---

### Task 5: Final verification

**Step 1: Confirm no npm references remain in tracked files**

```bash
git grep -n "npm " -- ':!docs/' ':!node_modules/'
```

Expected: no output (or only references inside comments/strings that are intentional — review any hits carefully).

**Step 2: Run the full test suite one more time**

```bash
bun run test
```

Expected: 40 tests pass.

**Step 3: Update memory**

In `/Users/dmg/.claude/projects/-Users-dmg-projects-lotus-teaching-invoices/memory/MEMORY.md`, find the CLI section and any `npm` references and update them to `bun run`.
