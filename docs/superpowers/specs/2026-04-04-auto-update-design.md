# Auto-Update Mechanism Design

**Date:** 2026-04-04
**Status:** Approved

## Overview

Add automatic update checking and user-initiated update installation to the Lotus Teaching Invoices Tauri app, using GitHub Releases on the public repository as the distribution channel.

## Goals

- App checks for updates on launch
- User sees a notification when an update is available
- User clicks to download and install the update
- Updates are built and published automatically via GitHub Actions on tagged releases

## Non-Goals

- Windows/Linux support (macOS only for now)
- Silent background installation (notify + one-click only)
- Rollback mechanism
- Delta/partial updates

## Target Audience

Small group of macOS users. The repository is public, so no authentication is needed.

## Architecture

### Update Flow

```
Developer tags a release and pushes
        ↓
GitHub Actions builds macOS app via tauri-action
        ↓
GH Action creates GitHub Release with:
  - .app.tar.gz (signed update artifact)
  - .app.tar.gz.sig (signature)
  - latest.json (update manifest)
        ↓
On app launch, tauri-plugin-updater checks
  https://github.com/damageboy/lotus-teaching-invoices/releases/latest/download/latest.json
        ↓
If newer version found → show notification in app UI
        ↓
User clicks "Update Now" → plugin downloads, verifies signature, installs, restarts
```

### Components

#### 1. tauri-plugin-updater (Rust + JS)

Tauri's official updater plugin for v2. Handles checking for updates, downloading, signature verification, and installation.

**Rust side:** Register plugin in `src-tauri/src/lib.rs`.
**JS side:** Import from `@tauri-apps/plugin-updater` to check for updates and trigger install.

#### 2. Signing

Tauri's updater requires artifacts to be signed with a keypair. This is **not** Apple codesigning — it's Tauri's own Ed25519 signing mechanism.

- Generate a keypair via `bunx tauri signer generate -w ~/.tauri/lotus-updates.key`
- The **private key** is stored as a GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY`)
- The **password** for the key is stored as a GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
- The **public key** is embedded in `tauri.conf.json` updater config

#### 3. tauri.conf.json — Updater Configuration

Add updater config with:

- `pubkey`: The Ed25519 public key for signature verification
- `endpoints`: `["https://github.com/damageboy/lotus-teaching-invoices/releases/latest/download/latest.json"]`

#### 4. Capabilities

Add `core:updater:default` permission to the app's capability file so the updater plugin is allowed to operate.

#### 5. Frontend UI

On app startup, call `check()` from `@tauri-apps/plugin-updater`:

- If no update → do nothing
- If update available → show a non-intrusive notification (toast or banner) with version info and an "Update Now" button
- On click → call `update.downloadAndInstall()`, show progress, then `relaunch()`
- Handle errors gracefully (network failure → silent fail, don't block app usage)

#### 6. GitHub Actions Workflow (`.github/workflows/release.yml`)

Triggered on push of a version tag (`v*`).

Steps:

1. Checkout code
2. Setup Node.js + Bun + Rust toolchain
3. Install dependencies
4. Build and publish via `tauri-apps/tauri-action@v0`
   - Provide `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from secrets
   - Set `tagName: v__VERSION__` and `releaseName: v__VERSION__`
   - The action automatically creates the GitHub Release with all required artifacts

### Release Process

1. Bump version in `tauri.conf.json` and `package.json`
2. Commit and tag: `git tag v0.2.0 && git push --tags`
3. GitHub Actions builds, signs, and publishes the release
4. Running app instances detect the update on next launch

## Codebase Changes

| File                            | Change                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `src-tauri/Cargo.toml`          | Add `tauri-plugin-updater = "2"` dependency                      |
| `package.json`                  | Add `@tauri-apps/plugin-updater` dependency                      |
| `src-tauri/tauri.conf.json`     | Add `plugins.updater` config with pubkey and GitHub endpoint     |
| `src-tauri/src/lib.rs`          | Register `.plugin(tauri_plugin_updater::Builder::new().build())` |
| `src-tauri/capabilities/*.json` | Add `core:updater:default` permission                            |
| Frontend (new component)        | Update checker + notification UI                                 |
| `.github/workflows/release.yml` | New CI workflow for tagged releases                              |

## Error Handling

- Network unreachable → silently skip update check, log warning
- Download fails mid-way → show error toast, app continues normally
- Signature verification fails → reject update, log error
- Update check never blocks app startup or normal usage

## Testing

- Unit test: mock the update check response, verify UI shows/hides notification correctly
- Manual test: create a test release with a higher version, verify the app detects and installs it
- E2E: updater is difficult to test in automated E2E; rely on manual verification for the update flow itself

## Security

- Updates are signed with Ed25519 keypair; public key is baked into the app
- Private signing key lives only in GitHub Actions secrets
- HTTPS for all downloads
- No user credentials or tokens stored on client
