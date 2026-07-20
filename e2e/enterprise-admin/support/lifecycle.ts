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

/**
 * Durable ownership of a detached process group — independent of live ChildProcess registry.
 * Cleanup authority: only these records (never foreign PGIDs).
 */
export interface OwnedProcessGroup {
  /** Leader pid at registration (detached spawn: equals pgid on POSIX). */
  leaderPid: number;
  /** Process group id to signal with kill(-pgid, …). */
  pgid: number;
  /** When this ownership was recorded (ms epoch) — lifetime bound for cleanup. */
  registeredAtMs: number;
  /** Provenance: only this run may clean this group. */
  runToken: string;
}

export interface LifecycleState {
  containers: OwnedContainer[];
  /** Observed descendant PIDs in owned process groups (subset of evidencePids). */
  evidenceDescendants: number[];
  /** Process group leaders (detached spawn parents). */
  evidenceLeaders: number[];
  /** Process group IDs (POSIX: leader pid when detached) — observational evidence. */
  evidencePgids: number[];
  /**
   * Read-only evidence: every owned parent PID + known descendants captured at spawn.
   * Observational only — cleanup authority is ownedProcessGroups.
   */
  evidencePids: number[];
  /** Owned temp dirs (e.g. isolated Next distDir) removed on cleanup. */
  ownedDirs: string[];
  /** Host ports this run held/probed (for residue assertions only). */
  ownedPorts: number[];
  /**
   * Durable owned process groups (cleanup authority). Survives leader exit.
   * Never kill a PGID not present here.
   */
  ownedProcessGroups: OwnedProcessGroup[];
  /**
   * Hooks run BEFORE process/container teardown (e.g. DB CAS restore).
   * Single coordinated owner: signal handler awaits these then destroys resources.
   */
  preCleanupHooks: Array<() => Promise<void>>;
  processes: ChildProcess[];
  runToken: string;
  /** True while suite-installed SIGINT/SIGTERM handlers are registered. */
  signalHandlersInstalled: boolean;
  /** listenerCount before suite handlers installed. */
  signalListenerBaseline: { SIGINT: number; SIGTERM: number };
  /** listenerCount after suite handlers installed. */
  signalListenerInstalled: { SIGINT: number; SIGTERM: number };
  /** uninstall signal handlers when stop completes successfully */
  uninstallSignals?: () => void;
}

/** Read-only snapshot of this run's owned resources (for fault-stage regressions). */
export interface LifecycleEvidence {
  containers: string[];
  evidenceDescendants: number[];
  evidenceLeaders: number[];
  evidencePgids: number[];
  evidencePids: number[];
  ownedDirs: string[];
  ownedPorts: number[];
  processRegistryPids: Array<number | undefined>;
  runToken: string;
  signalHandlersInstalled: boolean;
  signalListenerBaseline: { SIGINT: number; SIGTERM: number };
  signalListenerCurrent: { SIGINT: number; SIGTERM: number };
  signalListenerInstalled: { SIGINT: number; SIGTERM: number };
}

export const createRunToken = (): string =>
  `e2e-admin-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createLifecycleState = (runToken: string): LifecycleState => ({
  containers: [],
  evidenceDescendants: [],
  evidenceLeaders: [],
  evidencePgids: [],
  evidencePids: [],
  ownedDirs: [],
  ownedProcessGroups: [],
  ownedPorts: [],
  preCleanupHooks: [],
  processes: [],
  runToken,
  signalHandlersInstalled: false,
  signalListenerBaseline: { SIGINT: 0, SIGTERM: 0 },
  signalListenerInstalled: { SIGINT: 0, SIGTERM: 0 },
});

export const registerOwnedPort = (state: LifecycleState, port: number): void => {
  if (!state.ownedPorts.includes(port)) state.ownedPorts.push(port);
};

export const snapshotLifecycleEvidence = (state: LifecycleState): LifecycleEvidence => ({
  containers: state.containers.map((c) => c.id),
  evidenceDescendants: [...state.evidenceDescendants],
  evidenceLeaders: [...state.evidenceLeaders],
  evidencePgids: [...state.evidencePgids],
  evidencePids: [...state.evidencePids],
  ownedDirs: [...state.ownedDirs],
  ownedPorts: [...state.ownedPorts],
  processRegistryPids: state.processes.map((p) => p.pid),
  runToken: state.runToken,
  signalHandlersInstalled: state.signalHandlersInstalled,
  signalListenerBaseline: { ...state.signalListenerBaseline },
  signalListenerCurrent: {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  },
  signalListenerInstalled: { ...state.signalListenerInstalled },
});

/** True if any process remains in the owned process group (POSIX). */
export const isProcessGroupAlive = (pgid: number | undefined): boolean => {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Narrow scan of members of an owned process group (pgid).
 * - pgrep exit 1 → no matches (empty)
 * - ENOENT / permission / other tooling failures → verified `ps` fallback or fail loud
 * Never silently returns empty on tooling failure.
 */
/** Injectable exec for pgrep/ps — tests inject failures without bypassing production logic. */
export type ProcessEnumExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer }>;

let processEnumExec: ProcessEnumExec = async (file, args) => execute(file, args as string[]);

export const setProcessEnumExecForTests = (fn: ProcessEnumExec | null): void => {
  processEnumExec = fn ?? (async (file, args) => execute(file, args as string[]));
};

export const listPidsInProcessGroup = async (pgid: number): Promise<number[]> => {
  const parsePgrep = (stdout: string): number[] =>
    String(stdout)
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

  const viaPs = async (): Promise<number[]> => {
    const { stdout } = await processEnumExec('ps', ['-ax', '-o', 'pid=,pgid=']);
    const out: number[] = [];
    for (const line of String(stdout).split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const group = Number(parts[1]);
      if (group === pgid && Number.isFinite(pid) && pid > 0) out.push(pid);
    }
    return out;
  };

  try {
    const { stdout } = await processEnumExec('pgrep', ['-g', String(pgid)]);
    return parsePgrep(String(stdout));
  } catch (error: unknown) {
    const err = error as { code?: string | number; status?: number; errno?: string };
    // pgrep: exit status 1 means no process matched
    if (err?.code === 1 || err?.status === 1) {
      return [];
    }
    // Tooling failure (ENOENT, EACCES, etc.) — try portable ps filtered to exact PGID
    try {
      return await viaPs();
    } catch (psError) {
      throw new Error(
        `failed to enumerate process group ${pgid}: pgrep error=${String(error)}; ps fallback error=${String(psError)}`,
        { cause: psError },
      );
    }
  }
};

export const listPidsInProcessGroupForTests = listPidsInProcessGroup;

/** Refresh descendant/PGID evidence for a detached group leader while it may still be running. */
export const refreshOwnedProcessGroupEvidence = async (
  state: LifecycleState,
  leaderPid: number,
): Promise<void> => {
  const pgid = leaderPid; // detached spawn: leader is process group id
  if (!state.evidenceLeaders.includes(leaderPid)) state.evidenceLeaders.push(leaderPid);
  if (!state.evidencePgids.includes(pgid)) state.evidencePgids.push(pgid);
  if (!state.evidencePids.includes(leaderPid)) state.evidencePids.push(leaderPid);
  const members = await listPidsInProcessGroupForTests(pgid);
  for (const pid of members) {
    if (!state.evidencePids.includes(pid)) state.evidencePids.push(pid);
    if (pid !== leaderPid && !state.evidenceDescendants.includes(pid)) {
      state.evidenceDescendants.push(pid);
    }
  }
};

export const isPidAlive = (pid: number | undefined): boolean => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** True if any process is listening on 127.0.0.1:port (read-only check). */
export const isLocalPortListening = async (port: number): Promise<boolean> => {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(200);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
};

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
  state.signalListenerBaseline = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
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
  state.signalHandlersInstalled = true;
  state.signalListenerInstalled = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
  const uninstall = () => {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    state.signalHandlersInstalled = false;
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

/** Register durable ownership of a detached process group for this run. */
export const registerOwnedProcessGroup = (
  state: LifecycleState,
  leaderPid: number,
): OwnedProcessGroup => {
  const pgid = leaderPid; // detached spawn: leader is process group id on POSIX
  const existing = state.ownedProcessGroups.find((g) => g.pgid === pgid);
  if (existing) return existing;
  const rec: OwnedProcessGroup = {
    leaderPid,
    pgid,
    registeredAtMs: Date.now(),
    runToken: state.runToken,
  };
  state.ownedProcessGroups.push(rec);
  if (!state.evidencePids.includes(leaderPid)) state.evidencePids.push(leaderPid);
  if (!state.evidenceLeaders.includes(leaderPid)) state.evidenceLeaders.push(leaderPid);
  if (!state.evidencePgids.includes(pgid)) state.evidencePgids.push(pgid);
  return rec;
};

export const registerProcess = (state: LifecycleState, child: ChildProcess): void => {
  state.processes.push(child);
  const recordLeader = (pid: number) => {
    registerOwnedProcessGroup(state, pid);
    void refreshOwnedProcessGroupEvidence(state, pid);
  };
  if (child.pid) recordLeader(child.pid);
  // Detached group leader uses same pid as process group id on POSIX.
  child.once('spawn', () => {
    if (child.pid) recordLeader(child.pid);
  });
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

/**
 * Kill an exact owned process group by PGID (not by live ChildProcess).
 * SIGTERM → re-enumerate until empty or grace → SIGKILL exact PGID → recheck empty.
 * Fails loudly if enumeration fails or members remain after SIGKILL bound.
 */
export const killOwnedProcessGroupByPgid = async (
  pgid: number,
  options?: { graceMs?: number; killGraceMs?: number },
): Promise<void> => {
  if (!pgid || pgid <= 0) {
    throw new Error(`refusing to kill invalid pgid=${pgid}`);
  }
  const graceMs = options?.graceMs ?? 3_000;
  const killGraceMs = options?.killGraceMs ?? 2_000;

  const groupEmpty = async (): Promise<boolean> => {
    const members = await listPidsInProcessGroup(pgid);
    return members.length === 0;
  };

  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // group may already be gone
  }

  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline) {
    if (await groupEmpty()) return;
    await sleep(50);
  }

  // Members remain (including SIGTERM-ignoring descendants) — SIGKILL exact owned PGID.
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // may already be gone
  }

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (await groupEmpty()) return;
    await sleep(50);
  }

  const remaining = await listPidsInProcessGroup(pgid);
  if (remaining.length > 0) {
    throw new Error(
      `owned process group pgid=${pgid} still has members after SIGKILL: ${remaining.join(',')}`,
    );
  }
};

const killProcessGroup = async (child: ChildProcess, timeoutMs = 8_000): Promise<void> => {
  if (!child.pid) return;
  // Prefer durable PGID kill path (handles descendants after leader exit).
  await killOwnedProcessGroupByPgid(child.pid, { graceMs: timeoutMs, killGraceMs: 2_000 });
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

  // 2) Process groups — kill live ChildProcess handles, then ALL durable owned PGIDs
  // (survives leader exit / empty registry).
  for (const child of [...state.processes].reverse()) {
    try {
      if (child.pid) {
        await killOwnedProcessGroupByPgid(child.pid);
      } else {
        await killProcessGroup(child);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  state.processes.length = 0;

  // Durable owned groups (may include groups whose leaders already exited).
  for (const group of state.ownedProcessGroups) {
    if (group.runToken !== state.runToken) {
      failures.push(
        new Error(`refusing to kill process group pgid=${group.pgid}: runToken mismatch (foreign)`),
      );
      continue;
    }
    try {
      await killOwnedProcessGroupByPgid(group.pgid);
    } catch (error) {
      failures.push(error);
    }
  }
  state.ownedProcessGroups.length = 0;

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
  state.signalHandlersInstalled = false;
  state.ownedPorts.length = 0;
  // evidencePids retained for post-cleanup death assertions (read-only)

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
