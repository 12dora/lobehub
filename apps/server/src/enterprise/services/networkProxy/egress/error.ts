import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

/**
 * Thrown when a scope is configured `onUnavailable: 'fail'` and the outlet is
 * down. Chat surfaces map `errorType` onto HTTP 503 + i18n copy.
 */
export class NetworkProxyUnavailableError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE;
  readonly errorType = PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE;

  constructor() {
    super(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE);
    this.name = 'NetworkProxyUnavailableError';
  }
}

/**
 * True for the dedicated Error class, its HTTP `errorType`, and the
 * AgentRuntimeError.chat conversion (`{ errorType, error: { errorType | name } }`).
 */
export const isNetworkProxyUnavailableError = (
  error: unknown,
): error is NetworkProxyUnavailableError => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof NetworkProxyUnavailableError) return true;
    const record = current as { name?: unknown; errorType?: unknown; error?: unknown };
    if (record.name === 'NetworkProxyUnavailableError') return true;
    if (record.errorType === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE) return true;
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as { errorType?: unknown; name?: unknown };
      if (
        nested.errorType === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE ||
        nested.name === 'NetworkProxyUnavailableError'
      ) {
        return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * First line of every catch that would otherwise swallow / remap a fail-mode
 * egress error into a "not found" / empty / DOWNLOAD_FAILED result.
 */
export function rethrowIfNetworkProxyUnavailable(error: unknown): void {
  if (isNetworkProxyUnavailableError(error)) throw error;
}
