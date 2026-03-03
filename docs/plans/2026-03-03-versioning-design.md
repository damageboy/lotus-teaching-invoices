# Versioning Design

Date: 2026-03-03

## Goal

Embed a meaningful version string into every build so that:

- Official releases (from a `v*` git tag via GitHub Actions) show a clean semver: `1.0.0`
- Dev builds (local `bun run build`) show git-describe metadata: `1.0.0-3-gabcdef`
- Dirty builds (uncommitted changes present) are further marked: `1.0.0-3-gabcdef-dirty`
- The version is visible in the config tab and in the native macOS About dialog

## Approach: Vite `define` + CI tag injection

Version metadata is baked into the frontend bundle at Vite build time via two compile-time constants injected through Vite's `define`. No Rust changes, no Tauri commands, no runtime fetch.

### Version string format

| Situation                      | `__APP_VERSION__`         | `__APP_IS_OFFICIAL__` |
| ------------------------------ | ------------------------- | --------------------- |
| CI tag build (`v1.0.0`)        | `"1.0.0"`                 | `true`                |
| Dev, 3 commits past tag, clean | `"1.0.0-3-gabcdef"`       | `false`               |
| Dev, dirty working tree        | `"1.0.0-3-gabcdef-dirty"` | `false`               |
| No tags in repo                | `"gabcdef"`               | `false`               |
| Git unavailable                | `"unknown"`               | `false`               |

### Computation logic (in `vite.config.ts`)

1. Check `GITHUB_REF` env var. If it matches `refs/tags/v*`, extract the semver (strip `v`), set `isOfficial = true`.
2. Otherwise run `git describe --tags --dirty=-dirty --always --abbrev=7`, strip leading `v`.
3. On any failure, fall back to `"unknown"`.

## UI placement

**Config tab (`RatesTab`):** A small badge at the bottom-right, below "+ Add studio", in `text-xs text-gray-400`.

- Official: `v1.0.0`
- Dev: `v1.0.0-3-gabcdef` + muted `dev` pill
- Dirty: `v1.0.0-3-gabcdef-dirty` + amber `dirty` pill

**Native macOS About dialog:** Already present automatically in Tauri 2 (system app menu). Reads the version from `tauri.conf.json`. CI updates this field to the tag semver before building, so official releases show the correct version. Dev builds show the last committed value.

## CI workflow changes

Modify `.github/workflows/build-macos.yml`:

1. Add `push: tags: ['v*']` trigger alongside the existing branch trigger.
2. Add a conditional step (runs only on tag pushes) that rewrites `tauri.conf.json`'s `version` field using `node -e` before the Tauri build. In-place for the build only — not committed back.

## File inventory

| File                                | Change                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `vite.config.ts`                    | Add `appVersionPlugin` helper; inject `__APP_VERSION__` and `__APP_IS_OFFICIAL__` via `define` |
| `src/vite-env.d.ts`                 | Declare `__APP_VERSION__: string` and `__APP_IS_OFFICIAL__: boolean` globals                   |
| `src/lib/version.ts`                | New — typed re-exports of the two compile-time constants                                       |
| `src/components/RatesTab/index.tsx` | Add version badge at the bottom of the tab                                                     |
| `.github/workflows/build-macos.yml` | Add `v*` tag trigger + conditional `tauri.conf.json` version-injection step                    |

## Out of scope

- Updating `Cargo.toml` version (Tauri 2 reads the bundle version from `tauri.conf.json` only)
- Windows / Linux builds (no workflow exists yet)
- Auto-creating GitHub Releases (can be added to the workflow later)
