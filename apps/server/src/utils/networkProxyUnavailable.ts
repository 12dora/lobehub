/**
 * OSS-safe fail-mode detection. Enterprise `egress/error.ts` re-exports the
 * same helpers; this copy must not import enterprise code (path-boundary).
 *
 * Recognised shapes:
 * - `NetworkProxyUnavailableError` (`name` / `errorType`)
 * - converted `AgentRuntimeError.chat` payload (`{ errorType, error }`)
 */

const PROXY_UNAVAILABLE_TYPE = 'PLATFORM_NETWORK_PROXY_UNAVAILABLE';

const payloadHasUnavailableType = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as { errorType?: unknown; error?: unknown; name?: unknown };
  if (record.errorType === PROXY_UNAVAILABLE_TYPE) return true;
  if (record.name === 'NetworkProxyUnavailableError') return true;
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as { errorType?: unknown; name?: unknown };
    return (
      nested.errorType === PROXY_UNAVAILABLE_TYPE || nested.name === 'NetworkProxyUnavailableError'
    );
  }
  return false;
};

export const isNetworkProxyUnavailableError = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (payloadHasUnavailableType(current)) return true;
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
