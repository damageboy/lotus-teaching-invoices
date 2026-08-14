import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  acquireLifecycleLock,
  type E2eLifecycleLock,
  type ProcessGroupIdentity,
} from './lifecycle-lock.js';
import {
  spawnGatedProcessGroupForRegistration,
  type GatedProcessGroupOptions,
} from './lifecycle-supervisor.js';

export type { E2eLifecycleLock } from './lifecycle-lock.js';

const RUN_PREFIX = 'lotus-calendar-e2e-';
const RUN_MARKER = '.lotus-e2e-run';
const DEFAULT_LIFECYCLE_LOCK = join(realpathSync(tmpdir()), 'lotus-calendar-e2e.lifecycle.lock');
const observedChildErrors = new WeakMap<ChildProcess, Error>();

export interface IsolatedE2eRun {
  readonly root: string;
  readonly dataDir: string;
  readonly configPath: string;
  readonly markerToken: string;
  readonly productionTargetDir: string;
  readonly webdriverTargetDir: string;
  readonly productionDistDir: string;
  readonly webdriverBuildDistDir: string;
  readonly binaryPath: string;
  readonly distDir: string;
}

const ISOLATED_RUN_PATH_FIELDS: ReadonlyArray<Exclude<keyof IsolatedE2eRun, 'markerToken'>> = [
  'root',
  'dataDir',
  'configPath',
  'productionTargetDir',
  'webdriverTargetDir',
  'productionDistDir',
  'webdriverBuildDistDir',
  'binaryPath',
  'distDir',
];

interface TrackedChild {
  readonly child: ChildProcess;
  readonly processGroup: boolean;
  groupIdentity?: ProcessGroupIdentity;
}

export interface IsolatedE2eLifecycle {
  readonly run: IsolatedE2eRun;
  trackChild<T extends ChildProcess>(child: T): T;
  startProcessGroup(
    command: string,
    args: readonly string[],
    options?: GatedProcessGroupOptions
  ): Promise<ChildProcess>;
  untrackChild(child: ChildProcess): Promise<void>;
}

export async function acquireE2eLifecycleLock(
  lockPath: string = DEFAULT_LIFECYCLE_LOCK
): Promise<E2eLifecycleLock> {
  return acquireLifecycleLock(lockPath, ({ root, markerToken }) => {
    recoverIsolatedE2eRun(isolatedRunDescriptor(root, markerToken));
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      probe.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already occupied`));
      else reject(error);
    };
    const onListening = () => {
      probe.off('error', onError);
      probe.close((error) => (error ? reject(error) : resolve()));
    };
    probe.once('error', onError);
    probe.once('listening', onListening);
    probe.listen(port, '127.0.0.1');
  });
}

export async function withAvailableE2ePorts<T>(work: () => Promise<T>): Promise<T> {
  await assertPortAvailable(1420);
  await assertPortAvailable(4445);
  return work();
}

export async function withIsolatedE2eLifecycle<T>(
  work: (lifecycle: IsolatedE2eLifecycle) => Promise<T>,
  lockPath: string = DEFAULT_LIFECYCLE_LOCK
): Promise<T> {
  const lock = await acquireE2eLifecycleLock(lockPath);
  const trackedChildren: TrackedChild[] = [];
  let run: IsolatedE2eRun | undefined;
  let terminating = false;
  let cleanupPromise: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const cleanup = async (): Promise<void> => {
    cleanupPromise ??= (async () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
      const errors: unknown[] = [];
      for (const tracked of [...trackedChildren].reverse()) {
        try {
          await stopChildProcess(
            tracked.child,
            tracked.processGroup && tracked.groupIdentity !== undefined
          );
          if (tracked.groupIdentity) await lock.unregisterProcessGroup(tracked.groupIdentity);
          const index = trackedChildren.indexOf(tracked);
          if (index >= 0) trackedChildren.splice(index, 1);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 0 && run && existsSync(run.root)) {
        try {
          removeIsolatedE2eRun(run);
          lock.clearRun(run);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await lock.release(errors.length > 0);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'E2E lifecycle cleanup failed');
    })();
    await cleanupPromise;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      terminating = true;
      void cleanup().then(
        () => process.exit(signal === 'SIGINT' ? 130 : 143),
        (error) => {
          console.error('E2E signal cleanup failed', error);
          process.exit(signal === 'SIGINT' ? 130 : 143);
        }
      );
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    return await withAvailableE2ePorts(async () => {
      if (terminating) throw new Error('E2E lifecycle interrupted before root creation');
      run = createIsolatedE2eRun();
      lock.registerRun(run);
      const lifecycle: IsolatedE2eLifecycle = Object.freeze({
        run,
        trackChild: <TChild extends ChildProcess>(child: TChild): TChild => {
          if (terminating) throw new Error('E2E lifecycle interrupted before child registration');
          trackedChildren.push({ child, processGroup: false });
          return child;
        },
        startProcessGroup: async (
          command: string,
          args: readonly string[],
          options: GatedProcessGroupOptions = {}
        ): Promise<ChildProcess> => {
          if (terminating) throw new Error('E2E lifecycle interrupted before child registration');
          const gated = spawnGatedProcessGroupForRegistration(command, args, options);
          const child = observeChildProcess(gated.child);
          const tracked: TrackedChild = { child, processGroup: true };
          trackedChildren.push(tracked);
          try {
            await gated.waitUntilReady();
            if (terminating) {
              throw new Error('E2E lifecycle interrupted before process group registration');
            }
            if (child.pid === undefined) {
              throw new Error('Cannot register an E2E child process group without a PID');
            }
            tracked.groupIdentity = lock.registerProcessGroup(child.pid);
            options.testHooks?.onProcessGroupRegistered?.(child);
            await gated.activate();
            return child;
          } catch (startupError) {
            const cleanupErrors: unknown[] = [];
            try {
              await gated.abort();
            } catch (error) {
              cleanupErrors.push(error);
            }
            if (tracked.groupIdentity) {
              try {
                await lock.unregisterProcessGroup(tracked.groupIdentity);
                tracked.groupIdentity = undefined;
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            if (cleanupErrors.length === 0) {
              const index = trackedChildren.indexOf(tracked);
              if (index >= 0) trackedChildren.splice(index, 1);
              throw startupError;
            }
            throw new AggregateError(
              [startupError, ...cleanupErrors],
              'E2E process group startup cleanup failed'
            );
          }
        },
        untrackChild: async (child: ChildProcess) => {
          const index = trackedChildren.findIndex((tracked) => tracked.child === child);
          if (index < 0) return;
          const tracked = trackedChildren[index]!;
          if (tracked.groupIdentity) await lock.unregisterProcessGroup(tracked.groupIdentity);
          trackedChildren.splice(index, 1);
        },
      });
      return work(lifecycle);
    });
  } finally {
    await cleanup();
  }
}

export function observeChildProcess<T extends ChildProcess>(child: T): T {
  child.on('error', (error) => {
    if (!observedChildErrors.has(child)) observedChildErrors.set(child, error);
  });
  return child;
}

export function observedChildProcessError(child: ChildProcess): Error | undefined {
  return observedChildErrors.get(child);
}

export async function waitForChildOutputMarker(
  child: ChildProcess,
  marker: RegExp,
  label: string,
  timeoutMs: number
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error(`${label} must expose stdout for readiness`);
  const existingError = observedChildProcessError(child);
  if (existingError) throw new Error(`${label} failed to start`, { cause: existingError });
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited before its readiness marker`);
  }
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${label} readiness marker`)),
      timeoutMs
    );
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
      marker.lastIndex = 0;
      if (marker.test(output)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish(new Error(`${label} exited before its readiness marker`));
        } else {
          finish();
        }
      }
    };
    const onExit = () => finish(new Error(`${label} exited before its readiness marker`));
    const onError = (error: Error) =>
      finish(new Error(`${label} failed to start`, { cause: error }));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

interface ListeningSocketOwner {
  readonly pid: number;
  readonly descriptor: string;
  readonly name: string;
}

function listeningSocketOwners(host: string, port: number): ListeningSocketOwner[] | undefined {
  const result = spawnSync(
    '/usr/sbin/lsof',
    ['-nP', '-a', `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-F0pfn'],
    { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, maxBuffer: 64 * 1024 }
  );
  if (
    result.error ||
    result.signal ||
    (result.status !== 0 && result.status !== 1) ||
    result.stderr !== ''
  ) {
    return undefined;
  }
  if (result.status === 1 && result.stdout === '') return [];
  if (result.status !== 0) return undefined;

  const owners: ListeningSocketOwner[] = [];
  let pid: number | undefined;
  let descriptor: string | undefined;
  for (const field of result.stdout.split(/[\0\n]+/).filter(Boolean)) {
    const value = field.slice(1);
    if (field.startsWith('p')) {
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 2) return undefined;
      pid = parsed;
      descriptor = undefined;
    } else if (field.startsWith('f')) {
      if (pid === undefined || value === '') return undefined;
      descriptor = value;
    } else if (field.startsWith('n')) {
      if (pid === undefined || descriptor === undefined || value !== `${host}:${port}`) {
        return undefined;
      }
      owners.push({ pid, descriptor, name: value });
      descriptor = undefined;
    } else {
      return undefined;
    }
  }
  return owners;
}

async function connectToOwnedPort(host: string, port: number): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (!connected) socket.destroy();
      resolve(connected ? socket : undefined);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    socket.setTimeout(500, onError);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

interface OwnedListeningPortTestHooks {
  readonly afterInitialOwnershipSample?: () => void | Promise<void>;
}

export async function waitForOwnedListeningPort(
  host: string,
  port: number,
  child: ChildProcess,
  label: string,
  timeoutMs: number,
  testHooks: OwnedListeningPortTestHooks = {}
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`${label} owned listening socket verification requires macOS`);
  }
  if (child.pid === undefined) throw new Error(`${label} has no PID for socket ownership`);
  const expectedPid = child.pid;
  const deadline = performance.now() + timeoutMs;
  let afterInitialOwnershipSample = testHooks.afterInitialOwnershipSample;
  while (performance.now() < deadline) {
    const childError = observedChildProcessError(child);
    if (childError)
      throw new Error(`${label} failed before socket ownership`, { cause: childError });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before owning its listening socket`);
    }
    const ownersBeforeConnect = listeningSocketOwners(host, port);
    if (ownersBeforeConnect?.length === 1 && ownersBeforeConnect[0]!.pid === expectedPid) {
      if (afterInitialOwnershipSample) {
        const hook = afterInitialOwnershipSample;
        afterInitialOwnershipSample = undefined;
        await hook();
      }
      const probeSocket = await connectToOwnedPort(host, port);
      if (probeSocket) {
        try {
          const ownersAfterConnect = listeningSocketOwners(host, port);
          if (
            ownersAfterConnect?.length === 1 &&
            ownersAfterConnect[0]!.pid === expectedPid &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            return;
          }
        } finally {
          probeSocket.destroy();
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not acquire one owned listening socket on ${host}:${port}`);
}

export async function stopChildProcess(
  child: ChildProcess | undefined,
  processGroup = false
): Promise<void> {
  if (!child || (child.pid === undefined && observedChildProcessError(child))) return;
  const signal = (value: NodeJS.Signals) => {
    if (processGroup && child.pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } else {
      child.kill(value);
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const waitForExit = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(exited);
      };
      child.once('exit', onExit);
    });
  const gracefulExit = waitForExit(3_000);
  signal('SIGTERM');
  const graceful = await gracefulExit;
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    const forcedExit = waitForExit(1_000);
    signal('SIGKILL');
    await forcedExit;
  }
}

function isolatedRunDescriptor(root: string, markerToken: string): IsolatedE2eRun {
  return Object.freeze({
    root,
    dataDir: join(root, 'app-data'),
    configPath: join(root, 'config.yaml'),
    markerToken,
    productionTargetDir: join(root, 'build', 'production-target'),
    webdriverTargetDir: join(root, 'build', 'webdriver-target'),
    productionDistDir: join(root, 'build', 'production-dist'),
    webdriverBuildDistDir: join(root, 'build', 'webdriver-dist'),
    binaryPath: join(root, 'runtime', 'app'),
    distDir: join(root, 'runtime', 'dist'),
  });
}

function validateIsolatedRunRootPath(root: string): void {
  const tempRoot = realpathSync(tmpdir());
  const suffix = basename(root).startsWith(RUN_PREFIX)
    ? basename(root).slice(RUN_PREFIX.length)
    : '';
  if (!isAbsolute(root) || dirname(root) !== tempRoot || suffix.length === 0) {
    throw new Error('Invalid isolated E2E run root');
  }
}

function validateIsolatedRunRoot(root: string): void {
  validateIsolatedRunRootPath(root);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('Invalid isolated E2E run root');
  }
}

function validateMarkerToken(markerToken: string): void {
  if (!/^[0-9a-f]{64}$/.test(markerToken)) {
    throw new Error('Invalid isolated E2E run marker token');
  }
}

function validateRunMarker(root: string, markerToken: string): void {
  validateMarkerToken(markerToken);
  const markerPath = join(root, RUN_MARKER);
  const metadata = lstatSync(markerPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) ||
    readFileSync(markerPath, 'utf8') !== markerToken
  ) {
    throw new Error('Isolated E2E run marker does not match');
  }
}

export function createIsolatedE2eRun(): IsolatedE2eRun {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), RUN_PREFIX)));
  const markerToken = randomBytes(32).toString('hex');
  const run = isolatedRunDescriptor(root, markerToken);
  mkdirSync(run.dataDir, { mode: 0o700 });
  writeFileSync(join(root, RUN_MARKER), markerToken, { mode: 0o600, flag: 'wx' });
  return run;
}

export function loadIsolatedE2eRunFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): IsolatedE2eRun {
  const root = environment.LOTUS_E2E_RUN_ROOT;
  const configPath = environment.LOTUS_E2E_CONFIG_PATH;
  const markerToken = environment.LOTUS_E2E_RUN_MARKER_TOKEN;
  if (!root || !configPath || !markerToken) {
    throw new Error('WDIO requires the isolated run root, config path, and marker token');
  }
  validateIsolatedRunRoot(root);
  validateRunMarker(root, markerToken);
  const run = isolatedRunDescriptor(root, markerToken);
  const dataMetadata = lstatSync(run.dataDir);
  if (
    !dataMetadata.isDirectory() ||
    dataMetadata.isSymbolicLink() ||
    realpathSync(run.dataDir) !== run.dataDir
  ) {
    throw new Error('WDIO isolated data directory is invalid');
  }
  const configMetadata = lstatSync(configPath);
  if (
    configPath !== run.configPath ||
    !configMetadata.isFile() ||
    configMetadata.isSymbolicLink() ||
    realpathSync(configPath) !== configPath
  ) {
    throw new Error('WDIO isolated config path is invalid');
  }
  const binaryMetadata = lstatSync(run.binaryPath);
  const distMetadata = lstatSync(run.distDir);
  if (
    !binaryMetadata.isFile() ||
    binaryMetadata.isSymbolicLink() ||
    realpathSync(run.binaryPath) !== run.binaryPath ||
    !distMetadata.isDirectory() ||
    distMetadata.isSymbolicLink() ||
    realpathSync(run.distDir) !== run.distDir ||
    (process.platform !== 'win32' && (binaryMetadata.mode & 0o777) !== 0o555)
  ) {
    throw new Error('WDIO runtime artifacts are invalid');
  }
  visitRealTree(run.distDir, (path, isDirectory) => {
    if (process.platform !== 'win32') {
      const mode = lstatSync(path).mode & 0o777;
      if ((mode & 0o222) !== 0) {
        throw new Error(`WDIO runtime artifact is mutable: ${isDirectory ? 'directory' : 'file'}`);
      }
    }
  });
  return run;
}

function visitRealTree(path: string, visit: (path: string, isDirectory: boolean) => void): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`E2E runtime artifacts may not contain symlinks: ${path}`);
  }
  if (!metadata.isDirectory()) {
    if (!metadata.isFile()) throw new Error(`Unexpected E2E runtime artifact type: ${path}`);
    visit(path, false);
    return;
  }
  for (const entry of readdirSync(path)) visitRealTree(join(path, entry), visit);
  visit(path, true);
}

export function installRuntimeArtifacts(
  run: IsolatedE2eRun,
  sourceBinary: string,
  sourceDist: string
): void {
  const expectedBinary = join(run.webdriverTargetDir, 'debug', 'app');
  if (sourceBinary !== expectedBinary || sourceDist !== run.webdriverBuildDistDir) {
    throw new Error("Runtime artifacts must come from this run's webdriver build paths");
  }
  const binaryMetadata = lstatSync(sourceBinary);
  const distMetadata = lstatSync(sourceDist);
  if (
    !binaryMetadata.isFile() ||
    binaryMetadata.isSymbolicLink() ||
    realpathSync(sourceBinary) !== sourceBinary ||
    !distMetadata.isDirectory() ||
    distMetadata.isSymbolicLink() ||
    realpathSync(sourceDist) !== sourceDist
  ) {
    throw new Error('Runtime artifacts must be a real binary and frontend directory');
  }
  visitRealTree(sourceDist, () => {});
  mkdirSync(dirname(run.binaryPath), { recursive: true, mode: 0o700 });
  copyFileSync(sourceBinary, run.binaryPath, constants.COPYFILE_EXCL);
  cpSync(sourceDist, run.distDir, { recursive: true, errorOnExist: true, force: false });
  chmodSync(run.binaryPath, 0o555);
  visitRealTree(run.distDir, (path, isDirectory) => chmodSync(path, isDirectory ? 0o555 : 0o444));
}

const FRONTEND_E2E_SEAMS = [
  '__LOTUS_E2E__',
  'e2e_seed_runtime',
  'e2e_runtime_status',
  'e2e_arm_failpoint',
] as const;

const RUST_E2E_SEAMS = [
  '--e2e-data-dir',
  '--e2e-run-marker-token',
  'LOTUS_E2E_RUN_ROOT',
  'LOTUS_E2E_CALENDAR_API_BASE',
  'LOTUS_E2E_SUPPRESS_OPEN_FILE',
  'e2e_seed_runtime',
  'e2e_runtime_status',
  'e2e_arm_failpoint',
  'freshnessAfterRemote',
  'cacheReconcileAfterRemote',
  'LOTUS_E2E_WEBDRIVER_READY',
] as const;

function bufferContainsAny(buffer: Buffer, needles: readonly string[]): boolean {
  return needles.some((needle) => buffer.includes(Buffer.from(needle)));
}

export function assertProductionArtifactsExcludeE2eSeams(run: IsolatedE2eRun): void {
  const productionBinary = join(run.productionTargetDir, 'debug', 'app');
  const binaryMetadata = lstatSync(productionBinary);
  if (!binaryMetadata.isFile() || binaryMetadata.isSymbolicLink()) {
    throw new Error('Production proof requires a real production binary');
  }
  visitRealTree(run.productionDistDir, (path, isDirectory) => {
    if (!isDirectory && bufferContainsAny(readFileSync(path), FRONTEND_E2E_SEAMS)) {
      throw new Error('production frontend contains webdriver-only seam');
    }
  });
  if (bufferContainsAny(readFileSync(productionBinary), RUST_E2E_SEAMS)) {
    throw new Error('production binary contains webdriver-only seam');
  }
}

export interface RemoveIsolatedE2eRunOptions {
  readonly onEntryRemoved?: (path: string) => void;
  readonly onCleanupPhase?: (phase: IsolatedE2eCleanupPhase) => void;
}

export type IsolatedE2eCleanupPhase =
  | 'authority-created'
  | 'authority-durable'
  | 'marker-unlinked'
  | 'root-removed'
  | 'authority-removed';

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateRunDescriptor(run: IsolatedE2eRun): void {
  validateIsolatedRunRootPath(run.root);
  validateMarkerToken(run.markerToken);
  const expected = isolatedRunDescriptor(run.root, run.markerToken);
  if (ISOLATED_RUN_PATH_FIELDS.some((field) => run[field] !== expected[field])) {
    throw new Error('Refusing to remove an unvalidated E2E run root');
  }
}

function cleanupAuthorityPath(run: IsolatedE2eRun): string {
  validateIsolatedRunRootPath(run.root);
  validateMarkerToken(run.markerToken);
  return `${run.root}.cleanup-${run.markerToken}`;
}

function validateCleanupAuthority(run: IsolatedE2eRun): void {
  const authorityPath = cleanupAuthorityPath(run);
  const metadata = lstatSync(authorityPath);
  validateCleanupAuthorityMetadata(metadata);
  if (realpathSync(authorityPath) !== authorityPath) {
    throw new Error('Invalid isolated E2E cleanup authority');
  }
}

function validateCleanupAuthorityMetadata(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== 0 ||
    metadata.nlink !== 1 ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)
  ) {
    throw new Error('Invalid isolated E2E cleanup authority');
  }
}

function syncExistingCleanupAuthority(run: IsolatedE2eRun): void {
  const authorityPath = cleanupAuthorityPath(run);
  const pathMetadata = lstatSync(authorityPath);
  validateCleanupAuthorityMetadata(pathMetadata);
  const descriptor = openSync(authorityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorMetadata = fstatSync(descriptor);
    validateCleanupAuthorityMetadata(descriptorMetadata);
    if (
      descriptorMetadata.dev !== pathMetadata.dev ||
      descriptorMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error('Isolated E2E cleanup authority changed during validation');
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  validateCleanupAuthority(run);
  syncDirectory(dirname(authorityPath));
}

function ensureCleanupAuthority(
  run: IsolatedE2eRun,
  onCleanupPhase?: (phase: IsolatedE2eCleanupPhase) => void
): void {
  const authorityPath = cleanupAuthorityPath(run);
  let descriptor: number;
  try {
    descriptor = openSync(
      authorityPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    syncExistingCleanupAuthority(run);
    return;
  }
  try {
    validateCleanupAuthorityMetadata(fstatSync(descriptor));
    onCleanupPhase?.('authority-created');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(dirname(authorityPath));
  validateCleanupAuthority(run);
}

function validateRunRemovalAuthority(run: IsolatedE2eRun): void {
  validateIsolatedRunRoot(run.root);
  const markerPath = join(run.root, RUN_MARKER);
  if (pathExists(markerPath)) validateRunMarker(run.root, run.markerToken);
  else validateCleanupAuthority(run);
}

function removeRunEntry(
  run: IsolatedE2eRun,
  path: string,
  options: RemoveIsolatedE2eRunOptions
): void {
  validateRunRemovalAuthority(run);
  const metadata = lstatSync(path);
  validateRunRemovalAuthority(run);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    chmodSync(path, 0o700);
    validateRunRemovalAuthority(run);
    const entries = readdirSync(path).sort();
    validateRunRemovalAuthority(run);
    for (const entry of entries) removeRunEntry(run, join(path, entry), options);
    validateRunRemovalAuthority(run);
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
  validateRunRemovalAuthority(run);
  options.onEntryRemoved?.(path);
  validateRunRemovalAuthority(run);
}

export function removeIsolatedE2eRun(
  run: IsolatedE2eRun,
  options: RemoveIsolatedE2eRunOptions = {}
): void {
  validateRunDescriptor(run);
  validateRunRemovalAuthority(run);
  const entries = readdirSync(run.root).sort();
  validateRunRemovalAuthority(run);
  for (const entry of entries) {
    if (entry !== RUN_MARKER) removeRunEntry(run, join(run.root, entry), options);
  }
  validateRunRemovalAuthority(run);
  ensureCleanupAuthority(run, options.onCleanupPhase);
  options.onCleanupPhase?.('authority-durable');
  validateRunRemovalAuthority(run);
  const markerPath = join(run.root, RUN_MARKER);
  if (pathExists(markerPath)) {
    validateRunMarker(run.root, run.markerToken);
    unlinkSync(markerPath);
    syncDirectory(run.root);
  }
  validateRunRemovalAuthority(run);
  options.onCleanupPhase?.('marker-unlinked');
  validateRunRemovalAuthority(run);
  rmdirSync(run.root);
  syncDirectory(dirname(run.root));
  options.onCleanupPhase?.('root-removed');
  validateCleanupAuthority(run);
  unlinkSync(cleanupAuthorityPath(run));
  syncDirectory(dirname(run.root));
  options.onCleanupPhase?.('authority-removed');
}

function recoverIsolatedE2eRun(run: IsolatedE2eRun): void {
  validateRunDescriptor(run);
  const authorityPath = cleanupAuthorityPath(run);
  if (pathExists(run.root)) {
    removeIsolatedE2eRun(run);
    return;
  }
  if (!pathExists(authorityPath)) return;
  validateCleanupAuthority(run);
  unlinkSync(authorityPath);
  syncDirectory(dirname(authorityPath));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set by the isolated WDIO lifecycle`);
  return value;
}

export function e2eRunRoot(): string {
  return requiredEnvironment('LOTUS_E2E_RUN_ROOT');
}

export function e2eConfigPath(): string {
  return requiredEnvironment('LOTUS_E2E_CONFIG_PATH');
}

export function fakeGoogleControlUrl(): string {
  return requiredEnvironment('LOTUS_E2E_FAKE_CONTROL_URL');
}

export function readTmpConfig(): Record<string, unknown> {
  return parse(readFileSync(e2eConfigPath(), 'utf-8'));
}

export function editingConfigYaml(): string {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'e2e-config.yaml'
  );
  const config = parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  config.calendarId = 'teaching@example.test';
  config.calendarName = 'Teaching Calendar';
  config.calendarAccessRole = 'owner';
  return stringify(config);
}
