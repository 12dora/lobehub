import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  type ClusterRuntimeCommand,
  type ClusterRuntimeMessage,
  type ClusterRuntimeValue,
  isClusterRuntimeMessage,
} from './protocol';

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: ClusterRuntimeValue) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClusterProcessHarnessOptions {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  outputLimitBytes?: number;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface ClusterProcessDiagnostics {
  observedBytes: number;
  truncated: boolean;
}

const sanitizedError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

/** Diagnostic text is never returned by the harness, but retained text is still redacted. */
export const redactClusterDiagnostic = (input: string): string =>
  input
    .replaceAll(/(?:postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi, '[connection-redacted]')
    .replaceAll(/pinst_[a-f0-9]{48}/gi, '[instance-redacted]')
    .replaceAll(/\b(?:pid|ppid|port)\s*[=:]\s*\d+\b/gi, '[process-redacted]')
    .replaceAll(/:\d{2,5}\b/g, ':[port-redacted]')
    .replaceAll(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_PROTOCOL_LINE_BYTES);

const waitForExit = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export class ClusterProcessHarness {
  private child: ChildProcessWithoutNullStreams | null = null;
  private diagnosticsBytes = 0;
  private diagnosticsText = '';
  private diagnosticsTruncated = false;
  private nextRequestId = 1;
  private readonly outputLimitBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private resolveReady: (() => void) | null = null;
  private stdoutBuffer = '';
  private stdoutBytes = 0;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: ClusterProcessHarnessOptions) {
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  private failPending = (error: Error): void => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  };

  private handleMessage = (message: ClusterRuntimeMessage): void => {
    if (message.type === 'ready') {
      this.resolveReady?.();
      this.resolveReady = null;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (!message.ok || !message.value) {
      pending.reject(sanitizedError('ClusterRuntimeCommandFailed'));
      return;
    }
    pending.resolve(message.value);
  };

  private handleStdout = (chunk: Buffer): void => {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.outputLimitBytes) {
      this.diagnosticsTruncated = true;
      this.failPending(sanitizedError('ClusterRuntimeOutputLimitExceeded'));
      void this.terminate();
      return;
    }
    this.stdoutBuffer += chunk.toString('utf8');
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
        this.failPending(sanitizedError('ClusterRuntimeProtocolViolation'));
        void this.terminate();
        return;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isClusterRuntimeMessage(parsed))
          throw sanitizedError('ClusterRuntimeProtocolViolation');
        this.handleMessage(parsed);
      } catch {
        this.failPending(sanitizedError('ClusterRuntimeProtocolViolation'));
        void this.terminate();
        return;
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  };

  private handleStderr = (chunk: Buffer): void => {
    this.diagnosticsBytes += chunk.length;
    if (this.diagnosticsBytes > this.outputLimitBytes) {
      this.diagnosticsTruncated = true;
      this.failPending(sanitizedError('ClusterRuntimeOutputLimitExceeded'));
      void this.terminate();
      return;
    }
    const remaining = this.outputLimitBytes - Buffer.byteLength(this.diagnosticsText);
    if (remaining <= 0) {
      this.diagnosticsTruncated = true;
      return;
    }
    const sanitized = redactClusterDiagnostic(chunk.toString('utf8'));
    this.diagnosticsText += sanitized.slice(0, remaining);
    if (sanitized.length > remaining) this.diagnosticsTruncated = true;
  };

  getDiagnostics = (): ClusterProcessDiagnostics => ({
    observedBytes: this.stdoutBytes + this.diagnosticsBytes,
    truncated: this.diagnosticsTruncated,
  });

  isRunning = (): boolean =>
    Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);

  start = async (): Promise<void> => {
    if (this.child) throw sanitizedError('ClusterRuntimeAlreadyStarted');
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      detached: true,
      // The app augments ProcessEnv with required browser flags; this harness intentionally
      // forwards only an explicit allowlist instead of inheriting unrelated process secrets.
      env: this.options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', this.handleStdout);
    child.stderr.on('data', this.handleStderr);
    child.once('exit', () => {
      this.failPending(sanitizedError('ClusterRuntimeExited'));
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.resolveReady = resolve;
          child.once('error', () => reject(sanitizedError('ClusterRuntimeSpawnFailed')));
          child.once('exit', () => reject(sanitizedError('ClusterRuntimeExitedBeforeReady')));
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(sanitizedError('ClusterRuntimeStartTimeout')),
            this.startTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      await this.terminate();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.resolveReady = null;
    }
  };

  request = async (type: ClusterRuntimeCommand): Promise<ClusterRuntimeValue> => {
    const child = this.child;
    if (!child || !this.isRunning()) throw sanitizedError('ClusterRuntimeNotRunning');
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<ClusterRuntimeValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(sanitizedError('ClusterRuntimeRequestTimeout'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { reject, resolve, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, type })}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(sanitizedError('ClusterRuntimeWriteFailed'));
    });
    return response;
  };

  shutdown = async (): Promise<void> => {
    const child = this.child;
    if (!child || !this.isRunning()) return;
    const response = await this.request('shutdown');
    if (response.kind !== 'shutdown') throw sanitizedError('ClusterRuntimeProtocolViolation');
    child.stdin.end();
    if (!(await waitForExit(child, this.stopTimeoutMs))) {
      await this.terminate();
      throw sanitizedError('ClusterRuntimeGracefulShutdownTimeout');
    }
  };

  terminate = async (): Promise<void> => {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (!pid) {
      await waitForExit(child, this.stopTimeoutMs);
      return;
    }
    child.stdin.destroy();
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw sanitizedError('ClusterRuntimeTerminateFailed');
      }
    }
    if (await waitForExit(child, this.stopTimeoutMs)) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw sanitizedError('ClusterRuntimeKillFailed');
      }
    }
    if (!(await waitForExit(child, this.stopTimeoutMs))) {
      throw sanitizedError('ClusterRuntimeCleanupTimeout');
    }
  };
}
