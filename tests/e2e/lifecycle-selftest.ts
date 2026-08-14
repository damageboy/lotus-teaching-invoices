import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  acquireE2eLifecycleLock,
  assertProductionArtifactsExcludeE2eSeams,
  createIsolatedE2eRun,
  installRuntimeArtifacts,
  loadIsolatedE2eRunFromEnvironment,
  observeChildProcess,
  observedChildProcessError,
  removeIsolatedE2eRun,
  stopChildProcess,
  waitForChildOutputMarker,
  waitForOwnedListeningPort,
  withIsolatedE2eLifecycle,
  type IsolatedE2eRun,
} from './helpers.js';
import { spawnGatedProcessGroupForRegistration } from './lifecycle-supervisor.js';

const TEMP_ROOT = realpathSync(tmpdir());
const SELF_PATH = fileURLToPath(import.meta.url);
const SUPERVISOR_PATH = fileURLToPath(new URL('./lifecycle-supervisor.ts', import.meta.url));
const VALID_LOCK_IDENTITY = 'a'.repeat(64);
const REUSED_LOCK_IDENTITY = 'f'.repeat(64);

function serializedLockRecord(
  ownerPid: number,
  ownerStartIdentity: string = VALID_LOCK_IDENTITY,
  run: { root: string; markerToken: string } | null = null
): string {
  return JSON.stringify({
    version: 1,
    owner: {
      pid: ownerPid,
      startIdentity: ownerStartIdentity,
      token: 'b'.repeat(64),
    },
    run,
    processGroups: [],
  });
}

async function testInvalidRecordedRunRootIsNeverForgotten(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-invalid-recorded-run-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const danglingRunRoot = temporaryTestDirectory('lotus-calendar-e2e-dangling-');
  rmSync(danglingRunRoot, { recursive: true, force: false });
  symlinkSync(join(TEMP_ROOT, 'lotus-e2e-missing-target'), danglingRunRoot);
  writeFileSync(
    lockPath,
    serializedLockRecord(process.pid, REUSED_LOCK_IDENTITY, {
      root: danglingRunRoot,
      markerToken: 'c'.repeat(64),
    }),
    { mode: 0o600, flag: 'wx' }
  );
  let unexpectedlyAcquired: Awaited<ReturnType<typeof acquireE2eLifecycleLock>> | undefined;
  try {
    const result = await acquireE2eLifecycleLock(lockPath).then(
      (lock) => ({ lock }),
      (error: unknown) => ({ error })
    );
    if ('lock' in result) unexpectedlyAcquired = result.lock;
    assert.equal('error' in result, true, 'an invalid recorded run root must block recovery');
    assert.equal(existsSync(lockPath), true);
    assert.equal(lstatSync(danglingRunRoot).isSymbolicLink(), true);
  } finally {
    if (unexpectedlyAcquired) await unexpectedlyAcquired.release();
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (lstatSync(danglingRunRoot).isSymbolicLink()) rmSync(danglingRunRoot, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

function temporaryTestDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(join(TEMP_ROOT, prefix)));
}

async function childClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return null;
  if (child.pid === undefined && observedChildProcessError(child)) return null;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for child exit pid=${child.pid ?? 'none'} exit=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}`
          )
        ),
      timeoutMs
    );
    const finish = (code: number | null) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      for (const stream of child.stdio) {
        if (stream && 'destroy' in stream) stream.destroy();
      }
      child.unref();
      resolve(code);
    };
    const onExit = (code: number | null) => finish(code);
    const onError = () => finish(null);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function withRun(work: (run: IsolatedE2eRun) => void | Promise<void>): Promise<void> {
  const run = createIsolatedE2eRun();
  try {
    await work(run);
  } finally {
    if (existsSync(run.root)) removeIsolatedE2eRun(run);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForStreamMarker(
  stream: NodeJS.ReadableStream,
  marker: string,
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(marker)) finish();
    };
    const onExit = () => finish(new Error('supervisor exited before its protocol marker'));
    const timer = setTimeout(
      () => finish(new Error('timed out waiting for supervisor protocol marker')),
      timeoutMs
    );
    stream.on('data', onData);
    child.once('exit', onExit);
  });
}

async function testActivationGateRejectsEveryInvalidPreActivationInput(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-activation-gate-test-');
  const token = 'd'.repeat(64);
  const commitToken = 'c'.repeat(64);
  const cases: Array<{ name: string; input?: string }> = [
    { name: 'eof', input: '' },
    { name: 'wrong-token', input: `${'e'.repeat(64)}\n` },
    { name: 'duplicate-token', input: `${token}\n${token}\n` },
    { name: 'timeout' },
  ];
  try {
    for (const testCase of cases) {
      const workloadMarker = join(testRoot, `${testCase.name}-workload-started`);
      const child = observeChildProcess(
        spawn(
          process.execPath,
          [
            SUPERVISOR_PATH,
            '--supervise-process-group',
            token,
            commitToken,
            '150',
            'ignore',
            'none',
            process.execPath,
            JSON.stringify([SELF_PATH, '--mark-workload-started', workloadMarker]),
          ],
          { detached: true, stdio: ['pipe', 'pipe', 'ignore'] }
        )
      );
      try {
        if (child.pid === undefined || !child.stdin || !child.stdout) {
          throw new Error('activation-gate supervisor did not expose its protocol');
        }
        await waitForStreamMarker(
          child.stdout,
          `LOTUS_E2E_PROCESS_GROUP_READY ${child.pid} ${token}\n`,
          child
        );
        const close = childClose(child);
        if (testCase.input !== undefined) child.stdin.end(testCase.input);
        assert.equal(await close, 74, `${testCase.name} activation must fail closed`);
        assert.equal(existsSync(workloadMarker), false);
      } finally {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          await childClose(child).catch(() => undefined);
        }
      }
    }
  } finally {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function startupSettlement(
  startup: Promise<unknown>,
  timeoutMs = 600
): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    startup.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), timeoutMs)),
  ]);
}

async function killStoppedSupervisor(child: ReturnType<typeof spawn>): Promise<void> {
  if (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null &&
    process.platform !== 'win32'
  ) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await childClose(child).catch(() => undefined);
}

async function testParentDeadlineRejectsSupervisorStoppedBeforeReady(): Promise<void> {
  if (process.platform === 'win32') return;
  const testRoot = temporaryTestDirectory('lotus-pre-ready-deadline-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const workloadMarker = join(testRoot, 'workload-started');
  let supervisorPid: number | undefined;
  let run: IsolatedE2eRun | undefined;
  try {
    await withIsolatedE2eLifecycle(async (lifecycle) => {
      run = lifecycle.run;
      const startup = lifecycle.startProcessGroup(
        process.execPath,
        [SELF_PATH, '--mark-workload-started', workloadMarker],
        {
          activationTimeoutMs: 100,
          stdio: 'ignore',
          testHooks: {
            supervisorBarrier: 'beforeReady',
            onSupervisorSpawned: (child) => {
              if (child.pid === undefined) throw new Error('pre-READY supervisor has no PID');
              supervisorPid = child.pid;
            },
          },
        }
      );
      assert.equal(
        await startupSettlement(startup, 2_000),
        'rejected',
        'the parent deadline must reject a supervisor stopped before READY'
      );
      assert.notEqual(supervisorPid, undefined);
      await waitForProcessExit(supervisorPid!);
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        run: { root: string } | null;
        processGroups: unknown[];
      };
      assert.equal(record.run?.root, lifecycle.run.root);
      assert.deepEqual(record.processGroups, []);
      assert.equal(existsSync(workloadMarker), false);
    }, lockPath);
    assert.equal(existsSync(run!.root), false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(workloadMarker), false);
  } finally {
    if (supervisorPid && processExists(supervisorPid)) {
      try {
        process.kill(-supervisorPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(supervisorPid).catch(() => undefined);
    }
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (run && existsSync(run.root)) removeIsolatedE2eRun(run);
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testParentDeadlineRejectsSupervisorStoppedBeforeActivated(): Promise<void> {
  if (process.platform === 'win32') return;
  const testRoot = temporaryTestDirectory('lotus-pre-activated-deadline-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const workloadMarker = join(testRoot, 'workload-started');
  let supervisorPid: number | undefined;
  let observedDurableRegistration = false;
  let run: IsolatedE2eRun | undefined;
  try {
    await withIsolatedE2eLifecycle(async (lifecycle) => {
      run = lifecycle.run;
      const startup = lifecycle.startProcessGroup(
        process.execPath,
        [SELF_PATH, '--mark-workload-started', workloadMarker],
        {
          activationTimeoutMs: 1_000,
          stdio: 'ignore',
          testHooks: {
            supervisorBarrier: 'beforeActivated',
            onSupervisorSpawned: (child) => {
              if (child.pid === undefined) throw new Error('pre-ACTIVATED supervisor has no PID');
              supervisorPid = child.pid;
            },
            onProcessGroupRegistered: (child) => {
              const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
                processGroups: Array<{ pid: number }>;
              };
              assert.equal(record.processGroups.length, 1);
              assert.equal(record.processGroups[0]?.pid, child.pid);
              observedDurableRegistration = true;
            },
          },
        }
      );
      assert.equal(
        await startupSettlement(startup, 2_000),
        'rejected',
        'the parent deadline must reject a supervisor stopped before ACTIVATED'
      );
      assert.notEqual(supervisorPid, undefined);
      assert.equal(observedDurableRegistration, true);
      await waitForProcessExit(supervisorPid!);
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        run: { root: string } | null;
        processGroups: unknown[];
      };
      assert.equal(record.run?.root, lifecycle.run.root);
      assert.deepEqual(record.processGroups, []);
      assert.equal(existsSync(workloadMarker), false);
    }, lockPath);
    assert.equal(existsSync(run!.root), false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(workloadMarker), false);
  } finally {
    if (supervisorPid && processExists(supervisorPid)) {
      try {
        process.kill(-supervisorPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(supervisorPid).catch(() => undefined);
    }
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (run && existsSync(run.root)) removeIsolatedE2eRun(run);
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testLateActivatedMarkerCannotBeatParentDeadline(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-late-activated-marker-test-');
  const workloadMarker = join(testRoot, 'workload-started');
  let activationWritten = false;
  let postWriteClockReads = 0;
  const gated = spawnGatedProcessGroupForRegistration(
    process.execPath,
    [SELF_PATH, '--mark-workload-started', workloadMarker],
    {
      activationTimeoutMs: 1_000,
      stdio: 'ignore',
      testHooks: {
        monotonicNow: () => {
          if (!activationWritten) return 0;
          postWriteClockReads += 1;
          return postWriteClockReads === 1 ? 0 : 5_000;
        },
        onActivationWritten: () => {
          activationWritten = true;
        },
      },
    }
  );
  try {
    await gated.waitUntilReady();
    assert.equal(
      await startupSettlement(gated.activate()),
      'rejected',
      'an ACTIVATED marker observed after the parent deadline must be rejected'
    );
    await childClose(gated.child);
    assert.equal(existsSync(workloadMarker), false);
  } finally {
    await gated.abort().catch(() => undefined);
    await killStoppedSupervisor(gated.child);
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testCrashBeforeGroupRegistrationNeverStartsWorkload(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-pre-registration-crash-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const statePath = join(testRoot, 'holder-state.json');
  const workloadMarker = join(testRoot, 'workload-started');
  const holder = observeChildProcess(
    spawn(
      process.execPath,
      [SELF_PATH, '--hold-before-group-registration', lockPath, statePath, workloadMarker],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  );
  let state: { run: IsolatedE2eRun; supervisorPid: number } | undefined;
  try {
    await waitForChildOutputMarker(
      holder,
      /LOTUS_E2E_PRE_REGISTRATION_HOLDER_READY/,
      'pre-registration crash holder',
      5_000
    );
    state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      run: IsolatedE2eRun;
      supervisorPid: number;
    };
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      processGroups: Array<{ pid: number }>;
    };
    assert.deepEqual(record.processGroups, []);

    holder.kill('SIGKILL');
    assert.equal(await childClose(holder), null);

    const recovered = await acquireE2eLifecycleLock(lockPath);
    await recovered.release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      existsSync(workloadMarker),
      false,
      'an unregistered supervisor must never launch its workload'
    );
    await waitForProcessExit(state.supervisorPid);
    assert.equal(existsSync(state.run.root), false);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await childClose(holder).catch(() => undefined);
    }
    if (state?.supervisorPid && processExists(state.supervisorPid)) {
      try {
        process.kill(-state.supervisorPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(state.supervisorPid).catch(() => undefined);
    }
    if (state?.run && existsSync(state.run.root)) removeIsolatedE2eRun(state.run);
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testCrashRecoveryReapsRegisteredGroupAndRun(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-crash-lock-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const statePath = join(testRoot, 'holder-state.json');
  const holder = observeChildProcess(
    spawn(process.execPath, [SELF_PATH, '--hold-crash-lifecycle', lockPath, statePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  let state:
    | {
        run: IsolatedE2eRun;
        childPid: number;
      }
    | undefined;
  try {
    await waitForChildOutputMarker(
      holder,
      /LOTUS_E2E_CRASH_HOLDER_READY/,
      'crash lifecycle holder',
      5_000
    );
    state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      run: IsolatedE2eRun;
      childPid: number;
    };
    assert.equal(processExists(state.childPid), true);
    assert.equal(existsSync(state.run.root), true);
    const rawRecord = readFileSync(lockPath, 'utf8');
    const record = JSON.parse(rawRecord) as {
      version: number;
      owner: { pid: number; startIdentity: string; token: string };
      run: { root: string; markerToken: string };
      processGroups: Array<{ pid: number; startIdentity: string }>;
    };
    assert.equal(JSON.stringify(record), rawRecord, 'the lock record must be canonical JSON');
    assert.equal(lstatSync(lockPath).isSymbolicLink(), false);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);
    assert.equal(record.version, 1);
    assert.equal(record.owner.pid, holder.pid);
    assert.match(record.owner.startIdentity, /^[0-9a-f]{64}$/);
    assert.match(record.owner.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.run, {
      root: state.run.root,
      markerToken: state.run.markerToken,
    });
    assert.deepEqual(
      record.processGroups.map(({ pid }) => pid),
      [state.childPid]
    );
    assert.match(record.processGroups[0]!.startIdentity, /^[0-9a-f]{64}$/);

    holder.kill('SIGKILL');
    assert.equal(await childClose(holder), null);
    assert.equal(processExists(state.childPid), true, 'the detached group must outlive its owner');

    const recovered = await acquireE2eLifecycleLock(lockPath);
    try {
      await waitForProcessExit(state.childPid);
      assert.equal(existsSync(state.run.root), false);
    } finally {
      await recovered.release();
    }
    assert.equal(existsSync(lockPath), false);
    assert.equal(
      existsSync(`${lockPath}.guard`),
      true,
      'the stable advisory inode must remain for ordered cross-process locking'
    );
    const next = await acquireE2eLifecycleLock(lockPath);
    await next.release();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await childClose(holder).catch(() => undefined);
    }
    if (state?.childPid && processExists(state.childPid)) {
      try {
        process.kill(-state.childPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(state.childPid).catch(() => undefined);
    }
    if (state?.run && existsSync(state.run.root)) removeIsolatedE2eRun(state.run);
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testCrashRecoveryWaitsForEntireRegisteredGroup(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-descendant-crash-lock-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const statePath = join(testRoot, 'holder-state.json');
  const holder = observeChildProcess(
    spawn(process.execPath, [SELF_PATH, '--hold-stubborn-crash-lifecycle', lockPath, statePath], {
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  let state:
    | {
        run: IsolatedE2eRun;
        supervisorPid: number;
        commandPid: number;
        grandchildPid: number;
      }
    | undefined;
  try {
    await waitForChildOutputMarker(
      holder,
      /LOTUS_E2E_STUBBORN_CRASH_HOLDER_READY/,
      'stubborn crash lifecycle holder',
      5_000
    );
    state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      run: IsolatedE2eRun;
      supervisorPid: number;
      commandPid: number;
      grandchildPid: number;
    };
    await waitForProcessExit(state.commandPid);
    assert.equal(processExists(state.supervisorPid), true);
    assert.equal(processExists(state.grandchildPid), true);

    holder.kill('SIGKILL');
    assert.equal(await childClose(holder), null);

    const originalTimeZone = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    const recovered = await acquireE2eLifecycleLock(lockPath).finally(() => {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    });
    try {
      await waitForProcessExit(state.supervisorPid);
      await waitForProcessExit(state.grandchildPid);
      assert.equal(existsSync(state.run.root), false);
    } finally {
      await recovered.release();
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await childClose(holder).catch(() => undefined);
    }
    if (state && (processExists(state.supervisorPid) || processExists(state.grandchildPid))) {
      try {
        process.kill(-state.supervisorPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(state.supervisorPid).catch(() => undefined);
      await waitForProcessExit(state.grandchildPid).catch(() => undefined);
    }
    if (state?.run && existsSync(state.run.root)) removeIsolatedE2eRun(state.run);
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testAbnormalSupervisorDeathPreservesNonemptyGroupAuthority(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-abnormal-supervisor-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const statePath = join(testRoot, 'holder-state.json');
  const holder = observeChildProcess(
    spawn(
      process.execPath,
      [SELF_PATH, '--hold-abnormal-supervisor-lifecycle', lockPath, statePath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  );
  let state:
    | {
        run: IsolatedE2eRun;
        supervisorPid: number;
        commandPid: number;
        grandchildPid: number;
      }
    | undefined;
  try {
    await waitForChildOutputMarker(
      holder,
      /LOTUS_E2E_ABNORMAL_SUPERVISOR_HOLDER_READY/,
      'abnormal supervisor holder',
      5_000
    );
    state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      run: IsolatedE2eRun;
      supervisorPid: number;
      commandPid: number;
      grandchildPid: number;
    };
    assert.equal(processExists(state.commandPid), true);
    assert.equal(processExists(state.grandchildPid), true);

    process.kill(state.supervisorPid, 'SIGKILL');
    await waitForProcessExit(state.supervisorPid);
    assert.equal(processExists(state.commandPid), true);
    assert.equal(processExists(state.grandchildPid), true);

    holder.kill('SIGTERM');
    assert.equal(await childClose(holder, 5_000), 143);
    assert.equal(
      existsSync(state.run.root),
      true,
      'failed group cleanup must preserve the run root'
    );
    assert.equal(existsSync(lockPath), true, 'failed group cleanup must preserve the lock record');
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      processGroups: Array<{ pid: number }>;
    };
    assert.deepEqual(
      record.processGroups.map(({ pid }) => pid),
      [state.supervisorPid]
    );
    await assert.rejects(acquireE2eLifecycleLock(lockPath), /Refusing/);
    assert.equal(processExists(state.commandPid), true);
    assert.equal(processExists(state.grandchildPid), true);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await childClose(holder).catch(() => undefined);
    }
    if (state && (processExists(state.commandPid) || processExists(state.grandchildPid))) {
      try {
        process.kill(-state.supervisorPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitForProcessExit(state.commandPid).catch(() => undefined);
      await waitForProcessExit(state.grandchildPid).catch(() => undefined);
    }
    if (existsSync(lockPath)) {
      const recovered = await acquireE2eLifecycleLock(lockPath);
      await recovered.release();
    }
    if (state?.run && existsSync(state.run.root)) removeIsolatedE2eRun(state.run);
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testPidReuseIdentityMismatchIsRecoverable(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-reused-pid-lock-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  writeFileSync(lockPath, serializedLockRecord(process.pid, REUSED_LOCK_IDENTITY), {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    const lock = await acquireE2eLifecycleLock(lockPath);
    await lock.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testAmbiguousAndInvalidLocksAreNeverReclaimed(): Promise<void> {
  const cases: Array<{
    name: string;
    install(lockPath: string): string | undefined;
  }> = [
    {
      name: 'malformed',
      install: (lockPath) => {
        writeFileSync(lockPath, 'not a lifecycle record', { mode: 0o600, flag: 'wx' });
        return undefined;
      },
    },
    {
      name: 'wrong-mode',
      install: (lockPath) => {
        writeFileSync(lockPath, serializedLockRecord(process.pid), { mode: 0o600, flag: 'wx' });
        chmodSync(lockPath, 0o644);
        return undefined;
      },
    },
    {
      name: 'symlink',
      install: (lockPath) => {
        const target = `${lockPath}.target`;
        writeFileSync(target, serializedLockRecord(process.pid), { mode: 0o600, flag: 'wx' });
        symlinkSync(target, lockPath);
        return target;
      },
    },
    ...(process.platform === 'darwin'
      ? [
          {
            name: 'eperm-owner',
            install: (lockPath: string) => {
              writeFileSync(lockPath, serializedLockRecord(1), { mode: 0o600, flag: 'wx' });
              return undefined;
            },
          },
        ]
      : []),
  ];

  for (const testCase of cases) {
    const testRoot = temporaryTestDirectory(`lotus-${testCase.name}-lock-test-`);
    const lockPath = join(testRoot, 'lifecycle.lock');
    const target = testCase.install(lockPath);
    try {
      await assert.rejects(
        Promise.resolve().then(() => acquireE2eLifecycleLock(lockPath)),
        /Refusing to recover|already running/
      );
      assert.equal(existsSync(lockPath), true);
      if (target) assert.equal(readFileSync(target, 'utf8'), serializedLockRecord(process.pid));
    } finally {
      if (existsSync(lockPath)) rmSync(lockPath, { force: false });
      if (target && existsSync(target)) rmSync(target, { force: false });
      if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
    }
  }
}

async function testInvalidGuardAndStagingPathsNeverLeakOwnership(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-invalid-guard-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const target = join(testRoot, 'sentinel');
  const missingGuardTarget = join(testRoot, 'guard-target-must-not-be-created');
  writeFileSync(target, 'unchanged', { mode: 0o600, flag: 'wx' });
  try {
    symlinkSync(missingGuardTarget, `${lockPath}.guard`);
    await assert.rejects(acquireE2eLifecycleLock(lockPath), /advisory guard/);
    assert.equal(existsSync(missingGuardTarget), false);
    rmSync(`${lockPath}.guard`, { force: false });

    symlinkSync(target, `${lockPath}.next`);
    await assert.rejects(acquireE2eLifecycleLock(lockPath), /invalid E2E lifecycle staging file/);
    assert.equal(readFileSync(target, 'utf8'), 'unchanged');
    rmSync(`${lockPath}.next`, { force: false });

    const lock = await acquireE2eLifecycleLock(lockPath);
    await lock.release();
  } finally {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testLockAndFailureCleanup(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-lock-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const actionMarker = join(testRoot, 'competing-action-ran');
  const lock = await acquireE2eLifecycleLock(lockPath);
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ['version', 'owner', 'run', 'processGroups']);
    await assert.rejects(
      Promise.resolve().then(() => acquireE2eLifecycleLock(lockPath)),
      /already running/
    );
    const contender = observeChildProcess(
      spawn(process.execPath, [SELF_PATH, '--attempt-lifecycle', lockPath, actionMarker], {
        stdio: 'ignore',
      })
    );
    assert.equal(await childClose(contender), 73);
    assert.equal(existsSync(actionMarker), false);

    await lock.release();
    let failedRunRoot: string | undefined;
    await assert.rejects(
      withIsolatedE2eLifecycle(async (lifecycle) => {
        failedRunRoot = lifecycle.run.root;
        const missing = lifecycle.trackChild(
          observeChildProcess(spawn('__lotus_e2e_missing_executable__'))
        );
        await childClose(missing);
        assert.equal(
          (observedChildProcessError(missing) as NodeJS.ErrnoException | undefined)?.code,
          'ENOENT'
        );
        throw new Error('expected isolated lifecycle failure');
      }, lockPath),
      /expected isolated lifecycle failure/
    );
    assert.equal(existsSync(lockPath), false);
    assert.equal(failedRunRoot === undefined || existsSync(failedRunRoot), false);
  } finally {
    await lock.release();
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testInterruptedCleanupRetainsMarkerForStaleRecovery(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-interrupted-cleanup-test-');
  const lockPath = join(testRoot, 'lifecycle.lock');
  const run = createIsolatedE2eRun();
  const blockedDirectory = join(run.root, 'a-mode-000-directory');
  mkdirSync(blockedDirectory);
  writeFileSync(join(blockedDirectory, 'blocked-child'), 'blocked');
  chmodSync(blockedDirectory, 0o000);
  writeFileSync(join(run.root, 'first-cleanup-entry'), 'first');
  writeFileSync(join(run.root, 'second-cleanup-entry'), 'second');
  writeFileSync(
    lockPath,
    serializedLockRecord(process.pid, REUSED_LOCK_IDENTITY, {
      root: run.root,
      markerToken: run.markerToken,
    }),
    { mode: 0o600, flag: 'wx' }
  );
  try {
    let removedEntries = 0;
    assert.throws(
      () =>
        removeIsolatedE2eRun(run, {
          onEntryRemoved: () => {
            removedEntries += 1;
            if (removedEntries === 1) throw new Error('simulated interrupted cleanup');
          },
        }),
      /simulated interrupted cleanup/
    );
    assert.equal(removedEntries, 1);
    assert.equal(existsSync(run.root), true);
    assert.equal(readFileSync(join(run.root, '.lotus-e2e-run'), 'utf8'), run.markerToken);
    assert.equal(existsSync(lockPath), true);

    const recovered = await acquireE2eLifecycleLock(lockPath);
    try {
      assert.equal(existsSync(run.root), false);
    } finally {
      await recovered.release();
    }
  } finally {
    if (existsSync(run.root)) removeIsolatedE2eRun(run);
    if (existsSync(lockPath)) rmSync(lockPath, { force: false });
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testCrashAfterMarkerRemovalRemainsRecoverable(): Promise<void> {
  const phases = [
    'authority-created',
    'authority-durable',
    'marker-unlinked',
    'root-removed',
    'authority-removed',
  ] as const;
  for (const phase of phases) {
    const testRoot = temporaryTestDirectory(`lotus-final-cleanup-${phase}-test-`);
    const lockPath = join(testRoot, 'lifecycle.lock');
    const statePath = join(testRoot, 'state.json');
    const holder = observeChildProcess(
      spawn(
        process.execPath,
        [SELF_PATH, '--hold-final-cleanup-crash', lockPath, statePath, phase],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
    );
    let run: IsolatedE2eRun | undefined;
    try {
      await waitForChildOutputMarker(
        holder,
        new RegExp(`LOTUS_E2E_FINAL_CLEANUP_CRASH_READY ${phase}`),
        `final cleanup ${phase} crash holder`,
        5_000
      );
      run = JSON.parse(readFileSync(statePath, 'utf8')) as IsolatedE2eRun;
      const markerPath = join(run.root, '.lotus-e2e-run');
      const authorityPath = `${run.root}.cleanup-${run.markerToken}`;
      assert.equal(
        existsSync(run.root),
        phase === 'authority-created' ||
          phase === 'authority-durable' ||
          phase === 'marker-unlinked'
      );
      assert.equal(
        existsSync(markerPath),
        phase === 'authority-created' || phase === 'authority-durable'
      );
      assert.equal(existsSync(authorityPath), phase !== 'authority-removed');

      holder.kill('SIGKILL');
      assert.equal(await childClose(holder), null);
      assert.equal(existsSync(lockPath), true);

      const recovered = await acquireE2eLifecycleLock(lockPath);
      try {
        assert.equal(existsSync(run.root), false);
        assert.equal(existsSync(authorityPath), false);
      } finally {
        await recovered.release();
      }
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGKILL');
        await childClose(holder).catch(() => undefined);
      }
      if (run && existsSync(run.root)) {
        const markerPath = join(run.root, '.lotus-e2e-run');
        const authorityPath = `${run.root}.cleanup-${run.markerToken}`;
        if (!existsSync(markerPath) && !existsSync(authorityPath)) {
          writeFileSync(markerPath, run.markerToken, { mode: 0o600, flag: 'wx' });
        }
        removeIsolatedE2eRun(run);
      }
      if (existsSync(lockPath)) rmSync(lockPath, { force: false });
      if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
    }
  }
}

async function testOccupiedPortsFailBeforeLifecycleWork(): Promise<void> {
  for (const port of [1420, 4445]) {
    const blocker = createServer();
    const testRoot = temporaryTestDirectory('lotus-port-test-');
    const lockPath = join(testRoot, 'lifecycle.lock');
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', () => {
        blocker.off('error', reject);
        resolve();
      });
    });
    let lifecycleWorkStarted = false;
    try {
      await assert.rejects(
        withIsolatedE2eLifecycle(async () => {
          lifecycleWorkStarted = true;
        }, lockPath),
        new RegExp(`${port}.*already occupied`)
      );
      assert.equal(lifecycleWorkStarted, false);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
      if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
    }
  }
}

async function testChildOwnedReadiness(): Promise<void> {
  const earlyExit = observeChildProcess(
    spawn(process.execPath, ['-e', 'process.exit(7)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  await assert.rejects(
    waitForChildOutputMarker(earlyExit, /LOTUS_READY/, 'test child', 2_000),
    /test child exited before its readiness marker/
  );
  assert.equal(earlyExit.exitCode, 7);

  const markedChild = observeChildProcess(
    spawn(process.execPath, ['-e', "console.log('LOTUS_READY'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  await waitForChildOutputMarker(markedChild, /LOTUS_READY/, 'marked child', 2_000);
  assert.equal(markedChild.exitCode, null);
  await stopChildProcess(markedChild);
  assert.notEqual(markedChild.signalCode, null);
}

async function genericTcpConnects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function testListeningPortMustBelongToExpectedChild(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const appLike = observeChildProcess(
    spawn(process.execPath, ['-e', "console.log('APP_MARKER'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  const unrelatedListener = observeChildProcess(
    spawn(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer().listen(4445, '127.0.0.1', () => console.log('UNRELATED_LISTENER_READY')); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  );
  try {
    await waitForChildOutputMarker(appLike, /APP_MARKER/, 'app-like marker child', 2_000);
    await waitForChildOutputMarker(
      unrelatedListener,
      /UNRELATED_LISTENER_READY/,
      'unrelated listener child',
      2_000
    );
    assert.equal(await genericTcpConnects(4445), true, 'generic TCP readiness must be positive');
    await assert.rejects(
      waitForOwnedListeningPort('127.0.0.1', 4445, appLike, 'app-like child', 300),
      /owned listening socket/
    );
  } finally {
    await stopChildProcess(unrelatedListener);
    await stopChildProcess(appLike);
  }

  const owningListener = observeChildProcess(
    spawn(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer().listen(4445, '127.0.0.1', () => console.log('OWNED_LISTENER_READY')); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  );
  try {
    await waitForChildOutputMarker(
      owningListener,
      /OWNED_LISTENER_READY/,
      'owned listener child',
      2_000
    );
    await waitForOwnedListeningPort(
      '127.0.0.1',
      4445,
      owningListener,
      'owned listener child',
      2_000
    );
  } finally {
    await stopChildProcess(owningListener);
  }
}

async function testListeningPortHandoffCannotPassOwnershipCheck(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const expectedListener = observeChildProcess(
    spawn(
      process.execPath,
      [
        '-e',
        "const server=require('node:net').createServer(); process.on('SIGUSR1',()=>server.close(()=>console.log('EXPECTED_LISTENER_RELEASED'))); server.listen(4445,'127.0.0.1',()=>console.log('EXPECTED_LISTENER_READY')); setInterval(()=>{},1000)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  );
  let unrelatedListener: ReturnType<typeof spawn> | undefined;
  try {
    await waitForChildOutputMarker(
      expectedListener,
      /EXPECTED_LISTENER_READY/,
      'expected handoff listener',
      2_000
    );
    await assert.rejects(
      waitForOwnedListeningPort('127.0.0.1', 4445, expectedListener, 'handoff listener', 800, {
        afterInitialOwnershipSample: async () => {
          if (!expectedListener.stdout) throw new Error('expected listener has no stdout');
          const released = waitForStreamMarker(
            expectedListener.stdout,
            'EXPECTED_LISTENER_RELEASED',
            expectedListener
          );
          expectedListener.kill('SIGUSR1');
          await released;
          unrelatedListener = observeChildProcess(
            spawn(
              process.execPath,
              [
                '-e',
                "require('node:net').createServer().listen(4445,'127.0.0.1',()=>console.log('HANDOFF_LISTENER_READY')); setInterval(()=>{},1000)",
              ],
              { stdio: ['ignore', 'pipe', 'pipe'] }
            )
          );
          await waitForChildOutputMarker(
            unrelatedListener,
            /HANDOFF_LISTENER_READY/,
            'unrelated handoff listener',
            2_000
          );
        },
      }),
      /owned listening socket/
    );
  } finally {
    await stopChildProcess(unrelatedListener);
    await stopChildProcess(expectedListener);
  }
}

async function testSupervisorExitsWhenCommandGroupIsEmpty(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-supervisor-exit-test-');
  try {
    await withIsolatedE2eLifecycle(
      async (lifecycle) => {
        const supervisor = await lifecycle.startProcessGroup(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 100)'],
          { stdio: 'ignore' }
        );
        assert.equal(await childClose(supervisor), 0);
        await lifecycle.untrackChild(supervisor);
      },
      join(testRoot, 'lifecycle.lock')
    );
  } finally {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testOneLifecycleStartsSequentialRegisteredGroups(): Promise<void> {
  const testRoot = temporaryTestDirectory('lotus-sequential-supervisor-test-');
  try {
    await withIsolatedE2eLifecycle(
      async (lifecycle) => {
        for (let iteration = 0; iteration < 10; iteration += 1) {
          const supervisor = await lifecycle.startProcessGroup(
            process.execPath,
            ['-e', 'setTimeout(() => process.exit(0), 10)'],
            { stdio: 'ignore' }
          );
          assert.equal(await childClose(supervisor), 0);
          await lifecycle.untrackChild(supervisor);
        }
      },
      join(testRoot, 'lifecycle.lock')
    );
  } finally {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: false });
  }
}

async function testRunDescriptorAndImmutableArtifacts(): Promise<void> {
  await withRun(async (run) => {
    assert.match(run.markerToken, /^[0-9a-f]{64}$/);
    assert.equal(statSync(join(run.root, '.lotus-e2e-run')).mode & 0o777, 0o600);
    assert.deepEqual(
      [
        run.productionTargetDir,
        run.webdriverTargetDir,
        run.productionDistDir,
        run.webdriverBuildDistDir,
        run.binaryPath,
        run.distDir,
      ],
      [
        join(run.root, 'build', 'production-target'),
        join(run.root, 'build', 'webdriver-target'),
        join(run.root, 'build', 'production-dist'),
        join(run.root, 'build', 'webdriver-dist'),
        join(run.root, 'runtime', 'app'),
        join(run.root, 'runtime', 'dist'),
      ]
    );

    const sourceBinary = join(run.webdriverTargetDir, 'debug', 'app');
    const sourceAsset = join(run.webdriverBuildDistDir, 'assets', 'app.js');
    mkdirSync(dirname(sourceBinary), { recursive: true });
    mkdirSync(dirname(sourceAsset), { recursive: true });
    writeFileSync(sourceBinary, 'webdriver-binary', { mode: 0o755 });
    writeFileSync(join(run.webdriverBuildDistDir, 'index.html'), '<main>e2e</main>');
    writeFileSync(sourceAsset, 'console.log("e2e")');
    writeFileSync(run.configPath, 'studios: {}\n', { mode: 0o600 });

    installRuntimeArtifacts(run, sourceBinary, run.webdriverBuildDistDir);
    assert.equal(readFileSync(run.binaryPath, 'utf8'), 'webdriver-binary');
    assert.equal(readFileSync(join(run.distDir, 'index.html'), 'utf8'), '<main>e2e</main>');
    assert.equal(readFileSync(join(run.distDir, 'assets', 'app.js'), 'utf8'), 'console.log("e2e")');
    assert.equal(statSync(run.binaryPath).mode & 0o777, 0o555);
    assert.equal(statSync(join(run.distDir, 'index.html')).mode & 0o777, 0o444);
    assert.deepEqual(
      loadIsolatedE2eRunFromEnvironment({
        LOTUS_E2E_RUN_ROOT: run.root,
        LOTUS_E2E_CONFIG_PATH: run.configPath,
        LOTUS_E2E_RUN_MARKER_TOKEN: run.markerToken,
      }),
      run
    );
    assert.throws(
      () =>
        loadIsolatedE2eRunFromEnvironment({
          LOTUS_E2E_RUN_ROOT: run.root,
          LOTUS_E2E_CONFIG_PATH: run.configPath,
          LOTUS_E2E_RUN_MARKER_TOKEN:
            'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        }),
      /marker/
    );
  });
}

async function testProductionProofAndExactCleanup(): Promise<void> {
  await withRun((run) => {
    const binary = join(run.productionTargetDir, 'debug', 'app');
    const frontend = join(run.productionDistDir, 'index.js');
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(run.productionDistDir, { recursive: true });
    writeFileSync(binary, 'normal production binary');
    writeFileSync(frontend, 'window.__LOTUS_E2E__ = {}');
    assert.throws(
      () => assertProductionArtifactsExcludeE2eSeams(run),
      /production frontend contains webdriver-only seam/
    );
    writeFileSync(frontend, 'normal frontend');
    writeFileSync(binary, 'binary --e2e-run-marker-token');
    assert.throws(
      () => assertProductionArtifactsExcludeE2eSeams(run),
      /production binary contains webdriver-only seam/
    );
    writeFileSync(binary, 'normal production binary');
    assert.doesNotThrow(() => assertProductionArtifactsExcludeE2eSeams(run));
  });

  for (const field of ['dataDir', 'configPath'] as const) {
    const run = createIsolatedE2eRun();
    const invalid = {
      ...run,
      [field]: join(run.root, 'nested', field === 'dataDir' ? 'app-data' : 'config.yaml'),
    };
    assert.throws(() => removeIsolatedE2eRun(invalid), /unvalidated/);
    assert.equal(existsSync(run.root), true);
    removeIsolatedE2eRun(run);
  }

  const symlinkRun = createIsolatedE2eRun();
  const markerPath = join(symlinkRun.root, '.lotus-e2e-run');
  const authorityPath = `${symlinkRun.root}.cleanup-${symlinkRun.markerToken}`;
  const authorityTarget = join(symlinkRun.root, 'authority-target');
  try {
    writeFileSync(authorityTarget, 'must remain untouched', { mode: 0o600, flag: 'wx' });
    rmSync(markerPath, { force: false });
    symlinkSync(authorityTarget, authorityPath);
    assert.throws(() => removeIsolatedE2eRun(symlinkRun), /cleanup authority/);
    assert.equal(readFileSync(authorityTarget, 'utf8'), 'must remain untouched');
  } finally {
    if (existsSync(authorityPath)) rmSync(authorityPath, { force: false });
    if (!existsSync(markerPath)) {
      writeFileSync(markerPath, symlinkRun.markerToken, { mode: 0o600, flag: 'wx' });
    }
    if (existsSync(symlinkRun.root)) removeIsolatedE2eRun(symlinkRun);
  }
}

async function runLifecycleSelftest(): Promise<void> {
  await testCrashBeforeGroupRegistrationNeverStartsWorkload();
  await testActivationGateRejectsEveryInvalidPreActivationInput();
  await testParentDeadlineRejectsSupervisorStoppedBeforeReady();
  await testParentDeadlineRejectsSupervisorStoppedBeforeActivated();
  await testLateActivatedMarkerCannotBeatParentDeadline();
  await testPidReuseIdentityMismatchIsRecoverable();
  await testAmbiguousAndInvalidLocksAreNeverReclaimed();
  await testInvalidGuardAndStagingPathsNeverLeakOwnership();
  await testInvalidRecordedRunRootIsNeverForgotten();
  await testCrashRecoveryReapsRegisteredGroupAndRun();
  await testCrashRecoveryWaitsForEntireRegisteredGroup();
  await testAbnormalSupervisorDeathPreservesNonemptyGroupAuthority();
  await testLockAndFailureCleanup();
  await testInterruptedCleanupRetainsMarkerForStaleRecovery();
  await testCrashAfterMarkerRemovalRemainsRecoverable();
  await testOccupiedPortsFailBeforeLifecycleWork();
  await testChildOwnedReadiness();
  await testListeningPortMustBelongToExpectedChild();
  await testListeningPortHandoffCannotPassOwnershipCheck();
  await testSupervisorExitsWhenCommandGroupIsEmpty();
  await testOneLifecycleStartsSequentialRegisteredGroups();
  await testRunDescriptorAndImmutableArtifacts();
  await testProductionProofAndExactCleanup();
}

const lifecycleAttempt = process.argv.indexOf('--attempt-lifecycle');
const crashHolderAttempt = process.argv.indexOf('--hold-crash-lifecycle');
const stubbornCrashHolderAttempt = process.argv.indexOf('--hold-stubborn-crash-lifecycle');
const stubbornGroupLeaderAttempt = process.argv.indexOf('--stubborn-group-leader');
const abnormalSupervisorHolderAttempt = process.argv.indexOf(
  '--hold-abnormal-supervisor-lifecycle'
);
const stubbornLiveGroupAttempt = process.argv.indexOf('--stubborn-live-group');
const preRegistrationHolderAttempt = process.argv.indexOf('--hold-before-group-registration');
const finalCleanupCrashHolderAttempt = process.argv.indexOf('--hold-final-cleanup-crash');
const workloadMarkerAttempt = process.argv.indexOf('--mark-workload-started');
if (workloadMarkerAttempt >= 0) {
  const markerPath = process.argv[workloadMarkerAttempt + 1];
  if (!markerPath) throw new Error('--mark-workload-started requires a marker path');
  writeFileSync(markerPath, 'started', { mode: 0o600, flag: 'wx' });
  await new Promise(() => undefined);
} else if (finalCleanupCrashHolderAttempt >= 0) {
  const lockPath = process.argv[finalCleanupCrashHolderAttempt + 1];
  const statePath = process.argv[finalCleanupCrashHolderAttempt + 2];
  const targetPhase = process.argv[finalCleanupCrashHolderAttempt + 3];
  const cleanupPhases = new Set([
    'authority-created',
    'authority-durable',
    'marker-unlinked',
    'root-removed',
    'authority-removed',
  ]);
  if (!lockPath || !statePath || !targetPhase || !cleanupPhases.has(targetPhase)) {
    throw new Error('--hold-final-cleanup-crash requires lock, state, and phase arguments');
  }
  const lock = await acquireE2eLifecycleLock(lockPath);
  const run = createIsolatedE2eRun();
  lock.registerRun(run);
  writeFileSync(join(run.root, 'cleanup-entry'), 'cleanup');
  writeFileSync(statePath, JSON.stringify(run), { mode: 0o600, flag: 'wx' });
  let phaseReached = false;
  removeIsolatedE2eRun(run, {
    onCleanupPhase: (phase) => {
      if (phase !== targetPhase) return;
      phaseReached = true;
      writeSync(1, `LOTUS_E2E_FINAL_CLEANUP_CRASH_READY ${phase}\n`);
      process.kill(process.pid, 'SIGSTOP');
    },
  });
  if (!phaseReached) {
    throw new Error(`final cleanup phase hook was not invoked: ${targetPhase}`);
  }
  throw new Error('final cleanup crash holder unexpectedly resumed');
} else if (preRegistrationHolderAttempt >= 0) {
  const lockPath = process.argv[preRegistrationHolderAttempt + 1];
  const statePath = process.argv[preRegistrationHolderAttempt + 2];
  const workloadMarker = process.argv[preRegistrationHolderAttempt + 3];
  if (!lockPath || !statePath || !workloadMarker) {
    throw new Error('--hold-before-group-registration requires lock, state, and marker paths');
  }
  await withIsolatedE2eLifecycle(async (lifecycle) => {
    const supervisor = observeChildProcess(
      spawnGatedProcessGroupForRegistration(
        process.execPath,
        [SELF_PATH, '--mark-workload-started', workloadMarker],
        { stdio: 'ignore' }
      ).child
    );
    if (supervisor.pid === undefined) throw new Error('pre-registration supervisor did not start');
    writeFileSync(
      statePath,
      JSON.stringify({ run: lifecycle.run, supervisorPid: supervisor.pid }),
      { mode: 0o600, flag: 'wx' }
    );
    console.log('LOTUS_E2E_PRE_REGISTRATION_HOLDER_READY');
    await new Promise(() => undefined);
  }, lockPath);
} else if (stubbornLiveGroupAttempt >= 0) {
  const statePath = process.argv[stubbornLiveGroupAttempt + 1];
  if (!statePath) throw new Error('--stubborn-live-group requires a state path');
  process.on('SIGTERM', () => undefined);
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' }
  );
  if (grandchild.pid === undefined) throw new Error('stubborn live grandchild did not start');
  writeFileSync(
    statePath,
    JSON.stringify({ commandPid: process.pid, grandchildPid: grandchild.pid }),
    { mode: 0o600, flag: 'wx' }
  );
  await new Promise(() => undefined);
} else if (abnormalSupervisorHolderAttempt >= 0) {
  const lockPath = process.argv[abnormalSupervisorHolderAttempt + 1];
  const statePath = process.argv[abnormalSupervisorHolderAttempt + 2];
  if (!lockPath || !statePath) {
    throw new Error('--hold-abnormal-supervisor-lifecycle requires lock and state paths');
  }
  await withIsolatedE2eLifecycle(async (lifecycle) => {
    const groupStatePath = join(lifecycle.run.root, 'abnormal-group-state.json');
    const supervisor = await lifecycle.startProcessGroup(
      process.execPath,
      [SELF_PATH, '--stubborn-live-group', groupStatePath],
      { stdio: 'ignore' }
    );
    if (supervisor.pid === undefined) throw new Error('abnormal group supervisor did not start');
    const stateDeadline = Date.now() + 5_000;
    while (!existsSync(groupStatePath) && Date.now() < stateDeadline) {
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        throw new Error('abnormal group supervisor exited before workload readiness');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!existsSync(groupStatePath)) throw new Error('abnormal group workload readiness timed out');
    const { commandPid, grandchildPid } = JSON.parse(readFileSync(groupStatePath, 'utf8')) as {
      commandPid: number;
      grandchildPid: number;
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        run: lifecycle.run,
        supervisorPid: supervisor.pid,
        commandPid,
        grandchildPid,
      }),
      { mode: 0o600, flag: 'wx' }
    );
    console.log('LOTUS_E2E_ABNORMAL_SUPERVISOR_HOLDER_READY');
    await new Promise(() => undefined);
  }, lockPath);
} else if (stubbornGroupLeaderAttempt >= 0) {
  const statePath = process.argv[stubbornGroupLeaderAttempt + 1];
  if (!statePath) throw new Error('--stubborn-group-leader requires a state path');
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' }
  );
  if (grandchild.pid === undefined) throw new Error('stubborn grandchild did not start');
  writeFileSync(
    statePath,
    JSON.stringify({ commandPid: process.pid, grandchildPid: grandchild.pid }),
    {
      mode: 0o600,
      flag: 'wx',
    }
  );
  console.log('LOTUS_E2E_STUBBORN_GROUP_READY');
  process.exit(0);
} else if (stubbornCrashHolderAttempt >= 0) {
  const lockPath = process.argv[stubbornCrashHolderAttempt + 1];
  const statePath = process.argv[stubbornCrashHolderAttempt + 2];
  if (!lockPath || !statePath) {
    throw new Error('--hold-stubborn-crash-lifecycle requires a lock and state path');
  }
  await withIsolatedE2eLifecycle(async (lifecycle) => {
    const groupStatePath = join(lifecycle.run.root, 'stubborn-group-state.json');
    const supervisor = await lifecycle.startProcessGroup(
      process.execPath,
      [SELF_PATH, '--stubborn-group-leader', groupStatePath],
      { stdio: 'ignore' }
    );
    if (supervisor.pid === undefined) throw new Error('stubborn group supervisor did not start');
    const stateDeadline = Date.now() + 5_000;
    while (!existsSync(groupStatePath) && Date.now() < stateDeadline) {
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        throw new Error('stubborn group supervisor exited before command readiness');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!existsSync(groupStatePath)) throw new Error('stubborn group command readiness timed out');
    const { commandPid, grandchildPid } = JSON.parse(readFileSync(groupStatePath, 'utf8')) as {
      commandPid: number;
      grandchildPid: number;
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        run: lifecycle.run,
        supervisorPid: supervisor.pid,
        commandPid,
        grandchildPid,
      }),
      { mode: 0o600, flag: 'wx' }
    );
    console.log('LOTUS_E2E_STUBBORN_CRASH_HOLDER_READY');
    await new Promise(() => undefined);
  }, lockPath);
} else if (crashHolderAttempt >= 0) {
  const lockPath = process.argv[crashHolderAttempt + 1];
  const statePath = process.argv[crashHolderAttempt + 2];
  if (!lockPath || !statePath) {
    throw new Error('--hold-crash-lifecycle requires a lock and state path');
  }
  await withIsolatedE2eLifecycle(async (lifecycle) => {
    const child = await lifecycle.startProcessGroup(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' }
    );
    if (child.pid === undefined) throw new Error('crash holder child did not start');
    writeFileSync(statePath, JSON.stringify({ run: lifecycle.run, childPid: child.pid }), {
      mode: 0o600,
      flag: 'wx',
    });
    console.log('LOTUS_E2E_CRASH_HOLDER_READY');
    await new Promise(() => undefined);
  }, lockPath);
} else if (lifecycleAttempt >= 0) {
  const lockPath = process.argv[lifecycleAttempt + 1];
  const actionMarker = process.argv[lifecycleAttempt + 2];
  if (!lockPath || !actionMarker) {
    throw new Error('--attempt-lifecycle requires a lock and action marker path');
  }
  try {
    await withIsolatedE2eLifecycle(async () => {
      writeFileSync(actionMarker, 'unexpected');
    }, lockPath);
  } catch {
    process.exitCode = 73;
  }
} else if (process.argv.includes('--self-test-pre-registration')) {
  await testCrashBeforeGroupRegistrationNeverStartsWorkload();
} else if (process.argv.includes('--self-test-activation-gate')) {
  await testActivationGateRejectsEveryInvalidPreActivationInput();
} else if (process.argv.includes('--self-test-parent-pre-ready')) {
  await testParentDeadlineRejectsSupervisorStoppedBeforeReady();
} else if (process.argv.includes('--self-test-parent-pre-activated')) {
  await testParentDeadlineRejectsSupervisorStoppedBeforeActivated();
} else if (process.argv.includes('--self-test-late-marker-deadline')) {
  await testLateActivatedMarkerCannotBeatParentDeadline();
} else if (process.argv.includes('--self-test-owned-listener')) {
  await testListeningPortMustBelongToExpectedChild();
  await testListeningPortHandoffCannotPassOwnershipCheck();
} else if (process.argv.includes('--self-test-final-cleanup-crash')) {
  await testCrashAfterMarkerRemovalRemainsRecoverable();
} else if (process.argv.includes('--self-test-abnormal-unregister')) {
  await testAbnormalSupervisorDeathPreservesNonemptyGroupAuthority();
} else if (process.argv.includes('--self-test')) {
  await runLifecycleSelftest();
  console.log('E2E lifecycle helper tests passed');
  process.exit(0);
}
