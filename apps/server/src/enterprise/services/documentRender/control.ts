const LEASE_TIMEOUT_GUARD_MS = 15_000;
const SIDECAR_CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  // Undici uses this code for TCP connection setup; response timeout codes are intentionally
  // omitted — by then the sidecar has answered and it is the conversion that is slow.
  'UND_ERR_CONNECT_TIMEOUT',
  // The socket died mid-response: undici rejects body consumption with `TypeError('terminated')`
  // whose cause carries this code. Headers arrived, so no timeout code is involved — without it
  // a sidecar that goes away mid-PDF is recorded as a failed document rather than an outage.
  'UND_ERR_SOCKET',
]);

export const SIDECAR_UNAVAILABLE = 'sidecar unavailable';

export const isSidecarConnectionError = (error: unknown, depth = 0): boolean => {
  if (!error || depth > 4) return false;
  if (typeof error !== 'object') return false;
  const rec = error as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
  // Worker abort (lease / job timeout) is not a sidecar outage.
  if (rec.name === 'AbortError' || rec.name === 'TimeoutError') return false;
  if (typeof rec.code === 'string' && SIDECAR_CONNECTION_CODES.has(rec.code)) return true;
  if (typeof rec.message === 'string') {
    const message = rec.message.toLowerCase();
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('fetch failed')
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
