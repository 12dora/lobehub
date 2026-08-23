import type { ConnectorRuntimeRateLimiter } from './runtimeAdapterTypes';

const DEFAULT_SHARED_RATE_LIMIT = 30;
const DEFAULT_SHARED_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_RATE_LIMIT_SCOPES = 10_000;

interface RateLimitEntry {
  count: number;
  windowStartedAt: number;
}

/** Process-local fast guard; callers can inject a distributed implementation. */
export class BoundedConnectorRuntimeRateLimiter implements ConnectorRuntimeRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly options: {
      clock?: () => number;
      maxEntries?: number;
      maxRequests?: number;
      windowMs?: number;
    } = {},
  ) {}

  consume = (scope: string): boolean => {
    const now = (this.options.clock ?? Date.now)();
    const windowMs = this.options.windowMs ?? DEFAULT_SHARED_RATE_WINDOW_MS;
    const maxRequests = this.options.maxRequests ?? DEFAULT_SHARED_RATE_LIMIT;
    const maxEntries = Math.min(
      this.options.maxEntries ?? DEFAULT_MAX_RATE_LIMIT_SCOPES,
      DEFAULT_MAX_RATE_LIMIT_SCOPES,
    );
    const existing = this.entries.get(scope);
    const entry =
      !existing || now - existing.windowStartedAt >= windowMs
        ? { count: 0, windowStartedAt: now }
        : existing;
    entry.count += 1;
    this.entries.delete(scope);
    this.entries.set(scope, entry);
    while (this.entries.size > Math.max(1, maxEntries)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.count <= Math.max(1, maxRequests);
  };
}
