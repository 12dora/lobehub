const LEASE_TIMEOUT_GUARD_MS = 15_000;
const SIDECAR_CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export const SIDECAR_UNAVAILABLE = 'sidecar unavailable';

export const isSidecarConnectionError = (error: unknown, depth = 0): boolean => {
  if (!error || depth > 4) return false;
  if (typeof error !== 'object') return false;
  const rec = error as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
  // Worker abort (lease / job timeout) is not a sidecar outage.
  if (rec.name === 'AbortError') return false;
  if (typeof rec.code === 'string' && SIDECAR_CONNECTION_CODES.has(rec.code)) return true;
  if (typeof rec.message === 'string') {
    const message = rec.message.toLowerCase();
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('fetch failed') ||
      message.includes('timed out') ||
      message.includes('timeout')
    ) {
      return true;
    }
  }
  return isSidecarConnectionError(rec.cause, depth + 1);
};

export class RenderAbortedError extends Error {
  constructor(message = 'document render aborted') {
    super(message);
    this.name = 'RenderAbortedError';
  }
}

export class FileDeletedDuringRenderError extends RenderAbortedError {
  constructor() {
    super('file deleted during render');
    this.name = 'FileDeletedDuringRenderError';
  }
}

/** Sidecar down / unreachable — thrown after a retryable `jobs.fail` so the lane backs off. */
export class SidecarUnavailableError extends Error {
  constructor(message = SIDECAR_UNAVAILABLE) {
    super(message);
    this.name = 'SidecarUnavailableError';
  }
}

/** Clamp the per-job timeout so work always finishes at least 15s before the lease expires. */
export const clampJobTimeoutMs = (timeoutSec: number, leaseMs: number): number =>
  Math.max(0, Math.min(timeoutSec * 1000, leaseMs - LEASE_TIMEOUT_GUARD_MS));

export const heartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(1, Math.floor(leaseMs / 3));

export interface RenderControl {
  abortLease: () => void;
  assertLive: () => void;
  signal: AbortSignal;
}
