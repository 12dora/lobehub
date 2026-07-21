/**
 * Bounded, shell-free subprocess runner for security-acceptance adapters.
 */
import { spawn } from 'node:child_process';

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

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const budget = { remaining: MAX_PROCESS_OUTPUT_BYTES, truncated: false };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (child.stdout) collectBounded(child.stdout, budget, stdoutChunks);
    if (child.stderr) collectBounded(child.stderr, budget, stderrChunks);

    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 1_000).unref();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        outputTruncated: budget.truncated,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    });
  });

/**
 * Extract the first top-level JSON object from mixed tool output (pnpm may print warnings).
 */
export const extractFirstJsonObject = (source: string): unknown => {
  const start = source.indexOf('{');
  if (start < 0) {
    throw new Error('No JSON object found in process output');
  }
  // Walk braces; strings may contain braces — use a simple state machine.
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
