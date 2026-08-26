import { spawn } from 'node:child_process';
import {
  constants,
  copyFileSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProductionArtifactsExcludeE2eSeams,
  installRuntimeArtifacts,
  observeChildProcess,
  stopChildProcess,
  withIsolatedE2eLifecycle,
  type IsolatedE2eLifecycle,
  type IsolatedE2eRun,
} from './helpers.js';

const REPOSITORY_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const TAURI_MANIFEST = join(REPOSITORY_ROOT, 'src-tauri', 'Cargo.toml');
const FIXTURE_CONFIG = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'e2e-config.yaml');
const PERSISTENT_WEBKIT_ROOTS = [
  join(homedir(), 'Library', 'WebKit', 'com.houmus.teaching-invoices'),
  join(homedir(), 'Library', 'WebKit', 'app'),
] as const;

function persistentWebKitStateSnapshot(): string {
  const entries: string[] = [];
  const visit = (path: string): void => {
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.push(`${path}|missing`);
        return;
      }
      throw error;
    }
    entries.push(
      [
        path,
        metadata.mode,
        metadata.uid,
        metadata.gid,
        metadata.size,
        metadata.mtimeNs,
        metadata.ctimeNs,
        metadata.isSymbolicLink() ? readlinkSync(path) : '',
      ].join('|')
    );
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    }
  };
  for (const root of PERSISTENT_WEBKIT_ROOTS) visit(root);
  return entries.sort().join('\n');
}

function environmentWithoutE2eFrontend(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.VITE_LOTUS_E2E;
  delete environment.CARGO_TARGET_DIR;
  delete environment.TAURI_ENV_DEBUG;
  return environment;
}

async function runLifecycleCommand(
  lifecycle: IsolatedE2eLifecycle,
  label: string,
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<void> {
  const processGroup = process.platform !== 'win32';
  const child = processGroup
    ? await lifecycle.startProcessGroup(command, args, {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: 'inherit',
      })
    : lifecycle.trackChild(
        observeChildProcess(
          spawn(command, [...args], {
            cwd: REPOSITORY_ROOT,
            env: environment,
            stdio: 'inherit',
          })
        )
      );
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) =>
        finish(new Error(`${label} failed to start`, { cause: error }));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0) finish();
        else finish(new Error(`${label} exited with ${code ?? signal ?? 'unknown status'}`));
      };
      const timer = setTimeout(() => {
        void stopChildProcess(child, processGroup).finally(() => {
          finish(new Error(`${label} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  } catch (error) {
    await stopChildProcess(child, processGroup);
    throw error;
  } finally {
    await lifecycle.untrackChild(child);
  }
}

async function buildAndAssertProduction(lifecycle: IsolatedE2eLifecycle): Promise<void> {
  const productionEnvironment = environmentWithoutE2eFrontend();
  await runLifecycleCommand(
    lifecycle,
    'production frontend build',
    process.execPath,
    ['x', 'vite', 'build', '--outDir', lifecycle.run.productionDistDir, '--emptyOutDir'],
    productionEnvironment,
    120_000
  );
  await runLifecycleCommand(
    lifecycle,
    'production Rust build',
    'cargo',
    ['build', '--manifest-path', TAURI_MANIFEST],
    { ...productionEnvironment, CARGO_TARGET_DIR: lifecycle.run.productionTargetDir },
    600_000
  );
  assertProductionArtifactsExcludeE2eSeams(lifecycle.run);
}

async function buildWebdriverArtifacts(lifecycle: IsolatedE2eLifecycle): Promise<void> {
  const webdriverEnvironment = {
    ...environmentWithoutE2eFrontend(),
    VITE_LOTUS_E2E: '1',
  };
  await runLifecycleCommand(
    lifecycle,
    'webdriver frontend build',
    process.execPath,
    ['x', 'vite', 'build', '--outDir', lifecycle.run.webdriverBuildDistDir, '--emptyOutDir'],
    webdriverEnvironment,
    120_000
  );
  await runLifecycleCommand(
    lifecycle,
    'webdriver Rust build',
    'cargo',
    ['build', '--manifest-path', TAURI_MANIFEST, '--features', 'webdriver'],
    { ...webdriverEnvironment, CARGO_TARGET_DIR: lifecycle.run.webdriverTargetDir },
    600_000
  );
  installRuntimeArtifacts(
    lifecycle.run,
    join(lifecycle.run.webdriverTargetDir, 'debug', 'app'),
    lifecycle.run.webdriverBuildDistDir
  );
}

function wdioEnvironment(run: IsolatedE2eRun): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // WebDriver's bundled Undici transport rejects localhost session requests under Node 26.
    WDIO_USE_NATIVE_FETCH: '1',
    VITE_LOTUS_E2E: '1',
    LOTUS_E2E_RUN_ROOT: run.root,
    LOTUS_E2E_CONFIG_PATH: run.configPath,
    LOTUS_E2E_RUN_MARKER_TOKEN: run.markerToken,
    LOTUS_E2E_PARENT_OWNS_ROOT: '1',
  };
}

async function runProductionAssertion(): Promise<void> {
  await withIsolatedE2eLifecycle(buildAndAssertProduction);
}

async function runFullE2e(): Promise<void> {
  await withIsolatedE2eLifecycle(async (lifecycle) => {
    await buildAndAssertProduction(lifecycle);
    await buildWebdriverArtifacts(lifecycle);
    copyFileSync(FIXTURE_CONFIG, lifecycle.run.configPath, constants.COPYFILE_EXCL);
    await runLifecycleCommand(
      lifecycle,
      'fake Google Calendar, Drive, and Gmail contract tests',
      process.execPath,
      ['run', 'tests/e2e/fake-google-calendar.ts', '--self-test'],
      process.env,
      30_000
    );
    await runLifecycleCommand(
      lifecycle,
      'E2E lifecycle helper tests',
      process.execPath,
      ['run', 'tests/e2e/lifecycle-selftest.ts', '--self-test'],
      process.env,
      30_000
    );
    const persistentWebKitBefore = persistentWebKitStateSnapshot();
    let webdriverError: unknown;
    try {
      await runLifecycleCommand(
        lifecycle,
        'WebdriverIO suite',
        process.execPath,
        ['x', 'wdio', 'run', 'wdio.conf.ts'],
        wdioEnvironment(lifecycle.run),
        900_000
      );
    } catch (error) {
      webdriverError = error;
    }
    const persistentWebKitChanged = persistentWebKitStateSnapshot() !== persistentWebKitBefore;
    if (webdriverError && persistentWebKitChanged) {
      throw new AggregateError(
        [webdriverError, new Error('E2E changed persistent user WebKit state')],
        'WebdriverIO failed and changed persistent user WebKit state'
      );
    }
    if (webdriverError) throw webdriverError;
    if (persistentWebKitChanged) {
      throw new Error('E2E changed persistent user WebKit state');
    }
  });
}

if (process.argv.includes('--assert-production')) {
  await runProductionAssertion();
  console.log('Production build excludes webdriver-only E2E seams');
} else if (process.argv.includes('--run-isolated-e2e')) {
  await runFullE2e();
}
