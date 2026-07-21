/**
 * Bounded, shell-free subprocess runner with process-tree timeout kill.
 *
 * On timeout (POSIX):
 * 1. Snapshot PID/PPID table and collect all descendants of the spawned root.
 * 2. SIGTERM every owned PID and their process groups (never 0/1/self).
 * 3. After grace, SIGKILL remaining; rescan until empty or hard cleanup deadline.
 * 4. Resolve only after descendants are confirmed gone (or cleanupFailed).
 *
 * Discovery/permission uncertainty is fail-closed: never treat a failed snapshot
 * or EPERM existence probe as “nothing remains.”
 *
 * Parent process `close` does not cancel escalation — cleanup runs to completion.
 */
import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES } from './constants';

const execFileAsync = promisify(execFile);

export interface ProcessResult {
  /**
   * True when a timeout path could not confirm all owned descendants exited.
   * Callers must treat this as unavailable / fail-closed, not a clean timeout.
   */
  cleanupFailed: boolean;
  code: number;
  /** True when stdout/stderr capture hit the byte budget. */
  outputTruncated: boolean;
  stderr: string;
  stdout: string;
  /** True when the process was killed due to timeout. */
  timedOut: boolean;
}

export type ProcessRunner = (
  argv: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface RunProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable existence probe (tests). */
  probeExistence?: PidExistenceProbe;
  /** Injectable PID table snapshot (tests). */
  snapshotPidTable?: PidTableSnapshotter;
  timeoutMs?: number;
}

/** Grace after SIGTERM before SIGKILL (ms). */
export const PROCESS_KILL_GRACE_MS = 1_000;
/** Max time after timeout for recursive cleanup before cleanupFailed (ms). */
export const PROCESS_CLEANUP_DEADLINE_MS = 4_000;
/** Poll interval while waiting for descendants to exit (ms). */
export const PROCESS_CLEANUP_POLL_MS = 50;

/** Child with stdin ignored and stdout/stderr piped. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

/** Existence semantics: only `absent` is proven nonexistence (ESRCH). */
export type PidExistence = 'alive' | 'absent' | 'unconfirmed';

export type PidExistenceProbe = (pid: number) => PidExistence;

export type PidTableSnapshot =
  { map: Map<number, number>; ok: true } | { ok: false; reason: string };

export type PidTableSnapshotter = () => Promise<PidTableSnapshot>;

const collectBounded = (
  stream: Readable,
  budget: { remaining: number; truncated: boolean },
  chunks: Buffer[],
) => {
  stream.on('data', (chunk: Buffer) => {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return;
    }
    if (chunk.byteLength <= budget.remaining) {
      chunks.push(chunk);
      budget.remaining -= chunk.byteLength;
      return;
    }
    chunks.push(chunk.subarray(0, budget.remaining));
    budget.remaining = 0;
    budget.truncated = true;
  });
};

const isProtectedPid = (pid: number): boolean =>
  !Number.isInteger(pid) || pid <= 1 || pid === process.pid;

/**
 * Probe whether a PID exists.
 * - alive: kill(pid,0) succeeded
 * - absent: ESRCH only
 * - unconfirmed: EPERM and all other errors (fail-closed: treat as still present)
 */
export const probePidExistence: PidExistenceProbe = (pid) => {
  if (isProtectedPid(pid)) return 'absent';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'ESRCH') return 'absent';
    return 'unconfirmed';
  }
};

/** True when process is not proven absent (alive or unconfirmed). */
export const processExists = (pid: number): boolean => probePidExistence(pid) !== 'absent';

/** True only when ESRCH proves the process is gone. */
export const isProcessAbsent = (pid: number): boolean => probePidExistence(pid) === 'absent';

/**
 * Strict parse of `ps -axo pid=,ppid=` style output.
 * Blank lines are ignored. Any other non-conforming row fails the whole snapshot.
 * Never silently skips malformed rows.
 */
export const parsePidPpidTable = (stdout: string): PidTableSnapshot => {
  const map = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    // Preserve exact line (including trailing spaces) for malformation detection.
    if (line.length === 0) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Exactly two whitespace-separated integer fields; no headers, no extras.
    // Exactly two non-negative integer fields; reject headers and partial rows.
    if (!/^\d+\s+\d+$/u.test(trimmed)) {
      return { ok: false, reason: 'malformed-row' };
    }
    const parts = trimmed.split(/\s+/u);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid < 0) {
      return { ok: false, reason: 'invalid-pid-ppid' };
    }
    if (map.has(pid)) {
      const previous = map.get(pid)!;
      if (previous !== ppid) {
        return { ok: false, reason: 'duplicate-inconsistent-pid' };
      }
      // Exact duplicate of same pid→ppid is inconsistent/incomplete output.
      return { ok: false, reason: 'duplicate-pid' };
    }
    map.set(pid, ppid);
  }
  if (map.size === 0) {
    return { ok: false, reason: 'empty-snapshot' };
  }
  return { map, ok: true };
};

/**
 * Completeness relative to owned/known PIDs and existence probes.
 * Still-present owned PIDs must appear in the table; empty/ok maps never prove
 * success while ownership still requires verification.
 */
export const validateSnapshotCompleteness = (
  snapshot: PidTableSnapshot,
  ownedPids: ReadonlySet<number>,
  probe: PidExistenceProbe,
): PidTableSnapshot => {
  if (!snapshot.ok) return snapshot;
  for (const pid of ownedPids) {
    if (isProtectedPid(pid)) continue;
    const state = probe(pid);
    if (state === 'absent') continue;
    // alive or unconfirmed owned PID must be listed — empty map cannot satisfy this.
    if (!snapshot.map.has(pid)) {
      return { ok: false, reason: 'owned-pid-missing-from-snapshot' };
    }
  }
  return snapshot;
};

/**
 * Build a PID table snapshotter. Optional `env` supports PATH=/definitely-not-real
 * style discovery-unavailable regressions without privileged execution.
 * Failures and empty/malformed tables are explicit `ok: false` — never empty-success.
 */
export const makeSnapshotPidPpid =
  (env?: NodeJS.ProcessEnv): PidTableSnapshotter =>
  async () => {
    if (process.platform === 'win32') {
      // Windows path uses taskkill; table discovery is not used for confirmation.
      // Empty ok:true is only for the unused win32 table path; termination validates probes.
      return { map: new Map(), ok: true };
    }
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
        env: env ?? process.env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5_000,
      });
      return parsePidPpidTable(stdout);
    } catch {
      return { ok: false, reason: 'snapshot-unavailable' };
    }
  };

/** Default snapshotter using the current process environment. */
export const snapshotPidPpid: PidTableSnapshotter = makeSnapshotPidPpid();

/**
 * Collect all descendants of rootPid (not including root) via BFS on PPID edges.
 */
export const collectDescendantPids = (
  rootPid: number,
  pidToPpid: Map<number, number>,
): number[] => {
  if (isProtectedPid(rootPid)) return [];
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, ppid] of pidToPpid) {
    if (isProtectedPid(pid)) continue;
    const list = childrenByParent.get(ppid) ?? [];
    list.push(pid);
    childrenByParent.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child) || isProtectedPid(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
};

const signalPid = (pid: number, signal: NodeJS.Signals): void => {
  if (isProtectedPid(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // gone or not permitted — still tracked via existence probe
  }
};

const signalProcessGroup = (pgid: number, signal: NodeJS.Signals): void => {
  if (isProtectedPid(pgid)) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // group may not exist
  }
};

export interface TerminateProcessTreeOptions {
  deadlineMs?: number;
  graceMs?: number;
  probeExistence?: PidExistenceProbe;
  snapshotPidTable?: PidTableSnapshotter;
}

/**
 * Terminate root + full descendant tree. Rescans until empty or deadline.
 * Tracks known PIDs across waves so reparented grandchildren remain kill targets.
 * Discovery/permission uncertainty → cleanupFailed: true.
 */
export const terminateProcessTree = async (
  rootPid: number,
  options?: TerminateProcessTreeOptions,
): Promise<{ cleanupFailed: boolean; remaining: number[] }> => {
  const deadlineMs = options?.deadlineMs ?? PROCESS_CLEANUP_DEADLINE_MS;
  const graceMs = options?.graceMs ?? PROCESS_KILL_GRACE_MS;
  const probe = options?.probeExistence ?? probePidExistence;
  const snapshot = options?.snapshotPidTable ?? snapshotPidPpid;
  const started = Date.now();

  if (isProtectedPid(rootPid)) {
    return { cleanupFailed: true, remaining: [] };
  }

  const known = new Set<number>([rootPid]);
  let discoveryFailed = false;
  /** At least one complete snapshot accepted while ownership was still under verification. */
  let hadCompleteSnapshot = false;

  const stillPresent = (pid: number): boolean => {
    const state = probe(pid);
    return state === 'alive' || state === 'unconfirmed';
  };

  const refreshKnown = async (): Promise<void> => {
    const raw = await snapshot();
    // Re-validate at the termination boundary (covers injected/custom snapshotters).
    const table = validateSnapshotCompleteness(raw, known, probe);
    if (!table.ok) {
      discoveryFailed = true;
      return;
    }
    hadCompleteSnapshot = true;
    const seeds = [...known].filter((pid) => stillPresent(pid));
    if (stillPresent(rootPid) && !seeds.includes(rootPid)) seeds.push(rootPid);
    for (const seed of seeds.length > 0 ? seeds : [rootPid]) {
      for (const pid of collectDescendantPids(seed, table.map)) {
        if (!isProtectedPid(pid)) known.add(pid);
      }
    }
    for (const [pid, ppid] of table.map) {
      if (!isProtectedPid(pid) && known.has(ppid)) known.add(pid);
    }
    // After expansion, re-check completeness against the enlarged owned set.
    const complete = validateSnapshotCompleteness(table, known, probe);
    if (!complete.ok) {
      discoveryFailed = true;
    }
  };

  /**
   * Cleanup success requires: every owned PID proven absent via ESRCH-class probe,
   * and at least one complete trusted snapshot was observed (never empty-map success alone).
   */
  const signalKnown = (signal: NodeJS.Signals): void => {
    for (const pid of known) {
      if (isProtectedPid(pid)) continue;
      signalPid(pid, signal);
      signalProcessGroup(pid, signal);
    }
  };

  const presentKnown = (): number[] =>
    [...known].filter((pid) => !isProtectedPid(pid) && stillPresent(pid));

  const canDeclareCleanupSuccess = (): boolean => {
    if (discoveryFailed || !hadCompleteSnapshot) return false;
    return presentKnown().length === 0;
  };

  // Initial snapshot while the tree is still intact when possible.
  await refreshKnown();
  // Even if discovery failed, still attempt to signal the root and its group.
  signalKnown('SIGTERM');

  if (discoveryFailed) {
    // Fail closed after bounded TERM/KILL attempts on known set (at least root).
    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline && Date.now() - started < deadlineMs) {
      signalKnown('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
    }
    while (Date.now() - started < deadlineMs) {
      signalKnown('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
      if (presentKnown().length === 0) break;
    }
    return { cleanupFailed: true, remaining: presentKnown() };
  }

  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline && Date.now() - started < deadlineMs) {
    await refreshKnown();
    if (discoveryFailed) {
      signalKnown('SIGKILL');
      return { cleanupFailed: true, remaining: presentKnown() };
    }
    if (canDeclareCleanupSuccess()) return { cleanupFailed: false, remaining: [] };
    signalKnown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
  }

  while (Date.now() - started < deadlineMs) {
    await refreshKnown();
    if (discoveryFailed) {
      signalKnown('SIGKILL');
      return { cleanupFailed: true, remaining: presentKnown() };
    }
    if (canDeclareCleanupSuccess()) return { cleanupFailed: false, remaining: [] };
    signalKnown('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
  }

  await refreshKnown();
  const remaining = presentKnown();
  return {
    cleanupFailed: !canDeclareCleanupSuccess() || remaining.length > 0,
    remaining,
  };
};

const terminateWindowsTree = (pid: number): void => {
  if (isProtectedPid(pid)) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
    });
  } catch {
    // best effort
  }
};

/**
 * Spawn without shell. Captures stdout/stderr up to MAX_PROCESS_OUTPUT_BYTES total.
 */
export const runProcess: ProcessRunner = (argv, options) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error('Process argv is empty'));
      return;
    }

    const useProcessGroup = process.platform !== 'win32';
    const child: PipedChild = spawn(command, args, {
      cwd: options.cwd,
      detached: useProcessGroup,
      env: options.env ?? { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const budget = { remaining: MAX_PROCESS_OUTPUT_BYTES, truncated: false };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    collectBounded(child.stdout, budget, stdoutChunks);
    collectBounded(child.stderr, budget, stderrChunks);

    let timedOut = false;
    let settled = false;
    let cleanupFailed = false;
    let cleanupPromise: Promise<void> | undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    const rootPid = child.pid;
    const probe = options.probeExistence ?? probePidExistence;
    const snapshot = options.snapshotPidTable ?? snapshotPidPpid;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // ignore
      }
      resolve({
        cleanupFailed,
        code,
        outputTruncated: budget.truncated,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    };

    const runCleanup = async (): Promise<void> => {
      if (rootPid === undefined || isProtectedPid(rootPid)) {
        cleanupFailed = true;
        return;
      }
      if (process.platform === 'win32') {
        terminateWindowsTree(rootPid);
        await new Promise((r) => setTimeout(r, PROCESS_KILL_GRACE_MS));
        if (probe(rootPid) !== 'absent') {
          terminateWindowsTree(rootPid);
          await new Promise((r) => setTimeout(r, PROCESS_KILL_GRACE_MS));
        }
        // Only ESRCH-equivalent (absent) is clean; unconfirmed → cleanupFailed.
        cleanupFailed = probe(rootPid) !== 'absent';
        return;
      }
      const result = await terminateProcessTree(rootPid, {
        probeExistence: probe,
        snapshotPidTable: snapshot,
      });
      cleanupFailed = result.cleanupFailed;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupPromise = runCleanup();
      void cleanupPromise.then(() => {
        finish(codeFromChild(child) ?? 1);
      });
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const pending = cleanupPromise ?? runCleanup();
        void pending.then(() => {
          finish(code ?? 1);
        });
        return;
      }
      finish(code ?? 1);
    });
  });

const codeFromChild = (child: PipedChild): number | null => {
  if (typeof child.exitCode === 'number') return child.exitCode;
  if (child.signalCode) return 1;
  return null;
};

/**
 * Extract the first top-level JSON object from mixed tool output (pnpm may print warnings).
 */
export const extractFirstJsonObject = (source: string): unknown => {
  const start = source.indexOf('{');
  if (start < 0) {
    throw new Error('No JSON object found in process output');
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, i + 1)) as unknown;
      }
    }
  }
  throw new Error('Unterminated JSON object in process output');
};
