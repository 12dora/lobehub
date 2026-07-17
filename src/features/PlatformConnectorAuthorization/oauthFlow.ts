import type { ManagedConnectorBinding, UserConnectorAuthorizationStatusOutput } from './types';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type UnsuccessfulAuthorizationStatus =
  'cancelled' | 'dismissed' | 'expired' | 'failed' | 'invalid' | 'superseded' | 'timeout';

export type ManagedConnectorAuthorizationResult =
  | { binding: ManagedConnectorBinding; status: 'connected' }
  | { binding: null; status: UnsuccessfulAuthorizationStatus };

export interface WaitForManagedConnectorAuthorizationOptions {
  getStatus: () => Promise<UserConnectorAuthorizationStatusOutput>;
  now?: () => number;
  pollIntervalMs?: number;
  popup: Pick<Window, 'closed'>;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const sleepFor = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

class ConnectorAuthorizationPollingCancelledError extends Error {}

const awaitWithAbort = async <Value>(
  operation: () => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  if (signal?.aborted) throw new ConnectorAuthorizationPollingCancelledError();
  if (!signal) return operation();

  return new Promise<Value>((resolve, reject) => {
    const cancel = () => {
      cleanup();
      reject(new ConnectorAuthorizationPollingCancelledError());
    };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    operation().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};

/**
 * Managed OAuth callbacks deliberately return a no-script result page. The opener therefore
 * observes the server-owned attempt instead of trusting popup messages or a previous binding.
 */
export const waitForManagedConnectorAuthorization = async ({
  getStatus,
  popup,
  signal,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = sleepFor,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: WaitForManagedConnectorAuthorizationOptions): Promise<ManagedConnectorAuthorizationResult> => {
  const startedAt = now();

  try {
    while (now() - startedAt < timeoutMs) {
      const attempt = await awaitWithAbort(getStatus, signal);
      if (attempt.status === 'completed') {
        return attempt.binding?.status === 'connected'
          ? { binding: attempt.binding, status: 'connected' }
          : { binding: null, status: 'invalid' };
      }
      if (attempt.status !== 'pending') return { binding: null, status: attempt.status };
      if (popup.closed) return { binding: null, status: 'dismissed' };
      await awaitWithAbort(() => sleep(pollIntervalMs), signal);
    }
  } catch (error) {
    if (error instanceof ConnectorAuthorizationPollingCancelledError) {
      return { binding: null, status: 'cancelled' };
    }
    throw error;
  }

  return { binding: null, status: 'timeout' };
};
