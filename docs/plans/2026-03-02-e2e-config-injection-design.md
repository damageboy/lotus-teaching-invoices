# E2E Config Injection Design

**Date:** 2026-03-02

## Problem

E2e tests need an isolated, disposable config so they can freely mutate state (add studios, save config) without touching the user's real `config.yaml` in AppData.

## Solution

Add a `--config <path>` CLI flag to the Tauri binary. When set, the app reads and writes that file instead of the default AppData location. `wdio.conf.ts` copies a checked-in fixture to a temp path, passes it to the binary, and deletes it after tests. Two tests verify the YAML on disk after a save action.

## Rust

Parse `--config <path>` from `std::env::args()` in `lib.rs`. Store as `Option<String>` in Tauri app state via `manage()`. Expose a `get_config_path` command that returns the value.

## Frontend

`useConfig.ts` calls `invoke<string | null>('get_config_path')` once on mount. If non-null, uses the absolute path for all reads and writes (no `baseDir`). If null, existing `BaseDirectory.AppData` behavior is unchanged.

## Test Fixture

`tests/fixtures/e2e-config.yaml` — valid, minimal config with one pre-configured studio and rate tier. Checked into the repo.

## wdio.conf.ts

`onPrepare` copies the fixture to `/tmp/lotus-e2e-<timestamp>.yaml`, spawns `vite preview` and the binary with `['--config', tmpPath]`. The temp path is exported so tests can read the file directly via Node `fs`. `onComplete` deletes the temp file.

## New Tests

| Test                                              | YAML verified? |
| ------------------------------------------------- | -------------- |
| Calendar: prev/next month changes heading         | No             |
| Invoices: empty state renders                     | No             |
| Log panel: toggle open/close                      | No             |
| Rates: editing Name field shows "Unsaved changes" | No             |
| Rates: save persists name change to YAML          | Yes            |
| Rates: add studio + save appears in YAML          | Yes            |
