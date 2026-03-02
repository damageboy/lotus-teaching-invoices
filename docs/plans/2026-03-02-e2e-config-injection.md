# E2E Config Injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the Tauri binary accept `--config <path>` so e2e tests run against a disposable YAML fixture instead of the user's real config.

**Architecture:** A small `std::env::args()` parser in Rust stores the path in Tauri app state and exposes it via a `get_config_path` command. `useConfig.ts` calls that command once per load/save and branches on absolute-path vs BaseDirectory behaviour. `wdio.conf.ts` copies a checked-in fixture to `/tmp`, passes `--config`, and deletes it on cleanup.

**Tech Stack:** Tauri 2, Rust (std only — no extra deps), @tauri-apps/api/core `invoke`, @tauri-apps/plugin-fs, WebdriverIO 9, yaml (already installed)

---

### Task 1: Create the test fixture YAML

**Files:**

- Create: `tests/fixtures/e2e-config.yaml`

**Step 1: Write the fixture**

```yaml
calendarUrl: ''
outputDir: ''
teacher:
  name: E2E Teacher
  address: "Test Street 1\nTest City 12345"
  taxNumber: '123/456/78901'
  bankDetails:
    accountOwner: E2E Teacher
    iban: 'DE00 1234 5678 9012 3456 78'
    bic: TESTDE88
studios:
  Test Studio:
    fullName: Test Studio GmbH
    address: 'Studio Street 1, Test City'
    rateTiers:
      - minStudents: 1
        maxStudents: 5
        rate: 40
      - minStudents: 6
        maxStudents: null
        rate: 55
```

**Step 2: Verify it parses as valid YAML**

Run: `node -e "const {parse}=require('yaml');console.log(JSON.stringify(parse(require('fs').readFileSync('tests/fixtures/e2e-config.yaml','utf8')),null,2))"`

Expected: JSON output with `teacher.name = "E2E Teacher"` and `studios["Test Studio"]`.

**Step 3: Commit**

```bash
git add tests/fixtures/e2e-config.yaml
git commit -m "test: add e2e config fixture YAML"
```

---

### Task 2: Create the shared test helpers module

**Files:**

- Create: `tests/e2e/helpers.ts`

**Step 1: Write the helpers**

```typescript
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// Fixed temp path — wdio.conf.ts writes here, tests read here.
// maxInstances: 1 so no parallelism concern.
export const TMP_CONFIG_PATH = '/tmp/lotus-e2e-config.yaml';

export function readTmpConfig(): Record<string, unknown> {
  return parse(readFileSync(TMP_CONFIG_PATH, 'utf-8'));
}
```

**Step 2: Commit**

```bash
git add tests/e2e/helpers.ts
git commit -m "test: add e2e helpers module with TMP_CONFIG_PATH"
```

---

### Task 3: Update wdio.conf.ts to copy fixture and pass --config

**Files:**

- Modify: `wdio.conf.ts`

**Step 1: Rewrite `wdio.conf.ts`**

Replace the full file with:

```typescript
import { join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Options } from '@wdio/types';
import { TMP_CONFIG_PATH } from './tests/e2e/helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binaryPath = join(__dirname, 'src-tauri', 'target', 'debug', 'app');
const fixtureConfig = join(__dirname, 'tests', 'fixtures', 'e2e-config.yaml');

let vitePreview: ChildProcess | undefined;
let app: ChildProcess | undefined;

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,

  // tauri-plugin-webdriver starts a W3C WebDriver server inside the app at port 4445.
  // We connect directly — no proxy binary needed.
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: [{ browserName: 'wry' }],

  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  onPrepare: async () => {
    // Copy the checked-in fixture to the temp path for this run
    copyFileSync(fixtureConfig, TMP_CONFIG_PATH);

    // Tauri debug binaries load the frontend from devUrl (http://localhost:1420), not from
    // the dist/ folder. Serve the pre-built dist/ so the WebView has something to load.
    vitePreview = spawn('bunx', ['vite', 'preview', '--port', '1420'], { stdio: 'inherit' });

    // Spawn the Tauri binary with our disposable config
    app = spawn(binaryPath, ['--config', TMP_CONFIG_PATH], { stdio: 'inherit' });

    // Allow both processes to initialise before WDIO attempts to create a session
    await new Promise((resolve) => setTimeout(resolve, 4000));
  },

  onComplete: () => {
    app?.kill();
    vitePreview?.kill();
    if (existsSync(TMP_CONFIG_PATH)) unlinkSync(TMP_CONFIG_PATH);
  },
};
```

**Step 2: Commit**

```bash
git add wdio.conf.ts
git commit -m "test: wire e2e fixture into wdio.conf.ts via --config flag"
```

---

### Task 4: Add --config flag and Tauri command in Rust

**Files:**

- Modify: `src-tauri/src/lib.rs`

**Step 1: Rewrite `lib.rs`**

```rust
use tauri::Manager;

struct ConfigPath(Option<String>);

#[tauri::command]
fn get_config_path(state: tauri::State<ConfigPath>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    // Parse --config <path> from CLI args (used by e2e tests for config isolation)
    let config_path: Option<String> = std::env::args()
        .skip_while(|a| a != "--config")
        .nth(1);

    let builder = tauri::Builder::default()
        .manage(ConfigPath(config_path))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            log::info!("App started. AppData: {}", app_data_dir.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file, get_config_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 2: Verify it compiles (both with and without the feature)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml --features webdriver 2>&1 | tail -3`
Expected: `Finished dev profile`

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished dev profile`

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add --config CLI flag and get_config_path Tauri command"
```

---

### Task 5: Update useConfig.ts to use the custom path when provided

**Files:**

- Modify: `src/hooks/useConfig.ts`

**Step 1: Add the import and update `load` and `save`**

Add `invoke` import at the top:

```typescript
import { invoke } from '@tauri-apps/api/core';
```

Replace the `load` callback body with:

```typescript
const load = useCallback(async () => {
  setIsLoading(true);
  setError(null);
  try {
    const configPath = await invoke<string | null>('get_config_path');
    const fileExists = configPath
      ? await exists(configPath)
      : await exists(CONFIG_FILE, { baseDir: BASE_DIR });
    if (!fileExists) {
      logInfo('Config file not found — using defaults');
      setConfig(DEFAULT_CONFIG);
    } else {
      const raw = configPath
        ? await readTextFile(configPath)
        : await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
      const parsed = parseYaml(raw);
      setConfig(validateConfig(parsed));
      logInfo('Config loaded from disk');
    }
  } catch (e) {
    logError(`Config load failed: ${e}`);
    setError(String(e));
  } finally {
    setIsLoading(false);
    setIsDirty(false);
  }
}, []);
```

Replace the `writeTextFile` call inside `save` with:

```typescript
const configPath = await invoke<string | null>('get_config_path');
if (configPath) {
  await writeTextFile(configPath, stringifyYaml(toSave));
} else {
  await writeTextFile(CONFIG_FILE, stringifyYaml(toSave), { baseDir: BASE_DIR });
}
```

**Step 2: Type-check**

Run: `bunx tsc --project tsconfig.app.json --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/hooks/useConfig.ts
git commit -m "feat: useConfig reads/writes custom path when --config flag is set"
```

---

### Task 6: Write all new e2e tests

**Files:**

- Modify: `tests/e2e/smoke.e2e.ts` (add describe blocks for each area)

**Step 1: Replace smoke.e2e.ts with the full suite**

```typescript
import { expect, browser, $ } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { TMP_CONFIG_PATH } from './helpers.js';

function readTmpConfig() {
  return parse(readFileSync(TMP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

describe('Boot', () => {
  before(async () => {
    await browser.pause(2000);
  });

  it('renders the three tab buttons', async () => {
    await expect($('button=Calendar')).toBeDisplayed();
    await expect($('button=Invoices')).toBeDisplayed();
    await expect($('button=Rates & Config')).toBeDisplayed();
  });
});

// ─── Calendar tab ────────────────────────────────────────────────────────────

describe('Calendar tab', () => {
  before(async () => {
    await $('button=Calendar').click();
    await browser.pause(300);
  });

  it('shows a month heading', async () => {
    const heading = await $('h2');
    const text = await heading.getText();
    // Matches e.g. "February 2026"
    expect(text).toMatch(/^[A-Z][a-z]+ \d{4}$/);
  });

  it('navigates to the previous month on ‹ click', async () => {
    const heading = await $('h2');
    const before = await heading.getText();
    await $('button=‹').click();
    const after = await heading.getText();
    expect(after).not.toBe(before);
  });

  it('navigates to the next month on › click', async () => {
    const heading = await $('h2');
    const before = await heading.getText();
    await $('button=›').click();
    const after = await heading.getText();
    expect(after).not.toBe(before);
  });

  it('shows the Refresh button', async () => {
    await expect($('button*=Refresh')).toBeDisplayed();
  });
});

// ─── Invoices tab ────────────────────────────────────────────────────────────

describe('Invoices tab', () => {
  before(async () => {
    await $('button=Invoices').click();
    await browser.pause(300);
  });

  it('shows "No classes loaded" when calendar is empty', async () => {
    await expect($('td=No classes loaded')).toBeDisplayed();
  });

  it('shows "not set" for the output folder', async () => {
    await expect($('span=not set')).toBeDisplayed();
  });

  it('has a "Change folder…" button', async () => {
    await expect($('button=Change folder\u2026')).toBeDisplayed();
  });
});

// ─── Rates & Config tab ──────────────────────────────────────────────────────

describe('Rates & Config tab', () => {
  before(async () => {
    await $('button=Rates & Config').click();
    await browser.pause(500);
  });

  it('renders the Name label', async () => {
    await expect($('label=Name')).toBeDisplayed();
  });

  it('shows "Unsaved changes" after editing the Name field', async () => {
    const nameInput = await $('label=Name').$('input');
    await nameInput.clearValue();
    await nameInput.setValue('E2E Updated Teacher');
    await expect($('span=Unsaved changes')).toBeDisplayed();
  });

  it('persists the name change to the YAML file after Save', async () => {
    await $('button=Save').click();
    await browser.pause(1000);
    const cfg = readTmpConfig() as { teacher: { name: string } };
    expect(cfg.teacher.name).toBe('E2E Updated Teacher');
  });

  it('adds a new studio and saves it to the YAML file', async () => {
    const before = Object.keys((readTmpConfig() as { studios: object }).studios).length;
    await $('button*=Add studio').click();
    await browser.pause(300);
    await $('button=Save').click();
    await browser.pause(1000);
    const after = Object.keys((readTmpConfig() as { studios: object }).studios).length;
    expect(after).toBe(before + 1);
  });
});

// ─── Log panel ───────────────────────────────────────────────────────────────

describe('Log panel', () => {
  it('opens the log drawer on click', async () => {
    await $('button*=▲').click();
    await expect($('.bg-gray-950')).toBeDisplayed();
  });

  it('closes the log drawer on a second click', async () => {
    await $('button*=▼').click();
    await expect($('.bg-gray-950')).not.toBeDisplayed();
  });
});
```

**Step 2: Commit**

```bash
git add tests/e2e/smoke.e2e.ts
git commit -m "test: expand e2e suite — calendar nav, invoices, rates+YAML, log panel"
```

---

### Task 7: Build and run the full e2e suite

**Step 1: Build Vite frontend**

Run: `bun run build:vite`
Expected: `dist/` populated with fresh assets

**Step 2: Build the Rust binary with webdriver feature**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --features webdriver 2>&1 | tail -3`
Expected: `Finished dev profile`

**Step 3: Run the tests**

Run: `bunx wdio run wdio.conf.ts`
Expected: all tests pass; look for the two YAML-verification tests passing explicitly.

If a test fails, debug before moving on — do not batch-fix.

**Step 4: Verify the temp file is gone after the run**

Run: `ls /tmp/lotus-e2e-config.yaml 2>/dev/null || echo "cleaned up"`
Expected: `cleaned up`

---

### Task 8: Final commit + memory update

**Step 1: Commit any remaining unstaged files**

```bash
git add -p   # review and stage selectively
git commit -m "chore: finalize e2e config injection wiring"
```

**Step 2: Update MEMORY.md** with the new e2e test architecture:

- `wdio.conf.ts` now copies `tests/fixtures/e2e-config.yaml` → `/tmp/lotus-e2e-config.yaml` and passes `--config` to binary
- `get_config_path` Tauri command returns the override path or null
- `useConfig.ts` branches on that value for all reads and writes
- New tests: calendar nav, invoices empty state, rates dirty+save+YAML verify, log panel toggle
