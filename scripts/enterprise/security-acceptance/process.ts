/**
 * Bounded, shell-free subprocess runner with process-tree timeout kill.
 *
 * On timeout (POSIX):
 * 1. Snapshot PID/PPID table and collect all descendants of the spawned root.
 * 2. SIGTERM every owned PID and their process groups (never 0/1/self).
 * 3. After grace, SIGKILL remaining; rescan until empty or hard cleanup deadline.
 * 4. Resolve only after descendants are confirmed gone (or cleanupFailed).
 *
 * Parent process `close` does not cancel escalation — cleanup runs to completion.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
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
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ProcessResult>;

/** Grace after SIGTERM before SIGKILL (ms). */
export const PROCESS_KILL_GRACE_MS = 1_000;
/** Max time after timeout for recursive cleanup before cleanupFailed (ms). */
export const PROCESS_CLEANUP_DEADLINE_MS = 4_000;
/** Poll interval while waiting for descendants to exit (ms). */
export const PROCESS_CLEANUP_POLL_MS = 50;

/** Child with stdin ignored and stdout/stderr piped. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

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

/** True when process.kill(pid, 0) succeeds (process exists and is signalable). */
export const processExists = (pid: number): boolean => {
  if (isProtectedPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Snapshot PID → PPID map via `ps` (POSIX). Empty map on failure.
 * Cross-platform fallback: empty (Windows uses taskkill /T).
 */
export const snapshotPidPpid = async (): Promise<Map<number, number>> => {
  const map = new Map<number, number>();
  if (process.platform === 'win32') return map;
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
    });
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/u);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
      map.set(pid, ppid);
    }
  } catch {
    // leave empty
  }
  return map;
};

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
    // gone or not permitted
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

/**
 * Terminate root + full descendant tree. Rescans until empty or deadline.
 * Tracks known PIDs across waves so reparented (init/PPID=1) grandchildren
 * remain kill targets after the intermediate parent dies.
 * Never signals PID 0/1 or the current process.
 */
export const terminateProcessTree = async (
  rootPid: number,
  options?: { deadlineMs?: number; graceMs?: number },
): Promise<{ cleanupFailed: boolean; remaining: number[] }> => {
  const deadlineMs = options?.deadlineMs ?? PROCESS_CLEANUP_DEADLINE_MS;
  const graceMs = options?.graceMs ?? PROCESS_KILL_GRACE_MS;
  const started = Date.now();

  if (isProtectedPid(rootPid)) {
    return { cleanupFailed: true, remaining: [] };
  }

  // Cumulative set of owned PIDs discovered at any scan (survives reparenting).
  const known = new Set<number>([rootPid]);

  const refreshKnown = async (): Promise<void> => {
    const table = await snapshotPidPpid();
    // Expand from every known PID still present, and from original root if alive.
    const seeds = [...known].filter((pid) => processExists(pid));
    if (processExists(rootPid) && !seeds.includes(rootPid)) seeds.push(rootPid);
    for (const seed of seeds.length > 0 ? seeds : [rootPid]) {
      for (const pid of collectDescendantPids(seed, table)) {
        if (!isProtectedPid(pid)) known.add(pid);
      }
    }
    // Also attach any process whose PPID is a known owned PID.
    for (const [pid, ppid] of table) {
      if (!isProtectedPid(pid) && known.has(ppid)) known.add(pid);
    }
  };

  const signalKnown = (signal: NodeJS.Signals): void => {
    for (const pid of known) {
      if (isProtectedPid(pid)) continue;
      signalPid(pid, signal);
      signalProcessGroup(pid, signal);
    }
  };

  const aliveKnown = (): number[] =>
    [...known].filter((pid) => !isProtectedPid(pid) && processExists(pid));

  // Initial snapshot while the tree is still intact when possible.
  await refreshKnown();
  signalKnown('SIGTERM');

  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline && Date.now() - started < deadlineMs) {
    await refreshKnown();
    if (aliveKnown().length === 0) return { cleanupFailed: false, remaining: [] };
    signalKnown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
  }

  while (Date.now() - started < deadlineMs) {
    await refreshKnown();
    const alive = aliveKnown();
    if (alive.length === 0) return { cleanupFailed: false, remaining: [] };
    signalKnown('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, PROCESS_CLEANUP_POLL_MS));
  }

  await refreshKnown();
  const remaining = aliveKnown();
  return { cleanupFailed: remaining.length > 0, remaining };
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
        // Brief wait then check root only (no portable descendant snapshot).
        await new Promise((r) => setTimeout(r, PROCESS_KILL_GRACE_MS));
        if (processExists(rootPid)) {
          terminateWindowsTree(rootPid);
          await new Promise((r) => setTimeout(r, PROCESS_KILL_GRACE_MS));
        }
        cleanupFailed = processExists(rootPid);
        return;
      }
      const result = await terminateProcessTree(rootPid);
      cleanupFailed = result.cleanupFailed;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Start cleanup immediately; do not cancel escalation when parent closes early.
      cleanupPromise = runCleanup();
      void cleanupPromise.then(() => {
        // Always settle after cleanup — even if parent handle is stuck.
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
        // Parent closed — still wait for full tree cleanup before resolving.
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
