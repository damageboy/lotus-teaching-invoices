# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic update checking and user-initiated update installation via GitHub Releases.

**Architecture:** Tauri's `tauri-plugin-updater` checks a GitHub Releases endpoint on app launch. If a newer version exists, a toast notification appears. The user clicks "Update Now" to download, install, and relaunch. A GitHub Actions workflow builds, signs, and publishes releases on version tags.

**Tech Stack:** Tauri v2, tauri-plugin-updater, @tauri-apps/plugin-updater, @tauri-apps/plugin-process (for relaunch), GitHub Actions with tauri-apps/tauri-action

---

### Task 1: Generate Tauri signing keypair

**Files:**

- None committed (local-only + GitHub secrets)

- [ ] **Step 1: Generate the Ed25519 keypair**

Run:

```bash
bunx tauri signer generate -w ~/.tauri/lotus-updates.key
```

This will prompt for a password. Choose one and remember it. It outputs the **public key** to stdout — copy it. The private key is saved to `~/.tauri/lotus-updates.key`.

- [ ] **Step 2: Store secrets in GitHub**

Go to `https://github.com/damageboy/lotus-teaching-invoices/settings/secrets/actions` and add:

- `TAURI_SIGNING_PRIVATE_KEY` — paste the entire contents of `~/.tauri/lotus-updates.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you chose

- [ ] **Step 3: Note the public key**

Save the public key string somewhere accessible. It will be embedded in `tauri.conf.json` in Task 2.

---

### Task 2: Add updater plugin dependencies and configuration

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Rust dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-updater = "2"
```

- [ ] **Step 2: Add JS dependencies**

Run:

```bash
bun add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

`plugin-process` is needed for `relaunch()` after installing an update.

- [ ] **Step 3: Configure updater in tauri.conf.json**

Add the `plugins` key to `src-tauri/tauri.conf.json` (top-level, alongside `bundle`):

```json
"plugins": {
  "updater": {
    "pubkey": "<PASTE_YOUR_PUBLIC_KEY_HERE>",
    "endpoints": [
      "https://github.com/damageboy/lotus-teaching-invoices/releases/latest/download/latest.json"
    ]
  }
}
```

Replace `<PASTE_YOUR_PUBLIC_KEY_HERE>` with the public key from Task 1.

- [ ] **Step 4: Add updater + process permissions to capabilities**

In `src-tauri/capabilities/default.json`, add to the `permissions` array:

```json
"updater:default",
"process:default"
```

- [ ] **Step 5: Register plugins in Rust**

In `src-tauri/src/lib.rs`, add the two plugins to the builder chain (after the existing `.plugin(tauri_plugin_shell::init())` line):

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

Also add the process crate to Cargo.toml:

```toml
tauri-plugin-process = "2"
```

- [ ] **Step 6: Verify it compiles**

Run:

```bash
cd src-tauri && cargo check
```

Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json \
        src-tauri/capabilities/default.json src-tauri/src/lib.rs \
        package.json bun.lockb
git commit -m "feat: add tauri-plugin-updater and tauri-plugin-process"
```

---

### Task 3: Create the UpdateNotification component

**Files:**

- Create: `src/components/UpdateNotification.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create the UpdateNotification component**

Create `src/components/UpdateNotification.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { logInfo, logError, logWarn } from '../lib/logger';

type Status = 'idle' | 'available' | 'downloading' | 'done' | 'error';

export function UpdateNotification() {
  const [status, setStatus] = useState<Status>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [version, setVersion] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdate() {
      try {
        logInfo('Checking for updates…');
        const result = await check();
        if (cancelled) return;

        if (result) {
          logInfo(`Update available: v${result.version}`);
          setUpdate(result);
          setVersion(result.version);
          setStatus('available');
        } else {
          logInfo('App is up to date');
        }
      } catch (e) {
        if (cancelled) return;
        logWarn(`Update check failed: ${e}`);
        // Silent fail — don't bother the user
      }
    }

    checkForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstall() {
    if (!update) return;
    try {
      setStatus('downloading');
      logInfo(`Downloading update v${version}…`);
      await update.downloadAndInstall();
      setStatus('done');
      logInfo('Update installed. Relaunching…');
      await relaunch();
    } catch (e) {
      logError(`Update failed: ${e}`);
      setStatus('error');
    }
  }

  if (status === 'idle' || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-indigo-50 border-b border-indigo-100 text-sm">
      {status === 'available' && (
        <>
          <span className="text-indigo-700">Version {version} is available</span>
          <button
            onClick={handleInstall}
            className="px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 transition-colors"
          >
            Update Now
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-600 ml-auto"
            title="Dismiss"
          >
            ✕
          </button>
        </>
      )}
      {status === 'downloading' && <span className="text-indigo-600">Downloading update…</span>}
      {status === 'error' && (
        <>
          <span className="text-red-600">Update failed. Please try again later.</span>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-600 ml-auto"
            title="Dismiss"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add UpdateNotification to App.tsx**

In `src/App.tsx`, add the import at the top alongside the other component imports:

```tsx
import { UpdateNotification } from './components/UpdateNotification';
```

Then add `<UpdateNotification />` right after the opening `<div className="flex flex-col h-screen bg-white">` and before the tab bar `<div>`:

```tsx
return (
    <div className="flex flex-col h-screen bg-white">
      <UpdateNotification />
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 bg-gray-50">
```

- [ ] **Step 3: Verify it compiles**

Run:

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: no type errors. (The updater won't actually find updates in dev, but the component should compile.)

- [ ] **Step 4: Commit**

```bash
git add src/components/UpdateNotification.tsx src/App.tsx
git commit -m "feat: add update notification component"
```

---

### Task 4: Update GitHub Actions workflow for releases

**Files:**

- Modify: `.github/workflows/build-macos.yml`

- [ ] **Step 1: Replace the workflow**

Replace `.github/workflows/build-macos.yml` with the following. Key changes:

- Uses `tauri-apps/tauri-action` which generates the updater manifest (`latest.json`) and attaches signed artifacts to the release
- Passes signing secrets
- Builds universal macOS binary
- On tag push: creates a GitHub Release with all artifacts including the updater manifest

```yaml
name: Build macOS

on:
  push:
    branches: [master]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build-and-release:
    runs-on: macos-latest
    permissions:
      contents: write

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
        run: bun install --frozen-lockfile --ignore-scripts

      - name: Build and release with tauri-action
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v__VERSION__
          releaseName: 'v__VERSION__'
          releaseBody: 'See the assets to download this version and install.'
          releaseDraft: false
          prerelease: false
          args: --target universal-apple-darwin
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-macos.yml
git commit -m "ci: use tauri-action for signed releases with updater manifest"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Run existing tests**

```bash
bun test
```

Expected: all existing tests pass (updater doesn't affect unit tests).

- [ ] **Step 2: Run TypeScript check**

```bash
bunx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run E2E tests**

```bash
bun run e2e
```

Expected: all 15 existing tests pass. The updater check will silently fail in E2E (no release exists yet) — this is the correct behavior since we designed it to fail silently.

- [ ] **Step 4: Manual smoke test**

```bash
bun run dev
```

Open the app. The UpdateNotification component should render nothing (no update available). Check the log panel — should see "Checking for updates…" then either "App is up to date" or "Update check failed" (both are fine before the first release).

- [ ] **Step 5: Test a real release (after merging)**

1. Ensure the signing keypair and GitHub secrets are set up (Task 1).
2. Bump the version in `src-tauri/tauri.conf.json` to `0.2.0`.
3. Commit: `git commit -am "chore: bump version to 0.2.0"`
4. Tag and push: `git tag v0.2.0 && git push && git push --tags`
5. Watch the GitHub Actions run complete.
6. Verify the release at `https://github.com/damageboy/lotus-teaching-invoices/releases` has:
   - `.dmg` file
   - `.app.tar.gz` file
   - `.app.tar.gz.sig` file
   - `latest.json` file
7. Install the old version (current), then open it — it should detect v0.2.0 and show the update notification.
