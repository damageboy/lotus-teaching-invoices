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
