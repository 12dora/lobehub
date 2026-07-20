/**
 * Owned Docker containers + process-group lifecycle with fault-safe cleanup.
 * Only removes resources labeled with this run's ownership token.
 * Ownership inspect failures (including label mismatch) never reach docker rm.
 */
import { type ChildProcess, execFile, spawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const RUN_LABEL_KEY = 'lobehub.e2e.run';
export const SUITE_LABEL = 'lobehub.e2e.suite=enterprise-admin';

export interface OwnedContainer {
  /** Full label value expected on the container (run token only). */
  expectedRunToken: string;
  /** Full Docker container id (sha). */
  id: string;
  name: string;
}

export interface LifecycleState {
  containers: OwnedContainer[];
  /** Owned temp dirs (e.g. isolated Next distDir) removed on cleanup. */
  ownedDirs: string[];
  /**
   * Hooks run BEFORE process/container teardown (e.g. DB CAS restore).
   * Single coordinated owner: signal handler awaits these then destroys resources.
   */
  preCleanupHooks: Array<() => Promise<void>>;
  processes: ChildProcess[];
  runToken: string;
  /** uninstall signal handlers when stop completes successfully */
  uninstallSignals?: () => void;
}

export const createRunToken = (): string =>
  `e2e-admin-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createLifecycleState = (runToken: string): LifecycleState => ({
  containers: [],
  ownedDirs: [],
  preCleanupHooks: [],
  processes: [],
  runToken,
});

export const registerPreCleanupHook = (state: LifecycleState, hook: () => Promise<void>): void => {
  state.preCleanupHooks.push(hook);
};

export const registerOwnedDir = (state: LifecycleState, dir: string): void => {
  if (!state.ownedDirs.includes(dir)) state.ownedDirs.push(dir);
};

const isDockerNotFoundError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
  const combined = `${msg}\n${stderr}`;
  return (
    combined.includes('No such object') ||
    combined.includes('No such container') ||
    /No such container/i.test(combined)
  );
};

/**
 * Install SIGINT/SIGTERM handlers that clean owned resources before exit.
 * Must be called before the first docker run / process spawn.
 */
/**
 * Single coordinated signal owner. Awaits preCleanupHooks (DB CAS) then resource teardown
 * before exit — never races competing async handlers.
 */
export const installLifecycleSignalHandlers = (state: LifecycleState): (() => void) => {
  let cleaning = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (cleaning) return;
    cleaning = true;
    void cleanupLifecycle(state)
      .catch((error) => {
        console.error('[lifecycle] signal cleanup failed', error);
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  const uninstall = () => {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  };
  state.uninstallSignals = uninstall;
  return uninstall;
};

export const startOwnedContainer = async (input: {
  args: string[];
  image: string;
  name: string;
  runToken: string;
  state: LifecycleState;
}): Promise<OwnedContainer> => {
  const label = `${RUN_LABEL_KEY}=${input.runToken}`;
  const { stdout } = await execute('docker', [
    'run',
    '--detach',
    '--name',
    input.name,
    '--label',
    label,
    '--label',
    SUITE_LABEL,
    ...input.args,
    input.image,
  ]);
  const id = stdout.trim();
  if (!id) throw new Error(`docker run returned empty id for ${input.name}`);
  const owned: OwnedContainer = { expectedRunToken: input.runToken, id, name: input.name };
  input.state.containers.push(owned);
  return owned;
};

/**
 * Read the published host port Docker assigned for a container port.
 * Used when publishing with `-p 127.0.0.1::CONTAINER_PORT` (ephemeral host port).
 */
export const inspectPublishedHostPort = async (
  containerId: string,
  containerPort: number,
): Promise<number> => {
  const { stdout } = await execute('docker', [
    'inspect',
    '-f',
    `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`,
    containerId,
  ]);
  const port = Number(stdout.trim());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `failed to resolve published host port for ${containerId}:${containerPort} (got ${stdout.trim()})`,
    );
  }
  return port;
};

export const registerProcess = (state: LifecycleState, child: ChildProcess): void => {
  state.processes.push(child);
};

/** Spawn a detached process group and register it for ownership cleanup. */
export const spawnOwned = (
  state: LifecycleState,
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess => {
  const child = spawn(command, args as string[], {
    ...options,
    detached: true,
  });
  registerProcess(state, child);
  return child;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const killProcessGroup = async (child: ChildProcess, timeoutMs = 8_000): Promise<void> => {
  if (!child.pid) return;
  const pid = child.pid;
  const waitExit = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  const timedOut = await Promise.race([
    waitExit.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // gone
      }
    }
    await Promise.race([waitExit, sleep(2_000)]);
  }
};

/**
 * Assert ownership via docker inspect, then force-remove.
 * Label mismatch and any non-not-found inspect error rethrow — never rm.
 */
export const removeOwnedContainer = async (container: OwnedContainer): Promise<void> => {
  let actualToken: string;
  try {
    const { stdout } = await execute('docker', [
      'inspect',
      '-f',
      `{{index .Config.Labels "${RUN_LABEL_KEY}"}}`,
      container.id,
    ]);
    actualToken = stdout.trim();
  } catch (error) {
    if (isDockerNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (actualToken !== container.expectedRunToken) {
    throw new Error(
      `refusing to remove container ${container.id}: ownership label mismatch (actual=${actualToken || '<empty>'}, expected=${container.expectedRunToken})`,
    );
  }

  await execute('docker', ['rm', '--force', container.id]);
};

/**
 * List container IDs currently labeled with this exact run token.
 */
export const listContainersByRunToken = async (runToken: string): Promise<string[]> => {
  const { stdout } = await execute('docker', [
    'ps',
    '-aq',
    '--filter',
    `label=${RUN_LABEL_KEY}=${runToken}`,
  ]);
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Stop every process and container owned by this lifecycle state.
 * Order: preCleanupHooks (DB CAS) → process groups → containers → owned dirs.
 * Safe to call multiple times; errors are collected and rethrown as AggregateError.
 */
export const cleanupLifecycle = async (state: LifecycleState): Promise<void> => {
  const failures: unknown[] = [];

  // 1) DB / durable restore first (must finish before destroying containers that host the DB).
  for (const hook of state.preCleanupHooks) {
    try {
      await hook();
    } catch (error) {
      failures.push(error);
    }
  }
  state.preCleanupHooks.length = 0;

  // 2) Process groups
  for (const child of [...state.processes].reverse()) {
    try {
      await killProcessGroup(child);
    } catch (error) {
      failures.push(error);
    }
  }
  state.processes.length = 0;

  // 3) Containers
  for (const container of [...state.containers].reverse()) {
    try {
      await removeOwnedContainer(container);
    } catch (error) {
      failures.push(error);
    }
  }
  state.containers.length = 0;

  // Sweep orphans labeled with this exact run token only.
  try {
    for (const id of await listContainersByRunToken(state.runToken)) {
      try {
        await removeOwnedContainer({
          expectedRunToken: state.runToken,
          id,
          name: id,
        });
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  }

  // 4) Owned temp dirs (isolated Next distDir etc.) — never touch global .next
  const { rm } = await import('node:fs/promises');
  for (const dir of [...state.ownedDirs].reverse()) {
    try {
      await rm(dir, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  state.ownedDirs.length = 0;

  state.uninstallSignals?.();
  state.uninstallSignals = undefined;

  if (failures.length > 0) {
    throw new AggregateError(failures, 'lifecycle cleanup failed');
  }
};

/** Hard assert: zero containers remain for this run token. */
export const assertNoOwnedContainersRemain = async (runToken: string): Promise<void> => {
  const leftover = await listContainersByRunToken(runToken);
  if (leftover.length > 0) {
    throw new Error(`owned containers still present for run=${runToken}: ${leftover.join(',')}`);
  }
};
