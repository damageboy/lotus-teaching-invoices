# Tauri Desktop App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the existing Node.js CLI into a Tauri 2 desktop app with a React frontend — three tabs: calendar view, invoices table with PDF generation, and a rate/config editor.

**Architecture:** Tauri 2 is a thin native shell providing HTTP fetch (CORS bypass), file system access, folder picker dialogs, and shell `open()`. All business logic runs in the Vite/React webview. Existing TypeScript lib code is moved to `src/lib/` and adapted for the browser (swap `node-ical` → `ical.js`).

**Tech Stack:** Tauri 2, React 18, TypeScript, Vite, Tailwind CSS, `ical.js`, `@react-pdf/renderer`, `yaml`

**Read first:** `docs/plans/2026-03-01-tauri-app-design.md`

---

## Task 1: Add Tauri 2 + Vite + React scaffold

**Files:**

- Modify: `package.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx` (placeholder)
- Create: `tsconfig.app.json`
- Modify: `tsconfig.json`

**Step 1: Install frontend dependencies**

```bash
npm install react react-dom
npm install --save-dev @vitejs/plugin-react vite
npm install --save-dev @types/react @types/react-dom
npm install tailwindcss @tailwindcss/vite
```

**Step 2: Install Tauri CLI and API**

```bash
npm install --save-dev @tauri-apps/cli@2
npm install @tauri-apps/api@2
npm install @tauri-apps/plugin-http @tauri-apps/plugin-fs @tauri-apps/plugin-dialog @tauri-apps/plugin-shell
```

**Step 3: Create `vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

**Step 4: Create `index.html` at project root**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lotus Teaching Invoices</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create `tsconfig.app.json`** (Vite frontend — no Node types)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

**Step 6: Update `tsconfig.json`** (keep for CLI/tests, exclude `src-tauri`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/cli", "src/lib"],
  "exclude": ["node_modules", "dist", "tests", "src-tauri"]
}
```

**Step 7: Create placeholder `src/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**Step 8: Create placeholder `src/App.tsx`**

```tsx
export default function App() {
  return <div className="p-4 text-xl">Lotus Teaching Invoices</div>;
}
```

**Step 9: Create `src/index.css`** (Tailwind entry)

```css
@import 'tailwindcss';
```

**Step 10: Update `package.json` scripts**

```json
{
  "scripts": {
    "dev": "tauri dev",
    "dev:vite": "vite",
    "build": "tauri build",
    "build:vite": "vite build",
    "cli": "tsx src/cli/main.ts",
    "cli:build": "tsc --project tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 11: Run `npx tauri init`**

```bash
npx tauri init
```

Answer the prompts:

- App name: `Lotus Teaching Invoices`
- Window title: `Lotus Teaching Invoices`
- Web assets location: `../dist`
- Dev server URL: `http://localhost:1420`
- Dev command: `npm run dev:vite`
- Build command: `npm run build:vite`

**Step 12: Add Tauri plugins to `src-tauri/Cargo.toml`**

Add under `[dependencies]`:

```toml
tauri-plugin-http = "2"
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
```

**Step 13: Register plugins in `src-tauri/src/lib.rs`**

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 14: Add plugin permissions in `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "http:default",
    "fs:default",
    "fs:allow-app-write",
    "dialog:default",
    "shell:allow-open"
  ]
}
```

**Step 15: Verify the scaffold runs**

```bash
npm run dev
```

Expected: Tauri window opens showing "Lotus Teaching Invoices" in large text. No errors in terminal.

**Step 16: Commit**

```bash
git add -A
git commit -m "feat: scaffold Tauri 2 + Vite + React app"
```

---

## Task 2: Restructure src/ — move lib code, rename CLI entry

The existing business logic moves to `src/lib/`. The CLI entry moves to `src/cli/main.ts`. Tests update their import paths.

**Files:**

- Move: `src/calendar/` → `src/lib/calendar/`
- Move: `src/config/` → `src/lib/config/`
- Move: `src/invoice/` → `src/lib/invoice/`
- Move: `src/output/` → `src/lib/output/`
- Move: `src/types.ts` → `src/lib/types.ts`
- Move: `src/index.ts` → `src/cli/main.ts`
- Modify: `tests/**/*.ts` (update import paths)
- Modify: `src/cli/main.ts` (update imports)

**Step 1: Move files**

```bash
mkdir -p src/lib src/cli
mv src/calendar src/lib/calendar
mv src/config src/lib/config
mv src/invoice src/lib/invoice
mv src/output src/lib/output
mv src/types.ts src/lib/types.ts
mv src/index.ts src/cli/main.ts
```

**Step 2: Update imports in `src/cli/main.ts`**

Change all `"./` and `"../` paths to point into `src/lib/`:

```typescript
import { parseArgs } from '../lib/cli/args.js';
```

Wait — `src/cli/args.ts` was under `src/cli/` already. Move it too:

```bash
mv src/cli src/lib/cli
mkdir -p src/cli
mv src/lib/cli/args.ts src/cli/args.ts   # keep args.ts with CLI
```

Then `src/cli/main.ts` imports:

```typescript
import { parseArgs } from './args.js';
import { loadConfig } from '../lib/config/loader.js';
import { fetchCalendar } from '../lib/calendar/fetcher.js';
import { parseCalendarEvents, extractClasses } from '../lib/calendar/parser.js';
import { groupByStudio, filterByDateRange, filterByStudio } from '../lib/invoice/grouper.js';
import { generateInvoice } from '../lib/invoice/generator.js';
import { writeInvoice, printInvoice } from '../lib/output/writer.js';
import { printWarningReport } from '../lib/output/reporter.js';
import { AppError, InvoicePeriod, ParseWarning } from '../lib/types.js';
```

**Step 3: Fix all internal imports within `src/lib/`**

Each file in `src/lib/` that imports from a sibling must update its path. For example, `src/lib/calendar/parser.ts` imports from `../types.js` — that is still correct since `types.ts` is in `src/lib/`. Go through each file and verify relative paths are unchanged (they should be, since the internal structure is preserved).

**Step 4: Update test import paths**

In every file under `tests/`, change `../../src/` to `../../src/lib/`:

```bash
# Preview the changes
grep -r "from \"../../src/" tests/

# Apply
find tests -name "*.ts" -exec sed -i '' 's|from "../../src/|from "../../src/lib/|g' {} \;
```

The one exception is `tests/calendar/parser.test.ts` — its import of `../../src/calendar/parser.js` becomes `../../src/lib/calendar/parser.js`.

**Step 5: Run tests to verify nothing broke**

```bash
npm test
```

Expected: all 31 tests pass.

**Step 6: Verify CLI still works**

```bash
npm run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run 2>&1 | head -5
```

Expected: JSON invoice output begins.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move business logic to src/lib/, CLI to src/cli/"
```

---

## Task 3: Replace node-ical with ical.js, update AppConfig for new fields

`node-ical` uses Node.js APIs and cannot run in the browser. `ical.js` is Mozilla's browser-compatible ICS parser with an equivalent data model.

**Files:**

- Modify: `src/lib/calendar/parser.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `tests/calendar/parser.test.ts`
- Modify: `config.example.yaml`

**Step 1: Install ical.js**

```bash
npm install ical.js
npm install --save-dev @types/ical.js
```

**Step 2: Update `src/lib/types.ts` — add new AppConfig fields**

Change `AppConfig`:

```typescript
export interface AppConfig {
  teacherName: string;
  calendarUrl: string;
  outputDir: string;
  studios: Record<string, StudioConfig>;
}
```

**Step 3: Update `src/lib/config/schema.ts` — validate new fields**

In `validateConfig`, add after the `calendarUrl` check:

```typescript
const teacherName = typeof obj.teacherName === 'string' ? obj.teacherName : '';
const outputDir = typeof obj.outputDir === 'string' ? obj.outputDir : '';
```

And in the returned config object:

```typescript
const config: AppConfig = {
  teacherName,
  calendarUrl: obj.calendarUrl,
  outputDir,
  studios: {},
};
```

**Step 4: Rewrite `src/lib/calendar/parser.ts` to use ical.js**

```typescript
import ICAL from 'ical.js';
import { CalendarEvent, ParsedClass, ParseWarning } from '../types.js';

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseStudentCount(description: string | undefined): number | null {
  if (!description) return null;
  const match = description.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function parseCalendarEvents(icsData: string): CalendarEvent[] {
  const jcal = ICAL.parse(icsData);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  const events: CalendarEvent[] = [];

  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    if (!event.summary || !event.startDate || !event.endDate) continue;

    events.push({
      uid: (vevent.getFirstPropertyValue('uid') as string) ?? event.uid,
      summary: event.summary,
      description: (vevent.getFirstPropertyValue('description') as string) ?? '',
      start: event.startDate.toJSDate(),
      end: event.endDate.toJSDate(),
    });
  }

  return events;
}

// extractClasses is unchanged — copy as-is from previous version
export function extractClasses(
  events: CalendarEvent[],
  knownStudios: Map<string, string>
): { classes: ParsedClass[]; warnings: ParseWarning[] } {
  // ... (identical to current implementation)
}
```

**Step 5: Run tests**

```bash
npm test
```

Expected: all 31 tests pass. The `parseCalendarEvents` tests use the fixture ICS file and should produce identical output.

**Step 6: Update `config.example.yaml` with new fields**

```yaml
teacherName: 'Your Name'
calendarUrl: 'https://calendar.google.com/calendar/ical/YOUR_CALENDAR_ID/basic.ics'
outputDir: ''
studios:
  'Zen Yoga':
    rateTiers:
      - { minStudents: 1, maxStudents: 5, rate: 80 }
      - { minStudents: 6, maxStudents: 10, rate: 100 }
      - { minStudents: 11, maxStudents: null, rate: 120 }
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace node-ical with ical.js, add teacherName/outputDir to config"
```

---

## Task 4: Implement useConfig hook

Reads and writes `config.yaml` from Tauri's app data directory. On first launch (file doesn't exist), writes a default config.

**Files:**

- Create: `src/hooks/useConfig.ts`
- Create: `src/lib/config/defaults.ts`

**Step 1: Create `src/lib/config/defaults.ts`**

```typescript
import { AppConfig } from '../types.js';

export const DEFAULT_CONFIG: AppConfig = {
  teacherName: '',
  calendarUrl: '',
  outputDir: '',
  studios: {},
};
```

**Step 2: Create `src/hooks/useConfig.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AppConfig } from '../lib/types';
import { validateConfig } from '../lib/config/schema';
import { DEFAULT_CONFIG } from '../lib/config/defaults';

const CONFIG_FILE = 'config.yaml';
const BASE_DIR = BaseDirectory.AppData;

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
      if (!fileExists) {
        // First launch — write defaults
        await writeTextFile(CONFIG_FILE, stringifyYaml(DEFAULT_CONFIG), { baseDir: BASE_DIR });
        setConfig(DEFAULT_CONFIG);
      } else {
        const raw = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
        const parsed = parseYaml(raw);
        setConfig(validateConfig(parsed));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
      setIsDirty(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateConfig = useCallback((next: AppConfig) => {
    setConfig(next);
    setIsDirty(true);
  }, []);

  const save = useCallback(
    async (next?: AppConfig) => {
      const toSave = next ?? config;
      await writeTextFile(CONFIG_FILE, stringifyYaml(toSave), { baseDir: BASE_DIR });
      setConfig(toSave);
      setIsDirty(false);
    },
    [config]
  );

  return { config, isDirty, isLoading, error, updateConfig, save, reload: load };
}
```

**Step 3: Verify TypeScript compiles with no errors**

```bash
npx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/hooks/useConfig.ts src/lib/config/defaults.ts
git commit -m "feat: add useConfig hook (reads/writes config.yaml via Tauri fs)"
```

---

## Task 5: Implement useCalendarData hook

Fetches the ICS URL via Tauri's HTTP plugin on mount, parses it, and caches the result. Exposes a `refresh()` function.

**Files:**

- Create: `src/hooks/useCalendarData.ts`

**Step 1: Create `src/hooks/useCalendarData.ts`**

```typescript
import { useState, useCallback } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import { parseCalendarEvents, extractClasses } from '../lib/calendar/parser';
import { ParsedClass, ParseWarning, AppConfig } from '../lib/types';

export interface CalendarData {
  classes: ParsedClass[];
  warnings: ParseWarning[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCalendarData(config: AppConfig): CalendarData {
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!config.calendarUrl) {
      setError('No calendar URL configured. Set it in the Rates tab.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(config.calendarUrl);
      const icsData = await response.text();
      const events = parseCalendarEvents(icsData);
      const knownStudios = new Map(
        Object.keys(config.studios).map((name) => [name.toLowerCase(), name])
      );
      const { classes: parsed, warnings: warns } = extractClasses(events, knownStudios);
      setClasses(parsed);
      setWarnings(warns);
    } catch (e) {
      setError(`Failed to fetch calendar: ${e}`);
    } finally {
      setIsLoading(false);
    }
  }, [config.calendarUrl, config.studios]);

  return { classes, warnings, isLoading, error, refresh };
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/hooks/useCalendarData.ts
git commit -m "feat: add useCalendarData hook (fetches and caches ICS via Tauri HTTP)"
```

---

## Task 6: App shell — three-tab layout

Wire up both hooks and render the tab navigation. Each tab is a placeholder component for now.

**Files:**

- Modify: `src/App.tsx`
- Create: `src/components/CalendarTab/index.tsx` (placeholder)
- Create: `src/components/InvoicesTab/index.tsx` (placeholder)
- Create: `src/components/RatesTab/index.tsx` (placeholder)

**Step 1: Create placeholder tab components**

`src/components/CalendarTab/index.tsx`:

```tsx
import { ParsedClass } from '../../lib/types';
interface Props {
  classes: ParsedClass[];
}
export function CalendarTab({ classes }: Props) {
  return <div className="p-4">Calendar — {classes.length} classes loaded</div>;
}
```

`src/components/InvoicesTab/index.tsx`:

```tsx
import { ParsedClass, AppConfig } from '../../lib/types';
interface Props {
  classes: ParsedClass[];
  config: AppConfig;
  onSaveConfig: (c: AppConfig) => Promise<void>;
}
export function InvoicesTab({ classes }: Props) {
  return <div className="p-4">Invoices — {classes.length} classes</div>;
}
```

`src/components/RatesTab/index.tsx`:

```tsx
import { AppConfig } from '../../lib/types';
interface Props {
  config: AppConfig;
  isDirty: boolean;
  onUpdate: (c: AppConfig) => void;
  onSave: () => Promise<void>;
}
export function RatesTab({ config }: Props) {
  return <div className="p-4">Rates — {Object.keys(config.studios).length} studios</div>;
}
```

**Step 2: Implement `src/App.tsx`**

```tsx
import { useState, useEffect } from 'react';
import { useConfig } from './hooks/useConfig';
import { useCalendarData } from './hooks/useCalendarData';
import { CalendarTab } from './components/CalendarTab';
import { InvoicesTab } from './components/InvoicesTab';
import { RatesTab } from './components/RatesTab';

type Tab = 'calendar' | 'invoices' | 'rates';

export default function App() {
  const { config, isDirty, isLoading: configLoading, updateConfig, save } = useConfig();
  const { classes, isLoading: calLoading, error: calError, refresh } = useCalendarData(config);
  const [activeTab, setActiveTab] = useState<Tab>('calendar');

  // Fetch calendar once config is loaded and calendarUrl is set
  useEffect(() => {
    if (!configLoading && config.calendarUrl) refresh();
  }, [configLoading, config.calendarUrl]);

  if (configLoading) {
    return <div className="flex items-center justify-center h-screen text-gray-500">Loading…</div>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'rates', label: 'Rates & Config' },
  ];

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-indigo-600 text-indigo-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.label}
            {tab.id === 'rates' && isDirty && (
              <span className="ml-2 text-xs text-amber-500">●</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center px-4 gap-3">
          {calLoading && <span className="text-xs text-gray-400">Refreshing…</span>}
          {calError && (
            <span className="text-xs text-red-500" title={calError}>
              ⚠ Calendar error
            </span>
          )}
          <button
            onClick={refresh}
            disabled={calLoading}
            className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40"
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'calendar' && <CalendarTab classes={classes} />}
        {activeTab === 'invoices' && (
          <InvoicesTab classes={classes} config={config} onSaveConfig={save} />
        )}
        {activeTab === 'rates' && (
          <RatesTab
            config={config}
            isDirty={isDirty}
            onUpdate={updateConfig}
            onSave={() => save()}
          />
        )}
      </div>
    </div>
  );
}
```

**Step 3: Verify the app runs**

```bash
npm run dev
```

Expected: Tauri window shows three tabs. Calendar tab shows "N classes loaded" once the ICS fetches. No TypeScript errors.

**Step 4: Commit**

```bash
git add src/App.tsx src/components/
git commit -m "feat: add three-tab app shell with useConfig and useCalendarData wired up"
```

---

## Task 7: CalendarTab — monthly grid

A monthly grid with studio-colored event chips and a month switcher.

**Files:**

- Modify: `src/components/CalendarTab/index.tsx`
- Create: `src/components/CalendarTab/CalendarGrid.tsx`
- Create: `src/components/CalendarTab/EventChip.tsx`
- Create: `src/lib/studioColors.ts`

**Step 1: Create `src/lib/studioColors.ts`** (deterministic color from studio name)

```typescript
// A palette of distinct colors — extend as needed
const PALETTE = [
  { bg: 'bg-violet-100', text: 'text-violet-800', border: 'border-violet-300' },
  { bg: 'bg-sky-100', text: 'text-sky-800', border: 'border-sky-300' },
  { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-300' },
  { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-300' },
  { bg: 'bg-rose-100', text: 'text-rose-800', border: 'border-rose-300' },
  { bg: 'bg-teal-100', text: 'text-teal-800', border: 'border-teal-300' },
];

function hashString(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function studioColor(name: string) {
  return PALETTE[hashString(name) % PALETTE.length];
}
```

**Step 2: Create `src/components/CalendarTab/EventChip.tsx`**

```tsx
import { ParsedClass } from '../../lib/types';
import { studioColor } from '../../lib/studioColors';

interface Props {
  cls: ParsedClass;
}

export function EventChip({ cls }: Props) {
  const color = studioColor(cls.studioName);
  return (
    <div
      title={`${cls.studioName} — ${cls.studentCount} students`}
      className={`text-xs rounded px-1 py-0.5 mb-0.5 truncate border ${color.bg} ${color.text} ${color.border} cursor-default`}
    >
      {cls.startTime} {cls.classType}
    </div>
  );
}
```

**Step 3: Create `src/components/CalendarTab/CalendarGrid.tsx`**

```tsx
import { ParsedClass } from '../../lib/types';
import { EventChip } from './EventChip';

interface Props {
  year: number;
  month: number; // 0-indexed (0 = January)
  classes: ParsedClass[];
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  // Returns 0=Mon … 6=Sun
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7;
}

export function CalendarGrid({ year, month, classes }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDow = getFirstDayOfWeek(year, month);

  // Build a map: "YYYY-MM-DD" -> ParsedClass[]
  const byDate = new Map<string, ParsedClass[]>();
  for (const cls of classes) {
    const list = byDate.get(cls.date) ?? [];
    list.push(cls);
    byDate.set(cls.date, list);
  }

  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded">
      {DAY_LABELS.map((d) => (
        <div key={d} className="bg-gray-50 text-center text-xs font-medium text-gray-500 py-1">
          {d}
        </div>
      ))}
      {cells.map((day, i) => {
        if (day === null) {
          return <div key={`empty-${i}`} className="bg-gray-50 min-h-[80px]" />;
        }
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayClasses = byDate.get(dateStr) ?? [];
        const today = new Date();
        const isToday =
          today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

        return (
          <div key={dateStr} className="bg-white min-h-[80px] p-1">
            <div
              className={`text-xs font-medium mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : 'text-gray-700'
              }`}
            >
              {day}
            </div>
            {dayClasses.map((cls, j) => (
              <EventChip key={`${dateStr}-${j}`} cls={cls} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

**Step 4: Implement `src/components/CalendarTab/index.tsx`**

```tsx
import { useState } from 'react';
import { ParsedClass } from '../../lib/types';
import { CalendarGrid } from './CalendarGrid';
import { studioColor } from '../../lib/studioColors';

interface Props {
  classes: ParsedClass[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function CalendarTab({ classes }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const monthClasses = classes.filter((cls) => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return cls.date.startsWith(prefix);
  });

  // Unique studios for legend
  const studios = [...new Set(classes.map((c) => c.studioName))].sort();

  function prevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else setMonth((m) => m + 1);
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Month switcher */}
      <div className="flex items-center gap-4">
        <button onClick={prevMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ‹
        </button>
        <h2 className="text-lg font-semibold w-44 text-center">
          {MONTH_NAMES[month]} {year}
        </h2>
        <button onClick={nextMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ›
        </button>
        <span className="ml-4 text-sm text-gray-400">{monthClasses.length} classes</span>
      </div>

      {/* Legend */}
      {studios.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {studios.map((s) => {
            const c = studioColor(s);
            return (
              <span
                key={s}
                className={`text-xs px-2 py-0.5 rounded border ${c.bg} ${c.text} ${c.border}`}
              >
                {s}
              </span>
            );
          })}
        </div>
      )}

      <CalendarGrid year={year} month={month} classes={monthClasses} />
    </div>
  );
}
```

**Step 5: Verify in the running app**

```bash
npm run dev
```

Expected: Calendar tab shows a monthly grid. Classes appear as colored chips on their dates. Month switcher navigates between months.

**Step 6: Commit**

```bash
git add src/components/CalendarTab/ src/lib/studioColors.ts
git commit -m "feat: implement CalendarTab with monthly grid and studio colors"
```

---

## Task 8: PDF generation

Build the invoice PDF template using `@react-pdf/renderer` and a utility to save + open it.

**Files:**

- Create: `src/lib/pdf/InvoiceDocument.tsx`
- Create: `src/lib/pdf/generatePdf.ts`

**Step 1: Install @react-pdf/renderer**

```bash
npm install @react-pdf/renderer
npm install --save-dev @types/react-pdf
```

Note: `@react-pdf/renderer` ships its own types; if `@types/react-pdf` doesn't exist, skip it.

**Step 2: Create `src/lib/pdf/InvoiceDocument.tsx`**

```tsx
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { Invoice, AppConfig } from '../types';

const s = StyleSheet.create({
  page: { padding: 48, fontFamily: 'Helvetica', fontSize: 10, color: '#111' },
  header: { marginBottom: 32 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { fontSize: 11, color: '#555' },
  section: { marginBottom: 20 },
  label: { fontSize: 8, color: '#888', textTransform: 'uppercase', marginBottom: 2 },
  value: { fontSize: 10 },
  table: { marginTop: 16 },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: '#ddd',
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderColor: '#eee',
  },
  col: { flex: 1, fontSize: 9 },
  colRight: { flex: 1, fontSize: 9, textAlign: 'right' },
  total: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    fontSize: 11,
    fontWeight: 'bold',
  },
});

interface Props {
  invoice: Invoice;
  config: AppConfig;
}

export function InvoiceDocument({ invoice, config }: Props) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{config.teacherName || 'Invoice'}</Text>
          <Text style={s.subtitle}>{invoice.studioName}</Text>
        </View>

        <View style={s.section}>
          <Text style={s.label}>Invoice period</Text>
          <Text style={s.value}>
            {invoice.invoicePeriod.from} — {invoice.invoicePeriod.to}
          </Text>
        </View>

        <View style={s.table}>
          <View style={s.tableHead}>
            <Text style={s.col}>Date</Text>
            <Text style={s.col}>Time</Text>
            <Text style={s.col}>Class</Text>
            <Text style={s.colRight}>Students</Text>
            <Text style={s.colRight}>Rate (€)</Text>
            <Text style={s.colRight}>Total (€)</Text>
          </View>
          {invoice.classes.map((item, i) => (
            <View key={i} style={s.tableRow}>
              <Text style={s.col}>{item.date}</Text>
              <Text style={s.col}>
                {item.startTime}–{item.endTime}
              </Text>
              <Text style={s.col}>{item.classType}</Text>
              <Text style={s.colRight}>{item.studentCount}</Text>
              <Text style={s.colRight}>{item.rateApplied}</Text>
              <Text style={s.colRight}>{item.lineTotal}</Text>
            </View>
          ))}
        </View>

        <View style={s.total}>
          <Text>Total: €{invoice.totalAmount}</Text>
        </View>
      </Page>
    </Document>
  );
}
```

**Step 3: Create `src/lib/pdf/generatePdf.ts`**

```typescript
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { writeFile } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-shell';
import { Invoice, AppConfig } from '../types';
import { InvoiceDocument } from './InvoiceDocument';

export function invoiceFilename(invoice: Invoice): string {
  const slug = invoice.studioName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const [year, month] = invoice.invoicePeriod.from.split('-');
  return `${slug}-${year}-${month}.pdf`;
}

export async function generateAndOpenPdf(invoice: Invoice, config: AppConfig): Promise<void> {
  const filename = invoiceFilename(invoice);
  const outputPath = `${config.outputDir}/${filename}`;

  const blob = await pdf(React.createElement(InvoiceDocument, { invoice, config })).toBlob();

  const arrayBuffer = await blob.arrayBuffer();
  await writeFile(outputPath, new Uint8Array(arrayBuffer));
  await open(outputPath);
}
```

**Step 4: Verify TypeScript compiles**

```bash
npx tsc --project tsconfig.app.json --noEmit
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/lib/pdf/
git commit -m "feat: add PDF invoice generation with @react-pdf/renderer"
```

---

## Task 9: InvoicesTab — table + output folder setting

**Files:**

- Modify: `src/components/InvoicesTab/index.tsx`

**Step 1: Implement `src/components/InvoicesTab/index.tsx`**

```tsx
import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ParsedClass, AppConfig, InvoicePeriod } from '../../lib/types';
import { groupByStudio, filterByDateRange } from '../../lib/invoice/grouper';
import { generateInvoice } from '../../lib/invoice/generator';
import { generateAndOpenPdf } from '../../lib/pdf/generatePdf';

interface Props {
  classes: ParsedClass[];
  config: AppConfig;
  onSaveConfig: (c: AppConfig) => Promise<void>;
}

interface InvoiceRow {
  studioName: string;
  monthKey: string; // "YYYY-MM"
  label: string; // "February 2026"
  classCount: number;
  total: number;
  classes: ParsedClass[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function buildRows(classes: ParsedClass[]): InvoiceRow[] {
  const map = new Map<string, ParsedClass[]>();
  for (const cls of classes) {
    const key = `${cls.studioName}__${cls.date.slice(0, 7)}`;
    const list = map.get(key) ?? [];
    list.push(cls);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([key, clsList]) => {
      const [studioName, monthKey] = key.split('__');
      const [y, m] = monthKey.split('-');
      return {
        studioName,
        monthKey,
        label: `${MONTH_NAMES[parseInt(m) - 1]} ${y}`,
        classCount: clsList.length,
        total: clsList.reduce((sum, c) => sum + c.studentCount, 0), // placeholder — real total from invoice
        classes: clsList,
      };
    })
    .sort(
      (a, b) => b.monthKey.localeCompare(a.monthKey) || a.studioName.localeCompare(b.studioName)
    );
}

export function InvoicesTab({ classes, config, onSaveConfig }: Props) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const rows = buildRows(classes);

  async function chooseOutputFolder() {
    const selected = await openDialog({ directory: true, title: 'Choose invoice output folder' });
    if (typeof selected === 'string') {
      await onSaveConfig({ ...config, outputDir: selected });
    }
  }

  async function handleGenerate(row: InvoiceRow) {
    if (!config.outputDir) {
      setRowError('Set an output folder first.');
      return;
    }
    const rowKey = `${row.studioName}__${row.monthKey}`;
    setGenerating(rowKey);
    setRowError(null);
    try {
      const [year, month] = row.monthKey.split('-');
      const from = `${year}-${month}-01`;
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
      const period: InvoicePeriod = { from, to };
      const studioConfig = config.studios[row.studioName];
      if (!studioConfig) throw new Error(`No config for studio "${row.studioName}"`);
      const monthClasses = filterByDateRange(row.classes, from, to);
      const { invoice } = generateInvoice(row.studioName, monthClasses, studioConfig, period);
      await generateAndOpenPdf(invoice, config);
    } catch (e) {
      setRowError(String(e));
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Output folder */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600">Output folder:</span>
        <span className="text-sm font-mono text-gray-800 flex-1 truncate">
          {config.outputDir || <span className="text-gray-400 italic">not set</span>}
        </span>
        <button
          onClick={chooseOutputFolder}
          className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          Change folder…
        </button>
      </div>

      {rowError && <p className="text-sm text-red-500">{rowError}</p>}

      {/* Invoice table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
            <th className="py-2 pr-4 font-medium">Studio</th>
            <th className="py-2 pr-4 font-medium">Month</th>
            <th className="py-2 pr-4 font-medium text-right">Classes</th>
            <th className="py-2 pr-4 font-medium text-right">Total (€)</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-gray-400">
                No classes loaded
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const rowKey = `${row.studioName}__${row.monthKey}`;
            const studioConfig = config.studios[row.studioName];
            // Compute real total from invoice generator
            let total = 0;
            if (studioConfig) {
              try {
                const [year, month] = row.monthKey.split('-');
                const from = `${year}-${month}-01`;
                const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
                const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
                const { invoice } = generateInvoice(row.studioName, row.classes, studioConfig, {
                  from,
                  to,
                });
                total = invoice.totalAmount;
              } catch {
                /* no matching tier */
              }
            }
            return (
              <tr key={rowKey} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-4">{row.studioName}</td>
                <td className="py-2 pr-4">{row.label}</td>
                <td className="py-2 pr-4 text-right">{row.classCount}</td>
                <td className="py-2 pr-4 text-right font-mono">
                  {studioConfig ? `€${total}` : <span className="text-gray-400">—</span>}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => handleGenerate(row)}
                    disabled={!studioConfig || generating === rowKey}
                    className="text-xs px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                  >
                    {generating === rowKey ? 'Generating…' : 'Generate Invoice…'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 2: Verify in the running app**

```bash
npm run dev
```

Expected: Invoices tab shows a table. "Change folder…" button opens a native folder picker. "Generate Invoice…" creates a PDF and opens it.

**Step 3: Commit**

```bash
git add src/components/InvoicesTab/index.tsx
git commit -m "feat: implement InvoicesTab with PDF generation and output folder picker"
```

---

## Task 10: RatesTab — config editor

**Files:**

- Modify: `src/components/RatesTab/index.tsx`

**Step 1: Implement `src/components/RatesTab/index.tsx`**

```tsx
import { AppConfig, RateTier, StudioConfig } from '../../lib/types';

interface Props {
  config: AppConfig;
  isDirty: boolean;
  onUpdate: (c: AppConfig) => void;
  onSave: () => Promise<void>;
}

export function RatesTab({ config, isDirty, onUpdate, onSave }: Props) {
  function updateGlobal(key: 'teacherName' | 'calendarUrl', value: string) {
    onUpdate({ ...config, [key]: value });
  }

  function updateStudioName(oldName: string, newName: string) {
    const studios = Object.fromEntries(
      Object.entries(config.studios).map(([k, v]) => [k === oldName ? newName : k, v])
    );
    onUpdate({ ...config, studios });
  }

  function updateTier(studioName: string, index: number, field: keyof RateTier, raw: string) {
    const tiers = [...config.studios[studioName].rateTiers];
    tiers[index] = {
      ...tiers[index],
      [field]: field === 'maxStudents' ? (raw === '' ? null : Number(raw)) : Number(raw),
    };
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { rateTiers: tiers } } });
  }

  function addTier(studioName: string) {
    const tiers = [
      ...config.studios[studioName].rateTiers,
      { minStudents: 1, maxStudents: null, rate: 0 },
    ];
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { rateTiers: tiers } } });
  }

  function removeTier(studioName: string, index: number) {
    const tiers = config.studios[studioName].rateTiers.filter((_, i) => i !== index);
    onUpdate({ ...config, studios: { ...config.studios, [studioName]: { rateTiers: tiers } } });
  }

  function addStudio() {
    const name = `New Studio ${Object.keys(config.studios).length + 1}`;
    onUpdate({
      ...config,
      studios: {
        ...config.studios,
        [name]: { rateTiers: [{ minStudents: 1, maxStudents: null, rate: 0 }] },
      },
    });
  }

  function deleteStudio(name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    const { [name]: _, ...rest } = config.studios;
    onUpdate({ ...config, studios: rest });
  }

  return (
    <div className="p-4 flex flex-col gap-6 max-w-2xl">
      {/* Save bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Rates &amp; Config</h2>
        <div className="flex items-center gap-3">
          {isDirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
          <button
            onClick={onSave}
            disabled={!isDirty}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>

      {/* Global settings */}
      <div className="flex flex-col gap-3 p-4 rounded border border-gray-200">
        <h3 className="text-sm font-medium text-gray-700">Global</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Teacher name</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm"
            value={config.teacherName}
            onChange={(e) => updateGlobal('teacherName', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Calendar URL (ICS)</span>
          <input
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
            value={config.calendarUrl}
            onChange={(e) => updateGlobal('calendarUrl', e.target.value)}
          />
        </label>
      </div>

      {/* Studio cards */}
      {Object.entries(config.studios).map(([studioName, studio]) => (
        <div key={studioName} className="p-4 rounded border border-gray-200 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-medium"
              value={studioName}
              onChange={(e) => updateStudioName(studioName, e.target.value)}
            />
            <button
              onClick={() => deleteStudio(studioName)}
              className="text-xs text-red-400 hover:text-red-600"
            >
              Delete
            </button>
          </div>

          {/* Rate tiers table */}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pb-1 font-normal">Min students</th>
                <th className="pb-1 font-normal">Max students</th>
                <th className="pb-1 font-normal">Rate (€)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {studio.rateTiers.map((tier, i) => (
                <tr key={i}>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      min={1}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.minStudents}
                      onChange={(e) => updateTier(studioName, i, 'minStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      placeholder="∞"
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.maxStudents ?? ''}
                      onChange={(e) => updateTier(studioName, i, 'maxStudents', e.target.value)}
                    />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input
                      type="number"
                      min={0}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5"
                      value={tier.rate}
                      onChange={(e) => updateTier(studioName, i, 'rate', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => removeTier(studioName, i)}
                      className="text-gray-300 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => addTier(studioName)}
            className="text-xs text-indigo-500 hover:text-indigo-700 self-start"
          >
            + Add tier
          </button>
        </div>
      ))}

      <button
        onClick={addStudio}
        className="self-start px-4 py-1.5 rounded border border-dashed border-gray-300 text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
      >
        + Add studio
      </button>
    </div>
  );
}
```

**Step 2: Verify in the running app**

```bash
npm run dev
```

Expected: Rates tab shows global settings and per-studio cards with editable tier tables. Save button is disabled until a change is made. "Unsaved changes" badge appears on edits. Save writes to `config.yaml`.

**Step 3: Commit**

```bash
git add src/components/RatesTab/index.tsx
git commit -m "feat: implement RatesTab config editor"
```

---

## Task 11: Update CLAUDE.md and final cleanup

**Files:**

- Modify: `CLAUDE.md`

**Step 1: Update CLAUDE.md**

Replace the Commands section to reflect the new scripts:

```markdown
## Commands

\`\`\`bash

# Run the Tauri desktop app (dev mode)

npm run dev

# Run just the Vite frontend (no Tauri window, for fast UI iteration)

npm run dev:vite

# Run the CLI (original Node.js tool)

npm run cli -- --from 2026-02-01 --to 2026-02-28 --dry-run

# Build the desktop app

npm run build

# Run all tests

npm test

# Run a single test file

npx vitest run tests/invoice/calculator.test.ts
\`\`\`
```

**Step 2: Run the full test suite one final time**

```bash
npm test
```

Expected: all 31 tests pass.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Tauri app workflow"
```
