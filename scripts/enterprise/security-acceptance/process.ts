/**
 * Bounded, shell-free subprocess runner with process-group timeout kill.
 * On timeout: SIGTERM the process group, then SIGKILL after grace, then hard settlement.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES } from './constants';

export interface ProcessResult {
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
/** Hard settlement after timeout even if stdio/children hang (ms). */
export const PROCESS_SETTLEMENT_MS = 2_000;

const collectBounded = (
  stream: NodeJS.ReadableStream,
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

const killProcessTree = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined) return;

  // POSIX: negative PID signals the process group when child was detached/group leader.
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to direct kill
    }
  }

  try {
    child.kill(signal);
  } catch {
    // already gone
  }

  // Windows fallback: taskkill tree
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
      });
    } catch {
      // best effort
    }
  }
};

/**
 * Spawn without shell. Captures stdout/stderr up to MAX_PROCESS_OUTPUT_BYTES total.
 * Uses a detached process group on POSIX so timeout can kill the full tree.
 */
export const runProcess: ProcessRunner = (argv, options) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error('Process argv is empty'));
      return;
    }

    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Detached + unref not for backgrounding — for process-group leadership on timeout kill.
      detached: useProcessGroup,
      env: options.env ?? { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const budget = { remaining: MAX_PROCESS_OUTPUT_BYTES, truncated: false };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (child.stdout) collectBounded(child.stdout, budget, stdoutChunks);
    if (child.stderr) collectBounded(child.stderr, budget, stderrChunks);

    let timedOut = false;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      // Destroy pipes so we do not hang on retained grandchildren stdio.
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      resolve({
        code,
        outputTruncated: budget.truncated,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    };

    let killTimer: ReturnType<typeof setTimeout>;
    let settleTimer: ReturnType<typeof setTimeout>;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL');
      }, PROCESS_KILL_GRACE_MS);
      killTimer.unref?.();
      // Hard settlement: do not wait forever for close if descendants retain pipes.
      settleTimer = setTimeout(() => {
        finish(codeFromChild(child) ?? 1);
      }, PROCESS_KILL_GRACE_MS + PROCESS_SETTLEMENT_MS);
      settleTimer.unref?.();
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer!);
      clearTimeout(settleTimer!);
      reject(error);
    });

    child.once('close', (code) => {
      finish(code ?? 1);
    });
  });

const codeFromChild = (child: ChildProcessWithoutNullStreams): number | null => {
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
