# Versioning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bake a meaningful version string into every build — official CI tag builds show clean semver, local dev builds show git-describe metadata with optional `-dirty` suffix — and display it in the RatesTab footer and native macOS About dialog.

**Architecture:** A Vite plugin added to `vite.config.ts` runs at build time, reads `GITHUB_REF` (CI) or `git describe` (local) and injects two compile-time constants (`__APP_VERSION__`, `__APP_IS_OFFICIAL__`) via Vite `define`. The CI workflow gains a `v*` tag trigger and a step that rewrites `tauri.conf.json`'s version field before building, so the native About dialog shows the correct release version.

**Tech Stack:** Vite `define`, Node.js `child_process.execSync`, TypeScript global declarations, WebdriverIO for e2e, GitHub Actions YAML.

---

### Task 1: Declare compile-time globals for TypeScript

**Files:**

- Create: `src/vite-env.d.ts`

**Step 1: Create the declarations file**

```typescript
/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_IS_OFFICIAL__: boolean;
```

**Step 2: Verify TypeScript accepts the file**

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: exits 0, no errors.

**Step 3: Commit**

```bash
git add src/vite-env.d.ts
git commit -m "feat: declare __APP_VERSION__ and __APP_IS_OFFICIAL__ compile-time globals"
```

---

### Task 2: Create the typed version module

**Files:**

- Create: `src/lib/version.ts`

**Step 1: Create the module**

```typescript
export const APP_VERSION: string = __APP_VERSION__;
export const APP_IS_OFFICIAL: boolean = __APP_IS_OFFICIAL__;
```

This will pass TypeScript because `vite-env.d.ts` declares both globals. At runtime these are replaced by Vite `define` with literal values baked into the bundle.

**Step 2: Verify TypeScript still passes**

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: exits 0, no errors.

**Step 3: Commit**

```bash
git add src/lib/version.ts
git commit -m "feat: add version module re-exporting compile-time constants"
```

---

### Task 3: Add the Vite version plugin

**Files:**

- Modify: `vite.config.ts`

**Step 1: Read the current file before editing**

Current `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '',
  plugins: [react(), tailwindcss()],
  // ...
});
```

**Step 2: Add the plugin — replace the entire file**

```typescript
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'child_process';

function appVersionPlugin(): Plugin {
  function getVersionInfo(): { version: string; isOfficial: boolean } {
    // CI official build: GITHUB_REF is refs/tags/v1.2.3
    const tagMatch = process.env.GITHUB_REF?.match(/^refs\/tags\/v?(.+)/);
    if (tagMatch) {
      return { version: tagMatch[1], isOfficial: true };
    }
    // Local / branch build: use git describe
    try {
      const raw = execSync('git describe --tags --dirty=-dirty --always --abbrev=7', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { version: raw.replace(/^v/, ''), isOfficial: false };
    } catch {
      return { version: 'unknown', isOfficial: false };
    }
  }

  const { version, isOfficial } = getVersionInfo();

  return {
    name: 'app-version',
    config() {
      return {
        define: {
          __APP_VERSION__: JSON.stringify(version),
          __APP_IS_OFFICIAL__: JSON.stringify(isOfficial),
        },
      };
    },
  };
}

export default defineConfig({
  base: '',
  plugins: [react(), tailwindcss(), appVersionPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
```

**Step 3: Verify the plugin runs and injects the version**

```bash
bun run build:vite 2>&1 | head -20
```

Expected: builds without errors. To confirm the version was injected, grep the output bundle:

```bash
grep -r '"version":' dist/ | head -3
# Or look for the actual version string from git describe
git describe --tags --dirty=-dirty --always --abbrev=7
# Then grep for that string in dist/assets/*.js
```

You should find the version string literal in the compiled JS.

**Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat: add appVersionPlugin to inject git version at build time"
```

---

### Task 4: Add the version badge to RatesTab

**Files:**

- Modify: `src/components/RatesTab/index.tsx`

**Step 1: Import the version constants at the top of the file**

Add to the existing imports (after line 1):

```typescript
import { APP_VERSION, APP_IS_OFFICIAL } from '../../lib/version';
```

**Step 2: Add the badge at the bottom of the returned JSX**

In `RatesTab`, after the `+ Add studio` button (currently the last element before the closing `</div>`), add:

```tsx
{
  /* Version badge */
}
<div className="flex justify-end pt-2">
  <span data-testid="version-badge" className="text-xs text-gray-400 font-mono">
    v{APP_VERSION}
    {!APP_IS_OFFICIAL && (
      <span className="ml-1.5 px-1 py-0.5 rounded bg-gray-100 text-gray-400">dev</span>
    )}
    {APP_VERSION.endsWith('-dirty') && (
      <span className="ml-1 px-1 py-0.5 rounded bg-amber-50 text-amber-500">dirty</span>
    )}
  </span>
</div>;
```

The full return block of `RatesTab` should end like this:

```tsx
      <button
        onClick={addStudio}
        className="self-start px-4 py-1.5 rounded border border-dashed border-gray-300 text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
      >
        + Add studio
      </button>

      {/* Version badge */}
      <div className="flex justify-end pt-2">
        <span data-testid="version-badge" className="text-xs text-gray-400 font-mono">
          v{APP_VERSION}
          {!APP_IS_OFFICIAL && (
            <span className="ml-1.5 px-1 py-0.5 rounded bg-gray-100 text-gray-400">dev</span>
          )}
          {APP_VERSION.endsWith('-dirty') && (
            <span className="ml-1 px-1 py-0.5 rounded bg-amber-50 text-amber-500">dirty</span>
          )}
        </span>
      </div>
    </div>
  );
}
```

**Step 3: Verify TypeScript**

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: exits 0.

**Step 4: Commit**

```bash
git add src/components/RatesTab/index.tsx src/lib/version.ts
git commit -m "feat: show version badge in RatesTab footer"
```

---

### Task 5: Add an e2e test for the version badge

**Files:**

- Modify: `tests/e2e/smoke.e2e.ts`

The "Rates & Config tab" describe block already navigates to that tab in its `before()`. Add one test at the end of that block:

**Step 1: Add the test inside the existing `describe('Rates & Config tab', ...)` block**

After the `'adds a new studio and saves it to the YAML file'` test, add:

```typescript
it('shows the version badge', async () => {
  const badge = await $('[data-testid="version-badge"]');
  await expect(badge).toBeDisplayed();
  const text = await badge.getText();
  // Should start with 'v' followed by a digit or 'unknown'
  expect(text).toMatch(/^v(\d|unknown)/);
});
```

**Step 2: Run the full e2e suite**

```bash
bun run e2e
```

Expected: 15 tests pass (was 14, now +1 for the version badge test). The badge will show something like `vgabcdef dev` (no tags yet) or `v0.1.0-N-gabcdef dev` if tags exist.

If the test fails with "element not found", verify that `data-testid="version-badge"` is on the right element in RatesTab.

**Step 3: Commit**

```bash
git add tests/e2e/smoke.e2e.ts
git commit -m "test(e2e): verify version badge is visible in RatesTab"
```

---

### Task 6: Update the CI workflow for tag-based releases

**Files:**

- Modify: `.github/workflows/build-macos.yml`

**Step 1: Read the current workflow before editing**

The current `on:` section is:

```yaml
on:
  push:
    branches: [master]
  workflow_dispatch:
```

**Step 2: Add the tag trigger**

Replace the `on:` section with:

```yaml
on:
  push:
    branches: [master]
    tags: ['v*']
  workflow_dispatch:
```

**Step 3: Add the version-injection step**

Insert a new step between `Install dependencies` and `Build Tauri app`. The step runs only on tag pushes and rewrites `tauri.conf.json` in-place so the native About dialog shows the release version.

After the `Install dependencies` step, add:

```yaml
- name: Inject tag version into tauri.conf.json
  if: startsWith(github.ref, 'refs/tags/')
  run: |
    node -e "
      const fs = require('fs');
      const p = 'src-tauri/tauri.conf.json';
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      cfg.version = process.env.TAG.replace(/^v/, '');
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    "
  env:
    TAG: ${{ github.ref_name }}
```

The complete updated workflow:

```yaml
name: Build macOS

on:
  push:
    branches: [master]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up bun
        uses: oven-sh/setup-bun@v2

      - name: Set up Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin

      - name: Cache Rust dependencies
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Inject tag version into tauri.conf.json
        if: startsWith(github.ref, 'refs/tags/')
        run: |
          node -e "
            const fs = require('fs');
            const p = 'src-tauri/tauri.conf.json';
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            cfg.version = process.env.TAG.replace(/^v/, '');
            fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
          "
        env:
          TAG: ${{ github.ref_name }}

      - name: Build Tauri app (universal binary)
        run: bun run build -- --target universal-apple-darwin
        env:
          TAURI_SIGNING_PRIVATE_KEY: ''
          CI: true

      - name: Upload .app bundle
        uses: actions/upload-artifact@v4
        with:
          name: Lotus-Teaching-Invoices-app
          path: src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app
          if-no-files-found: error

      - name: Upload .dmg installer
        uses: actions/upload-artifact@v4
        with:
          name: Lotus-Teaching-Invoices-dmg
          path: src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
          if-no-files-found: error
```

**Step 4: Verify the workflow YAML is valid**

```bash
# Confirm no YAML syntax errors (requires yq or just check with node)
node -e "require('fs').readFileSync('.github/workflows/build-macos.yml', 'utf8'); console.log('OK')"
```

Expected: prints `OK`.

**Step 5: Commit**

```bash
git add .github/workflows/build-macos.yml
git commit -m "ci: trigger on v* tags; inject tag version into tauri.conf.json before build"
```

---

## How to cut a release

Once the implementation is merged to `master`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will pick up the `v1.0.0` tag, inject `1.0.0` into `tauri.conf.json`, and build the universal binary. The config-tab badge will show `v1.0.0` (no `dev` pill). The native About dialog will also show `1.0.0`.
