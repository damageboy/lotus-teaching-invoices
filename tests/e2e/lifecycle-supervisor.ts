import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPERVISOR_READY = 'LOTUS_E2E_PROCESS_GROUP_READY';
const SUPERVISOR_ACTIVATED = 'LOTUS_E2E_PROCESS_GROUP_ACTIVATED';
const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;

export interface GatedProcessGroup {
  readonly child: ChildProcess;
  waitUntilReady(): Promise<void>;
  activate(): Promise<void>;
  abort(): Promise<void>;
}

export interface GatedProcessGroupTestHooks {
  readonly monotonicNow?: () => number;
  readonly onSupervisorSpawned?: (child: ChildProcess) => void;
  readonly onProcessGroupRegistered?: (child: ChildProcess) => void;
  readonly onActivationWritten?: () => void;
  readonly supervisorBarrier?: 'beforeReady' | 'beforeActivated';
}

export interface GatedProcessGroupOptions extends Pick<SpawnOptions, 'cwd' | 'env'> {
  readonly stdio?: 'ignore' | 'inherit';
  readonly activationTimeoutMs?: number;
  readonly testHooks?: GatedProcessGroupTestHooks;
}

interface ProcessGroupMember {
  readonly pid: number;
  readonly processGroupId: number;
}

function listProcessGroupMembers(processGroupId: number): ProcessGroupMember[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr.trim() !== '') {
    throw new Error('E2E process group supervisor could not inspect its group');
  }
  const members: ProcessGroupMember[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) throw new Error('E2E process group supervisor received malformed process data');
    const pid = Number(match[1]);
    const candidateGroupId = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(candidateGroupId)) {
      throw new Error('E2E process group supervisor received invalid process data');
    }
    if (pid !== result.pid && candidateGroupId === processGroupId) {
      members.push({ pid, processGroupId: candidateGroupId });
    }
  }
  return members;
}

export function spawnGatedProcessGroupForRegistration(
  command: string,
  args: readonly string[],
  options: GatedProcessGroupOptions = {}
): GatedProcessGroup {
  const token = randomBytes(32).toString('hex');
  const commitToken = randomBytes(32).toString('hex');
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(activationTimeoutMs) ||
    activationTimeoutMs < 100 ||
    activationTimeoutMs > 60_000
  ) {
    throw new Error('E2E process group activation timeout is invalid');
  }
  const monotonicNow = options.testHooks?.monotonicNow ?? (() => performance.now());
  const startupStartedAt = monotonicNow();
  if (!Number.isFinite(startupStartedAt)) {
    throw new Error('E2E process group monotonic clock is invalid');
  }
  const startupDeadline = startupStartedAt + activationTimeoutMs;
  const stdio = options.stdio ?? 'ignore';
  const supervisorBarrier = options.testHooks?.supervisorBarrier ?? 'none';
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--supervise-process-group',
      token,
      commitToken,
      String(activationTimeoutMs),
      stdio,
      supervisorBarrier,
      command,
      JSON.stringify(args),
    ],
    {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', stdio === 'inherit' ? 'pipe' : 'ignore'],
    }
  );
  const protocol = child.stdout;
  if (!child.stdin || !protocol) {
    child.kill('SIGKILL');
    throw new Error('E2E process group supervisor protocol pipes are unavailable');
  }
  let ready = false;
  let activationAcknowledged = false;
  let startupComplete = false;
  let activationSent = false;
  let startupFailure: Error | undefined;
  let terminationPromise: Promise<void> | undefined;
  let output = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveActivated!: () => void;
  let rejectActivated!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const activatedPromise = new Promise<void>((resolve, reject) => {
    resolveActivated = resolve;
    rejectActivated = reject;
  });
  void readyPromise.catch(() => undefined);
  void activatedPromise.catch(() => undefined);
  const rejectPending = (error: Error) => {
    if (!ready) rejectReady(error);
    if (!activationAcknowledged) rejectActivated(error);
  };
  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  };
  const signalSupervisorGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const terminateSupervisor = (): Promise<void> => {
    terminationPromise ??= (async () => {
      if (!child.stdin!.destroyed && !child.stdin!.writableEnded) child.stdin!.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalSupervisorGroup('SIGTERM');
      if (process.platform !== 'win32') signalSupervisorGroup('SIGCONT');
      if (await waitForExit(250)) return;
      signalSupervisorGroup('SIGKILL');
      if (!(await waitForExit(750))) {
        throw new Error('Timed out terminating the E2E process group supervisor');
      }
    })();
    return terminationPromise;
  };
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const beginFailure = (error: Error, childAlreadyExited = false): void => {
    if (startupFailure || startupComplete) return;
    startupFailure = error;
    clearTimeout(deadlineTimer);
    if (childAlreadyExited) {
      rejectPending(error);
      return;
    }
    void terminateSupervisor().then(
      () => rejectPending(error),
      (terminationError: unknown) =>
        rejectPending(
          new AggregateError(
            [error, terminationError],
            'E2E process group supervisor startup and cleanup failed'
          )
        )
    );
  };
  const startupTimeoutError = () =>
    new Error(`E2E process group supervisor startup timed out after ${activationTimeoutMs}ms`);
  const deadlineExpired = (): boolean => {
    const current = monotonicNow();
    return !Number.isFinite(current) || current >= startupDeadline;
  };
  deadlineTimer = setTimeout(
    () => beginFailure(startupTimeoutError()),
    Math.max(0, startupDeadline - monotonicNow())
  );
  if (stdio === 'inherit') child.stderr?.pipe(process.stderr, { end: false });
  child.stdin.on('error', (error) =>
    beginFailure(new Error('E2E process group supervisor activation pipe failed', { cause: error }))
  );
  protocol.setEncoding('utf8');
  protocol.on('data', (chunk: Buffer | string) => {
    if (startupComplete) {
      if (stdio === 'inherit') process.stdout.write(chunk);
      return;
    }
    output += chunk.toString();
    if (output.length > 1_024) {
      beginFailure(new Error('E2E process group supervisor emitted an oversized protocol'));
      return;
    }
    const lines = output.split('\n');
    output = lines.pop() ?? '';
    for (const line of lines) {
      if (!startupFailure && !ready && line === `${SUPERVISOR_READY} ${child.pid} ${token}`) {
        if (deadlineExpired()) {
          beginFailure(startupTimeoutError());
          continue;
        }
        ready = true;
        resolveReady();
      } else if (
        !startupFailure &&
        ready &&
        activationSent &&
        !activationAcknowledged &&
        line === `${SUPERVISOR_ACTIVATED} ${child.pid} ${token}`
      ) {
        if (deadlineExpired()) {
          beginFailure(startupTimeoutError());
          continue;
        }
        activationAcknowledged = true;
        clearTimeout(deadlineTimer);
        resolveActivated();
      } else {
        beginFailure(new Error('E2E process group supervisor emitted an invalid protocol message'));
      }
    }
    if (startupComplete && output !== '') {
      if (stdio === 'inherit') process.stdout.write(output);
      output = '';
    }
  });
  child.once('error', (error) => {
    clearTimeout(deadlineTimer);
    beginFailure(new Error('E2E process group supervisor failed to start', { cause: error }), true);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(deadlineTimer);
    beginFailure(
      new Error(
        `E2E process group supervisor exited before activation with ${code ?? signal ?? 'unknown status'}`
      ),
      true
    );
  });
  try {
    options.testHooks?.onSupervisorSpawned?.(child);
  } catch (error) {
    beginFailure(new Error('E2E process group supervisor spawn hook failed', { cause: error }));
  }
  return Object.freeze({
    child,
    waitUntilReady: () => readyPromise,
    activate: async () => {
      if (activationSent) throw new Error('E2E process group supervisor was already activated');
      activationSent = true;
      await readyPromise;
      if (!startupFailure && deadlineExpired()) {
        beginFailure(startupTimeoutError());
      }
      if (startupFailure) throw startupFailure;
      child.stdin!.write(`${token}\n`);
      options.testHooks?.onActivationWritten?.();
      if (!startupFailure && deadlineExpired()) {
        beginFailure(startupTimeoutError());
      }
      if (startupFailure) throw startupFailure;
      await activatedPromise;
      if (startupFailure) throw startupFailure;
      child.stdin!.end(`${commitToken}\n`);
      startupComplete = true;
    },
    abort: async () => {
      if (!startupFailure && !startupComplete) {
        beginFailure(new Error('E2E process group supervisor startup was aborted'));
      }
      await terminateSupervisor();
    },
  });
}

function signalSupervisorMembers(signal: NodeJS.Signals): void {
  for (const member of listProcessGroupMembers(process.pid)) {
    if (member.pid === process.pid) continue;
    try {
      process.kill(member.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function runProcessGroupSupervisor(
  command: string,
  args: readonly string[],
  token: string,
  commitToken: string,
  activationTimeoutMs: number,
  stdio: 'ignore' | 'inherit',
  supervisorBarrier: 'none' | 'beforeReady' | 'beforeActivated'
): Promise<number> {
  if (!listProcessGroupMembers(process.pid).some((member) => member.pid === process.pid)) {
    throw new Error('E2E process group supervisor must be its own process group leader');
  }
  if (supervisorBarrier === 'beforeReady') process.kill(process.pid, 'SIGSTOP');
  writeSync(1, `${SUPERVISOR_READY} ${process.pid} ${token}\n`);
  const activatedAndCommitted = await new Promise<boolean>((resolve) => {
    let input = '';
    let activationAccepted = false;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.length > 1_024) {
        finish(false);
        return;
      }
      if (!activationAccepted) {
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        const activation = input.slice(0, newline + 1);
        input = input.slice(newline + 1);
        if (activation !== `${token}\n` || input !== '') {
          finish(false);
          return;
        }
        activationAccepted = true;
        if (supervisorBarrier === 'beforeActivated') process.kill(process.pid, 'SIGSTOP');
        try {
          writeSync(1, `${SUPERVISOR_ACTIVATED} ${process.pid} ${token}\n`);
        } catch {
          finish(false);
        }
        return;
      }
      if (!`${commitToken}\n`.startsWith(input)) finish(false);
    };
    const onEnd = () => finish(activationAccepted && input === `${commitToken}\n`);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), activationTimeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
  if (!activatedAndCommitted) return 74;
  let requestedSignal: NodeJS.Signals | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      requestedSignal ??= signal;
      try {
        signalSupervisorMembers(signal);
      } catch (error) {
        console.error('E2E process group supervisor could not forward a signal', error);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const child = spawn(command, [...args], { stdio });
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, error });
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal));
  });
  let emptySince: number | undefined;
  while (emptySince === undefined || Date.now() - emptySince < 250) {
    const hasOtherMembers = listProcessGroupMembers(process.pid).some(
      (member) => member.pid !== process.pid
    );
    emptySince = hasOtherMembers ? undefined : (emptySince ?? Date.now());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  if (requestedSignal === 'SIGINT') return 130;
  if (requestedSignal === 'SIGTERM') return 143;
  if (result.error) {
    console.error(`E2E supervised command failed to start: ${result.error.message}`);
    return 127;
  }
  if (result.code !== null) return result.code;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return 1;
}

const supervisorAttempt = process.argv.indexOf('--supervise-process-group');
if (supervisorAttempt >= 0) {
  const token = process.argv[supervisorAttempt + 1];
  const commitToken = process.argv[supervisorAttempt + 2];
  const rawActivationTimeout = process.argv[supervisorAttempt + 3];
  const stdio = process.argv[supervisorAttempt + 4];
  const supervisorBarrier = process.argv[supervisorAttempt + 5];
  const command = process.argv[supervisorAttempt + 6];
  const serializedArgs = process.argv[supervisorAttempt + 7];
  const activationTimeoutMs = Number(rawActivationTimeout);
  if (
    !token ||
    !/^[0-9a-f]{64}$/.test(token) ||
    !commitToken ||
    !/^[0-9a-f]{64}$/.test(commitToken) ||
    !Number.isSafeInteger(activationTimeoutMs) ||
    activationTimeoutMs < 100 ||
    activationTimeoutMs > 60_000 ||
    (stdio !== 'ignore' && stdio !== 'inherit') ||
    (supervisorBarrier !== 'none' &&
      supervisorBarrier !== 'beforeReady' &&
      supervisorBarrier !== 'beforeActivated') ||
    !command ||
    serializedArgs === undefined
  ) {
    throw new Error('--supervise-process-group received invalid activation arguments');
  }
  const args: unknown = JSON.parse(serializedArgs);
  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) {
    throw new Error('--supervise-process-group arguments must be a string array');
  }
  process.exit(
    await runProcessGroupSupervisor(
      command,
      args,
      token,
      commitToken,
      activationTimeoutMs,
      stdio,
      supervisorBarrier
    )
  );
}
