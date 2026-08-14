import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

const LOCK_GUARD_SUFFIX = '.guard';
const LOCK_STAGING_SUFFIX = '.next';
const LOCK_RECORD_VERSION = 1;
const LOCK_GUARD_READY = 'LOTUS_E2E_LOCK_GUARD_READY';
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RECORD_MAX_BYTES = 64 * 1024;

export interface LifecycleRunRegistration {
  readonly root: string;
  readonly markerToken: string;
}

export interface ProcessGroupIdentity {
  readonly pid: number;
  readonly startIdentity: string;
}

export interface E2eLifecycleLock {
  readonly path: string;
  registerRun(run: LifecycleRunRegistration): void;
  registerProcessGroup(pid: number): ProcessGroupIdentity;
  unregisterProcessGroup(group: ProcessGroupIdentity): Promise<void>;
  clearRun(run: LifecycleRunRegistration): void;
  release(preserveRecord?: boolean): Promise<void>;
}

interface ProcessIdentity extends ProcessGroupIdentity {
  readonly processGroupId: number;
}

interface LifecycleLockRecord {
  readonly version: 1;
  readonly owner: {
    readonly pid: number;
    readonly startIdentity: string;
    readonly token: string;
  };
  readonly run: LifecycleRunRegistration | null;
  readonly processGroups: ProcessGroupIdentity[];
}

type ProcessProbe =
  | { readonly state: 'live'; readonly identity: ProcessIdentity }
  | { readonly state: 'dead' }
  | { readonly state: 'ambiguous'; readonly reason: string };

interface AdvisoryGuard {
  release(): Promise<void>;
}

function validHexIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function processStartIdentity(startedAt: string): string {
  return createHash('sha256').update(startedAt).digest('hex');
}

function probeProcess(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead' };
    return { state: 'ambiguous', reason: `process probe failed with ${code ?? 'unknown error'}` };
  }

  const result = spawnSync(
    '/bin/ps',
    ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='],
    {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      maxBuffer: 8 * 1024,
    }
  );
  if (result.error || result.signal || result.status !== 0 || result.stderr.trim() !== '') {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'dead' };
    }
    return { state: 'ambiguous', reason: 'process start identity could not be read' };
  }
  const match = result.stdout.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
  if (!match || Number(match[1]) !== pid) {
    return { state: 'ambiguous', reason: 'process start identity had an unexpected format' };
  }
  const processGroupId = Number(match[2]);
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    return { state: 'ambiguous', reason: 'process group identity had an unexpected format' };
  }
  return {
    state: 'live',
    identity: {
      pid,
      processGroupId,
      startIdentity: processStartIdentity(match[3]!),
    },
  };
}

function listProcessGroupMembers(processGroupId: number): ProcessIdentity[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr.trim() !== '') {
    throw new Error('Refusing to inspect an E2E process group with ambiguous membership');
  }
  const members: ProcessIdentity[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      throw new Error('Refusing to inspect an E2E process group with malformed process data');
    }
    const pid = Number(match[1]);
    const candidateGroupId = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(candidateGroupId)) {
      throw new Error('Refusing to inspect an E2E process group with invalid process data');
    }
    if (pid !== result.pid && candidateGroupId === processGroupId) {
      members.push({
        pid,
        processGroupId: candidateGroupId,
        startIdentity: processStartIdentity(match[3]!),
      });
    }
  }
  return members;
}

function canonicalLockRecord(record: LifecycleLockRecord): string {
  return JSON.stringify({
    version: record.version,
    owner: {
      pid: record.owner.pid,
      startIdentity: record.owner.startIdentity,
      token: record.owner.token,
    },
    run:
      record.run === null ? null : { root: record.run.root, markerToken: record.run.markerToken },
    processGroups: record.processGroups.map(({ pid, startIdentity }) => ({
      pid,
      startIdentity,
    })),
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function parseLockRecord(raw: string): LifecycleLockRecord {
  if (Buffer.byteLength(raw) > LOCK_RECORD_MAX_BYTES) {
    throw new Error('lifecycle lock record is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('lifecycle lock record is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('lifecycle lock record must be an object');
  }
  const candidate = parsed as Record<string, unknown>;
  const owner = candidate.owner as Record<string, unknown> | null;
  const run = candidate.run as Record<string, unknown> | null;
  const groups = candidate.processGroups;
  if (
    !exactKeys(candidate, ['version', 'owner', 'run', 'processGroups']) ||
    candidate.version !== LOCK_RECORD_VERSION ||
    typeof owner !== 'object' ||
    owner === null ||
    Array.isArray(owner) ||
    !exactKeys(owner, ['pid', 'startIdentity', 'token']) ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) < 1 ||
    !validHexIdentity(owner.startIdentity) ||
    !validHexIdentity(owner.token) ||
    (run !== null &&
      (typeof run !== 'object' ||
        Array.isArray(run) ||
        !exactKeys(run, ['root', 'markerToken']) ||
        typeof run.root !== 'string' ||
        !isAbsolute(run.root) ||
        !validHexIdentity(run.markerToken))) ||
    !Array.isArray(groups) ||
    groups.length > 64
  ) {
    throw new Error('lifecycle lock record has an invalid shape');
  }
  const processGroups: ProcessGroupIdentity[] = [];
  const groupPids = new Set<number>();
  for (const value of groups) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('lifecycle lock process group has an invalid shape');
    }
    const group = value as Record<string, unknown>;
    if (
      !exactKeys(group, ['pid', 'startIdentity']) ||
      !Number.isSafeInteger(group.pid) ||
      Number(group.pid) < 2 ||
      !validHexIdentity(group.startIdentity) ||
      groupPids.has(Number(group.pid))
    ) {
      throw new Error('lifecycle lock process group has an invalid identity');
    }
    groupPids.add(Number(group.pid));
    processGroups.push({ pid: Number(group.pid), startIdentity: group.startIdentity });
  }
  const record: LifecycleLockRecord = {
    version: 1,
    owner: {
      pid: Number(owner.pid),
      startIdentity: owner.startIdentity,
      token: owner.token,
    },
    run: run === null ? null : { root: run.root as string, markerToken: run.markerToken as string },
    processGroups,
  };
  if (canonicalLockRecord(record) !== raw) {
    throw new Error('lifecycle lock record is not in canonical format');
  }
  return record;
}

function readLockRecord(lockPath: string): LifecycleLockRecord {
  const metadata = lstatSync(lockPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)
  ) {
    throw new Error('lifecycle lock must be a 0600 regular non-symlink file');
  }
  return parseLockRecord(readFileSync(lockPath, 'utf8'));
}

function syncParent(path: string): void {
  const descriptor = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function stagingPath(lockPath: string): string {
  return `${lockPath}${LOCK_STAGING_SUFFIX}`;
}

function metadataIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function clearAbandonedStagingFile(lockPath: string): void {
  const path = stagingPath(lockPath);
  const metadata = metadataIfPresent(path);
  if (!metadata) return;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)
  ) {
    throw new Error('Refusing to remove an invalid E2E lifecycle staging file');
  }
  rmSync(path, { force: false });
  syncParent(path);
}

function writeRecordFile(path: string, record: LifecycleLockRecord): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, canonicalLockRecord(record));
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(path)) rmSync(path, { force: false });
    throw error;
  }
  closeSync(descriptor);
}

function createLockRecord(lockPath: string, record: LifecycleLockRecord): void {
  const nextPath = stagingPath(lockPath);
  try {
    writeRecordFile(nextPath, record);
    linkSync(nextPath, lockPath);
    syncParent(lockPath);
  } finally {
    if (existsSync(nextPath)) rmSync(nextPath, { force: false });
  }
}

function replaceLockRecord(lockPath: string, record: LifecycleLockRecord): void {
  const nextPath = stagingPath(lockPath);
  try {
    writeRecordFile(nextPath, record);
    renameSync(nextPath, lockPath);
    syncParent(lockPath);
  } finally {
    if (existsSync(nextPath)) rmSync(nextPath, { force: false });
  }
}

async function stopGuardProcess(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), 2_000);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
  });
  if (closed) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out releasing the E2E lifecycle advisory guard')),
      1_000
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function tryAcquireAdvisoryGuard(lockPath: string): Promise<AdvisoryGuard | null> {
  const guardPath = `${lockPath}${LOCK_GUARD_SUFFIX}`;
  const existingGuard = metadataIfPresent(guardPath);
  if (existingGuard) {
    const metadata = existingGuard;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Refusing to use an invalid E2E lifecycle advisory guard');
    }
  }
  const child = spawn(
    '/usr/bin/lockf',
    [
      '-s',
      '-k',
      '-t',
      '0',
      guardPath,
      '/bin/sh',
      '-c',
      `printf '${LOCK_GUARD_READY}\\n'; cat >/dev/null`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let acquired: boolean;
  try {
    acquired = await new Promise<boolean>((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (value: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        output = `${output}${chunk.toString()}`.slice(-1_024);
        if (output.includes(LOCK_GUARD_READY)) finish(true);
      };
      const onError = (error: Error) => finish(false, error);
      const onExit = (code: number | null) => {
        if (code === 75) finish(false);
        else finish(false, new Error(`E2E lifecycle advisory guard exited with ${code}`));
      };
      const timer = setTimeout(
        () => finish(false, new Error('Timed out acquiring the E2E lifecycle advisory guard')),
        2_000
      );
      child.stdout?.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  } catch (error) {
    await stopGuardProcess(child).catch(() => undefined);
    throw error;
  }
  if (!acquired) return null;
  const metadata = lstatSync(guardPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    await stopGuardProcess(child);
    throw new Error('E2E lifecycle advisory guard is not a regular file');
  }
  chmodSync(guardPath, 0o600);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await stopGuardProcess(child);
    },
  };
}

function classifyRecordOwner(record: LifecycleLockRecord): 'live' | 'stale' | 'ambiguous' {
  const probe = probeProcess(record.owner.pid);
  if (probe.state === 'dead') return 'stale';
  if (probe.state === 'ambiguous') return 'ambiguous';
  return probe.identity.startIdentity === record.owner.startIdentity ? 'live' : 'stale';
}

async function acquireAdvisoryGuard(lockPath: string): Promise<AdvisoryGuard> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const guard = await tryAcquireAdvisoryGuard(lockPath);
    if (guard) {
      try {
        clearAbandonedStagingFile(lockPath);
        return guard;
      } catch (error) {
        await guard.release();
        throw error;
      }
    }
    if (existsSync(lockPath)) {
      let record: LifecycleLockRecord;
      try {
        record = readLockRecord(lockPath);
      } catch {
        throw new Error('Refusing to recover an invalid E2E lifecycle lock record');
      }
      const owner = classifyRecordOwner(record);
      if (owner === 'live') throw new Error('Another Lotus E2E lifecycle is already running');
      if (owner === 'ambiguous') {
        throw new Error('Refusing to recover an E2E lifecycle lock with ambiguous ownership');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting to recover the E2E lifecycle lock');
}

async function waitForProcessGroupToEmpty(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let emptySince: number | undefined;
  while (Date.now() < deadline) {
    if (listProcessGroupMembers(processGroupId).length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= 250) return true;
    } else {
      emptySince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function reapMatchingProcessGroup(group: ProcessGroupIdentity): Promise<void> {
  const initial = probeProcess(group.pid);
  if (initial.state === 'dead') {
    if (listProcessGroupMembers(group.pid).length === 0) return;
    throw new Error('Refusing to recover a nonempty group whose recorded leader exited');
  }
  if (initial.state === 'ambiguous') {
    throw new Error('Refusing to recover a process group with ambiguous ownership');
  }
  if (initial.identity.startIdentity !== group.startIdentity) return;
  if (initial.identity.processGroupId !== group.pid) {
    throw new Error('Refusing to signal a process that is not its recorded group leader');
  }
  if (
    !listProcessGroupMembers(group.pid).some(
      (member) => member.pid === group.pid && member.startIdentity === group.startIdentity
    )
  ) {
    throw new Error('Refusing to signal a process group without its verified recorded leader');
  }
  try {
    process.kill(-group.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    if (listProcessGroupMembers(group.pid).length === 0) return;
    throw new Error('Refusing to clear a process group that remained after SIGTERM failed');
  }
  if (await waitForProcessGroupToEmpty(group.pid, 1_000)) return;
  const beforeKill = probeProcess(group.pid);
  if (beforeKill.state === 'dead') {
    if (await waitForProcessGroupToEmpty(group.pid, 2_000)) return;
    throw new Error('Refusing to force-kill a nonempty group whose supervisor exited');
  }
  if (beforeKill.state === 'ambiguous') {
    throw new Error(
      `Refusing to force-kill a process group whose supervisor is ${beforeKill.state}`
    );
  }
  if (
    beforeKill.identity.startIdentity !== group.startIdentity ||
    beforeKill.identity.processGroupId !== group.pid
  ) {
    throw new Error('Refusing to force-kill a process group without its verified supervisor');
  }
  try {
    process.kill(-group.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (!(await waitForProcessGroupToEmpty(group.pid, 2_000))) {
    throw new Error('Timed out reaping a verified stale E2E process group');
  }
}

async function recoverStaleLifecycle(
  lockPath: string,
  record: LifecycleLockRecord,
  recoverRun: (run: LifecycleRunRegistration) => void
): Promise<void> {
  const owner = classifyRecordOwner(record);
  if (owner === 'live') throw new Error('Another Lotus E2E lifecycle is already running');
  if (owner === 'ambiguous') {
    throw new Error('Refusing to recover an E2E lifecycle lock with ambiguous ownership');
  }
  for (const group of record.processGroups) await reapMatchingProcessGroup(group);
  if (record.run !== null) recoverRun(record.run);
  const current = readLockRecord(lockPath);
  if (canonicalLockRecord(current) !== canonicalLockRecord(record)) {
    throw new Error('Refusing to remove a lifecycle lock record that changed during recovery');
  }
  rmSync(lockPath, { force: false });
  syncParent(lockPath);
}

export async function acquireLifecycleLock(
  lockPath: string,
  recoverRun: (run: LifecycleRunRegistration) => void
): Promise<E2eLifecycleLock> {
  const guard = await acquireAdvisoryGuard(lockPath);
  const ownerProbe = probeProcess(process.pid);
  if (ownerProbe.state !== 'live') {
    await guard.release();
    throw new Error('Current E2E lifecycle process identity is ambiguous');
  }
  let record: LifecycleLockRecord = {
    version: 1,
    owner: {
      pid: process.pid,
      startIdentity: ownerProbe.identity.startIdentity,
      token: randomBytes(32).toString('hex'),
    },
    run: null,
    processGroups: [],
  };
  try {
    createLockRecord(lockPath, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await guard.release();
      throw error;
    }
    try {
      await recoverStaleLifecycle(lockPath, readLockRecord(lockPath), recoverRun);
      createLockRecord(lockPath, record);
    } catch (recoveryError) {
      await guard.release();
      if (
        recoveryError instanceof Error &&
        (recoveryError.message.includes('already running') ||
          recoveryError.message.includes('Refusing'))
      ) {
        throw recoveryError;
      }
      throw new Error('Refusing to recover an invalid E2E lifecycle lock record', {
        cause: recoveryError,
      });
    }
  }
  let released = false;
  const save = (next: LifecycleLockRecord) => {
    if (released) throw new Error('E2E lifecycle lock has already been released');
    const installed = readLockRecord(lockPath);
    if (
      installed.owner.pid !== record.owner.pid ||
      installed.owner.startIdentity !== record.owner.startIdentity ||
      installed.owner.token !== record.owner.token
    ) {
      throw new Error('Refusing to replace an E2E lifecycle lock owned by another process');
    }
    replaceLockRecord(lockPath, next);
    record = next;
  };
  return Object.freeze({
    path: lockPath,
    registerRun: (run: LifecycleRunRegistration) => {
      if (record.run !== null) throw new Error('E2E lifecycle run is already registered');
      save({ ...record, run: { root: run.root, markerToken: run.markerToken } });
    },
    registerProcessGroup: (pid: number): ProcessGroupIdentity => {
      const processProbe = probeProcess(pid);
      if (
        processProbe.state !== 'live' ||
        processProbe.identity.processGroupId !== pid ||
        pid < 2
      ) {
        throw new Error('Cannot register an unverified E2E child process group');
      }
      const group = { pid, startIdentity: processProbe.identity.startIdentity };
      if (record.processGroups.some((candidate) => candidate.pid === pid)) {
        throw new Error('E2E child process group is already registered');
      }
      save({ ...record, processGroups: [...record.processGroups, group] });
      return group;
    },
    unregisterProcessGroup: async (group: ProcessGroupIdentity) => {
      const next = record.processGroups.filter(
        (candidate) =>
          candidate.pid !== group.pid || candidate.startIdentity !== group.startIdentity
      );
      if (next.length === record.processGroups.length) {
        throw new Error('E2E child process group is not registered by this lifecycle');
      }
      if (!(await waitForProcessGroupToEmpty(group.pid, 1_000))) {
        throw new Error('Refusing to unregister a nonempty E2E child process group');
      }
      save({ ...record, processGroups: next });
    },
    clearRun: (run: LifecycleRunRegistration) => {
      if (record.run?.root !== run.root || record.run.markerToken !== run.markerToken) {
        throw new Error('E2E lifecycle run is not registered by this lock');
      }
      save({ ...record, run: null });
    },
    release: async (preserveRecord = false) => {
      if (released) return;
      let releaseError: unknown;
      try {
        if (!preserveRecord) {
          const installed = readLockRecord(lockPath);
          if (
            installed.owner.pid !== record.owner.pid ||
            installed.owner.startIdentity !== record.owner.startIdentity ||
            installed.owner.token !== record.owner.token
          ) {
            throw new Error('Refusing to release an E2E lifecycle lock owned by another process');
          }
          rmSync(lockPath, { force: false });
          syncParent(lockPath);
        }
      } catch (error) {
        releaseError = error;
      } finally {
        released = true;
        try {
          await guard.release();
        } catch (guardError) {
          releaseError = releaseError
            ? new AggregateError([releaseError, guardError], 'E2E lifecycle lock release failed')
            : guardError;
        }
      }
      if (releaseError) throw releaseError;
    },
  });
}
