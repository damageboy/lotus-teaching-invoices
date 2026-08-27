# Google Drive Invoice Storage Release Checklist

Do not release until every required automated and external gate is checked. Automated repository evidence does not substitute for real Google OAuth, Drive, or device evidence.

## Release record

- Date: `________________`
- Candidate commit: `________________`
- App version/build: `________________`
- Reviewer: `________________`

## A. Automated repository evidence

Record fresh results against the candidate commit.

- [x] Ignored live-test target compiles and lists exactly two tests: `cargo test --manifest-path src-tauri/Cargo.toml --test drive_live -- --list`
- [x] Drive slice: `bun run verify:drive-invoices`
- [x] Full Bun suite: `bun test`
- [x] App TypeScript: `bunx tsc --project tsconfig.app.json --noEmit`
- [x] CLI TypeScript: `bunx tsc --project tsconfig.json --noEmit`
- [x] Literal workspace rustfmt result recorded: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [x] Task-scoped Rust files pass `rustfmt --edition 2021 --check <files>` without reformatting unrelated baseline files.
- [x] Literal webdriver Clippy result recorded: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features webdriver -- -D warnings`
- [x] Webdriver Clippy passes while allowing only the current Rust/Clippy 1.97.0 baseline categories: `dead_code`, `too_many_arguments`, `while_let_on_iterator`, `needless_return`, and `single_element_loop`.
- [x] Changed targets pass `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --test drive_live --features webdriver` with exactly the same five baseline allowances, and diff inspection confirms none comes from Task 14 code.
- [x] Full webdriver Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --features webdriver`
- [x] Relevant targeted webdriver Rust tests recorded.
- [x] Integrated desktop E2E: `bun run e2e`, or an explicitly eligible unchanged-runtime result records the reused commit and test count.
- [x] Android aarch64 debug APK: `bunx tauri android build --debug --apk --target aarch64`
- [x] `git diff --check`
- [x] Generated permission files restored and `src-tauri/gen/android/gradle.properties` remains the user's unchanged, unstaged edit.

Evidence:

- Run date/time: `2026-08-25 Europe/Berlin`
- Commit tested: `Task 14 working tree based on 78c6455; record the final Task 14 commit above`
- Bun result/count: `verify:drive-invoices 539/539 Vitest; bun test 766/766`
- Rust result/count: `webdriver 155/155 plus 2 live ignored; targeted Drive 21/21; live target compiled/listed 2`
- E2E result/count and commit: `fresh Task 14 working tree, 33/33: smoke 16, Calendar 6, Drive 11`
- APK path and SHA-256: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk; 1a01d6f461ad45a1ada0214da9db5f1e16eb33fc3f5abce750dbe73cfb30cd27; arm64-v8a only`
- Literal baseline-only rustfmt/Clippy findings: `rustfmt: unchanged build.rs and main.rs; Clippy 1.97.0: dead_code x2, too_many_arguments x1, while_let_on_iterator x1, needless_return x2, single_element_loop x1 in unchanged files`

## B. Real Google Drive seam — external and required

Use one explicitly designated disposable My Drive folder. The test creates one uniquely named file and attempts to trash only its captured file ID. Never supply a production invoice folder.

- [ ] Desktop and Android access tokens were issued to their distinct OAuth clients for the same test account.
- [ ] My Drive GET exposed the same ID and standard properties to both clients.
- [ ] Android conditional metadata patch succeeded.
- [ ] A stale desktop ETag produced `Conflict` and did not overwrite Android.
- [ ] The created My Drive file ID was trashed.

```bash
LOTUS_DRIVE_LIVE_DESKTOP_TOKEN='<short-lived-desktop-client-token>' \
LOTUS_DRIVE_LIVE_ANDROID_TOKEN='<short-lived-android-client-token>' \
LOTUS_DRIVE_LIVE_PARENT_ID='<disposable-my-drive-folder-id>' \
bun run verify:drive-live
```

Repeat with both explicit parents supplied to exercise Shared Drive download and multipart replacement:

```bash
LOTUS_DRIVE_LIVE_DESKTOP_TOKEN='<short-lived-desktop-client-token>' \
LOTUS_DRIVE_LIVE_ANDROID_TOKEN='<short-lived-android-client-token>' \
LOTUS_DRIVE_LIVE_PARENT_ID='<disposable-my-drive-folder-id>' \
LOTUS_DRIVE_LIVE_SHARED_PARENT_ID='<disposable-shared-drive-folder-id>' \
bun run verify:drive-live
```

- [ ] Shared Drive create/download/conditional replacement used `supportsAllDrives=true`.
- [ ] Replacement retained the same file ID and exposed the Android-written properties and bytes to desktop.
- [ ] The created Shared Drive file ID was trashed.

Evidence:

- Test account: `________________`
- Desktop OAuth client ID suffix: `________________`
- Android OAuth client ID suffix: `________________`
- My Drive parent ID: `________________`
- Created My Drive file ID: `________________`
- Shared Drive ID: `________________`
- Shared Drive parent ID: `________________`
- Created Shared Drive file ID: `________________`
- Run date/result/log location: `________________`

## C. Physical device or Play-enabled emulator plus macOS — external and required

Use the same test account on both devices.

- [ ] Android passive startup showed no consent UI.
- [ ] Explicit Drive setup on Android granted Drive access.
- [ ] Android selected or created a My Drive root; macOS loaded the same root after refresh.
- [ ] macOS finalized an invoice; Android showed the same Drive file ID, invoice number, and fresh state.
- [ ] Android source-data change made both devices show stale after refresh.
- [ ] Android re-finalized; macOS saw the same file ID and invoice number at a newer Drive version.
- [ ] Android opened the verified PDF through an installed viewer.
- [ ] Android created a Gmail draft whose attachment matched the verified Drive bytes.
- [ ] A disposable Shared Drive root supported selection, finalization, and cross-device refresh.
- [ ] Revoked Drive access produced an explicit disabled/error state while Calendar remained usable.
- [ ] Removing folder update permission produced an explicit permission state without overwrite.
- [ ] Offline mode offered no finalized view/action; Preview still rendered locally.

Device and identity evidence:

- macOS hardware/OS: `________________`
- macOS app build: `________________`
- Desktop OAuth client ID suffix: `________________`
- Android device/emulator: `________________`
- Android OS/API level: `________________`
- Android app build: `________________`
- Android signing source: `debug / direct release / Play`
- Android OAuth client ID suffix: `________________`
- My Drive root/control-file ID: `________________`
- My Drive finalized PDF ID/invoice number: `________________`
- My Drive re-finalized version: `________________`
- Shared Drive ID/root ID: `________________`
- Shared Drive finalized PDF ID/invoice number: `________________`
- Tester/date/results: `________________`

## D. OAuth production readiness — external and required

- [ ] Desktop loopback client is registered in the release Google Cloud project.
- [ ] Android clients exist for package `com.houmus.teaching_invoices` with debug, direct-release, and Play App Signing SHA-1 fingerprints as applicable.
- [ ] Drive, Calendar, and Gmail APIs are enabled.
- [ ] Consent configuration declares the exact Gmail compose, Calendar read/events, and full Drive scopes.
- [ ] Restricted/sensitive-scope verification is approved for production use.
- [ ] Public homepage and privacy policy are live on verified domains and match actual data handling.
- [ ] Android APK contains no client secret and Lotus stores no Android refresh token.
- [ ] Ordinary visible `lotus-invoices-config.yaml` plus standard Drive `properties` were confirmed; no `appDataFolder` or `appProperties` substitution exists.

Evidence:

- Google Cloud project ID: `________________`
- Verification status/date: `________________`
- Privacy-policy URL/version: `________________`
- Desktop client ID suffix: `________________`
- Debug SHA-1/client suffix: `________________`
- Release SHA-1/client suffix: `________________`
- Play SHA-1/client suffix: `________________`

## Release decision

- [x] All automated gates are supported by recorded evidence.
- [ ] All real Google, cross-device, and OAuth production-readiness gates are supported by recorded evidence.
- Decision: `BLOCKED — external gates are unchecked`
- Approver/date: `________________`
