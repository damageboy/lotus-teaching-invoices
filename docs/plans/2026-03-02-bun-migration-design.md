# Bun Migration Design

**Date:** 2026-03-02
**Scope:** Switch from npm to bun as the package manager (runtime unchanged)

## Goal

Replace npm with bun for all package management and script execution. Keep tsx, vitest, vite, and tauri invoked identically via `bun run <script>`. No changes to runtime or test tooling.

## Changes

### 1. Lockfile

- Run `bun install` to generate `bun.lockb`
- Delete `package-lock.json`
- Commit `bun.lockb`

### 2. `.husky/pre-commit`

| Before                                         | After                                           |
| ---------------------------------------------- | ----------------------------------------------- |
| `npx lint-staged`                              | `bunx lint-staged`                              |
| `npx tsc --project tsconfig.app.json --noEmit` | `bunx tsc --project tsconfig.app.json --noEmit` |
| `npx tsc --project tsconfig.json --noEmit`     | `bunx tsc --project tsconfig.json --noEmit`     |
| `npm test`                                     | `bun run test`                                  |

### 3. `.github/workflows/build-macos.yml`

- Replace `actions/setup-node@v4` (with `node-version: 22`, `cache: npm`) with `oven-sh/setup-bun@v2`
- Replace `npm ci` with `bun install --frozen-lockfile`
- Replace `npm run build -- --target universal-apple-darwin` with `bun run build -- --target universal-apple-darwin`

### 4. `CLAUDE.md`

Update the Commands section: replace all `npm run` references with `bun run` and `npm test` with `bun test`.

## What Does Not Change

- `package.json` and all scripts within it
- `tsx` (still used for CLI dev via `bun run cli`)
- `vitest` (still used for tests)
- `vite`, `tauri` toolchain
- `node_modules/` (bun installs the same packages)
