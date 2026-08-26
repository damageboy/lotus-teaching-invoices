import { join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Options } from '@wdio/types';
import {
  loadIsolatedE2eRunFromEnvironment,
  observeChildProcess,
  observedChildProcessError,
  stopChildProcess,
  waitForChildOutputMarker,
  waitForOwnedListeningPort,
  webdriverAppEnvironment,
  withAvailableE2ePorts,
} from './tests/e2e/helpers.js';
import {
  startFakeGoogleCalendar,
  type FakeGoogleCalendar,
} from './tests/e2e/fake-google-calendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureCalendar = join(__dirname, 'tests', 'fixtures', 'e2e-google-calendar.json');

let vitePreview: ChildProcess | undefined;
let app: ChildProcess | undefined;
let fakeGoogle: FakeGoogleCalendar | undefined;
let cleanupPromise: Promise<void> | undefined;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function throwIfChildProcessErrored(child: ChildProcess, label: string): void {
  const error = observedChildProcessError(child);
  if (error) throw new Error(`${label} failed to start`, { cause: error });
}

async function waitForHttp(
  url: string,
  processToWatch: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfChildProcessErrored(processToWatch, 'Vite preview');
    if (processToWatch.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready (${processToWatch.exitCode})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Expected until the server starts accepting requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throwIfChildProcessErrored(processToWatch, 'Vite preview');
  throw new Error(`Timed out waiting for ${url}`);
}

function forwardChildOutput(child: ChildProcess): void {
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

async function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    signalHandlers.clear();
    const errors: unknown[] = [];
    for (const close of [
      () => stopChildProcess(app),
      () => stopChildProcess(vitePreview),
      () => fakeGoogle?.close() ?? Promise.resolve(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'E2E cleanup failed');
  })();
  await cleanupPromise;
}

function installSignalCleanup(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      void cleanup().then(
        () => process.exit(signal === 'SIGINT' ? 130 : 143),
        (error) => {
          console.error('WDIO signal cleanup failed', error);
          process.exit(signal === 'SIGINT' ? 130 : 143);
        }
      );
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

export const config: Options.Testrunner = {
  runner: 'local',
  specs: [
    './tests/e2e/smoke.e2e.ts',
    './tests/e2e/calendar-editing.e2e.ts',
    './tests/e2e/drive-invoices.e2e.ts',
  ],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: [{ browserName: 'wry' }],
  logLevel: 'warn',
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
    const run = loadIsolatedE2eRunFromEnvironment();
    if (process.env.LOTUS_E2E_PARENT_OWNS_ROOT !== '1') {
      throw new Error('WDIO must run under the locked isolated E2E lifecycle');
    }
    try {
      installSignalCleanup();
      await withAvailableE2ePorts(async () => {
        const fake = await startFakeGoogleCalendar(fixtureCalendar);
        fakeGoogle = fake;
        process.env.LOTUS_E2E_FAKE_CONTROL_URL = fake.controlUrl;

        vitePreview = observeChildProcess(
          spawn(
            'bunx',
            [
              'vite',
              'preview',
              '--outDir',
              run.distDir,
              '--host',
              '127.0.0.1',
              '--port',
              '1420',
              '--strictPort',
            ],
            {
              cwd: __dirname,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, NO_COLOR: '1' },
            }
          )
        );
        forwardChildOutput(vitePreview);
        await waitForChildOutputMarker(
          vitePreview,
          /Local:\s+http:\/\/127\.0\.0\.1:1420\//,
          'Vite preview',
          15_000
        );
        await waitForHttp('http://127.0.0.1:1420/', vitePreview, 15_000);

        app = observeChildProcess(
          spawn(
            run.binaryPath,
            [
              '--config',
              run.configPath,
              '--e2e-data-dir',
              run.dataDir,
              '--e2e-run-marker-token',
              run.markerToken,
            ],
            {
              cwd: __dirname,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: webdriverAppEnvironment(process.env, run.root, fake.calendarBaseUrl),
            }
          )
        );
        forwardChildOutput(app);
        await waitForChildOutputMarker(
          app,
          /LOTUS_E2E_WEBDRIVER_READY http:\/\/127\.0\.0\.1:4445/,
          'Tauri application',
          30_000
        );
        await waitForOwnedListeningPort('127.0.0.1', 4445, app, 'Tauri application', 30_000);
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  },

  onComplete: async () => {
    await cleanup();
  },
};
