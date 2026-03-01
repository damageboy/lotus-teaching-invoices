import { join, dirname } from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Options } from '@wdio/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tauriDriver: ChildProcess;

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  // @ts-expect-error tauri:options is not in the definitive generic capability interface
  capabilities: [
    {
      browserName: 'wry',
      'tauri:options': {
        application: join(__dirname, 'src-tauri', 'target', 'release', 'app'),
      },
    },
  ],
  logLevel: 'info',
  bail: 0,
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',
  baseUrl: 'http://localhost',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  onPrepare: () => {
    // Start the tauri-webdriver bridge
    // It automatically binds to localhost:4444 and proxies to the app's internal 4445
    tauriDriver = spawn('tauri-webdriver', [], { stdio: [null, process.stdout, process.stderr] });
  },

  onComplete: () => {
    if (tauriDriver) {
      tauriDriver.kill();
    }
  },
};
