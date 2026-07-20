/**
 * Owned Docker containers + process-group lifecycle with fault-safe cleanup.
 * Only removes resources labeled with this run's ownership token.
 */
import { type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface OwnedContainer {
  /** Full Docker container id (sha). */
  id: string;
  label: string;
  name: string;
}

export interface LifecycleState {
  containers: OwnedContainer[];
  processes: ChildProcess[];
  runToken: string;
}

export const createRunToken = (): string =>
  `e2e-admin-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createLifecycleState = (runToken: string): LifecycleState => ({
  containers: [],
  processes: [],
  runToken,
});

export const startOwnedContainer = async (input: {
  args: string[];
  image: string;
  name: string;
  runToken: string;
  state: LifecycleState;
}): Promise<OwnedContainer> => {
  const label = `lobehub.e2e.run=${input.runToken}`;
  const { stdout } = await execute('docker', [
    'run',
    '--detach',
    '--name',
    input.name,
    '--label',
    label,
    '--label',
    'lobehub.e2e.suite=enterprise-admin',
    ...input.args,
    input.image,
  ]);
  const id = stdout.trim();
  if (!id) throw new Error(`docker run returned empty id for ${input.name}`);
  const owned: OwnedContainer = { id, label, name: input.name };
  input.state.containers.push(owned);
  return owned;
};

export const registerProcess = (state: LifecycleState, child: ChildProcess): void => {
  state.processes.push(child);
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

export const removeOwnedContainer = async (container: OwnedContainer): Promise<void> => {
  // Only remove if label still matches ownership (never delete foreign containers).
  try {
    const { stdout } = await execute('docker', [
      'inspect',
      '-f',
      '{{index .Config.Labels "lobehub.e2e.run"}}',
      container.id,
    ]);
    const label = stdout.trim();
    if (label && label !== container.label.replace('lobehub.e2e.run=', '')) {
      throw new Error(
        `refusing to remove container ${container.id}: ownership label mismatch (${label})`,
      );
    }
  } catch (error) {
    // Missing container is fine during cleanup.
    if (String(error).includes('No such object') || String(error).includes('No such container')) {
      return;
    }
    // inspect may fail if already removed
  }
  await execute('docker', ['rm', '--force', container.id]).catch(() => undefined);
};

/**
 * Stop every process and container owned by this lifecycle state.
 * Safe to call multiple times; errors are collected and rethrown as AggregateError.
 */
export const cleanupLifecycle = async (state: LifecycleState): Promise<void> => {
  const failures: unknown[] = [];

  for (const child of [...state.processes].reverse()) {
    try {
      await killProcessGroup(child);
    } catch (error) {
      failures.push(error);
    }
  }
  state.processes.length = 0;

  for (const container of [...state.containers].reverse()) {
    try {
      await removeOwnedContainer(container);
    } catch (error) {
      failures.push(error);
    }
  }
  state.containers.length = 0;

  // Sweep any leftover containers with this exact run token (orphans from partial id capture).
  try {
    const { stdout } = await execute('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=lobehub.e2e.run=${state.runToken}`,
    ]);
    for (const id of stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await execute('docker', ['rm', '--force', id]).catch((error) => failures.push(error));
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'lifecycle cleanup failed');
  }
};
