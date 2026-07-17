import type { ManagedConnectorBinding } from './types';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type ManagedConnectorAuthorizationResult =
  | { binding: ManagedConnectorBinding; status: 'connected' }
  | { binding: ManagedConnectorBinding; status: 'error' }
  | { binding: ManagedConnectorBinding | null; status: 'dismissed' }
  | { binding: ManagedConnectorBinding | null; status: 'timeout' };

export interface WaitForManagedConnectorAuthorizationOptions {
  getStatus: () => Promise<ManagedConnectorBinding | null>;
  now?: () => number;
  pollIntervalMs?: number;
  popup: Pick<Window, 'closed'>;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const sleepFor = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/**
 * Managed OAuth callbacks deliberately return a no-script result page. The opener therefore
 * observes the server-owned binding instead of trusting a browser message from the popup.
 */
export const waitForManagedConnectorAuthorization = async ({
  getStatus,
  popup,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = sleepFor,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: WaitForManagedConnectorAuthorizationOptions): Promise<ManagedConnectorAuthorizationResult> => {
  const startedAt = now();
  let lastBinding: ManagedConnectorBinding | null = null;

  while (now() - startedAt < timeoutMs) {
    lastBinding = await getStatus();
    if (lastBinding?.status === 'connected') {
      return { binding: lastBinding, status: 'connected' };
    }
    if (lastBinding?.status === 'error' || lastBinding?.status === 'expired') {
      return { binding: lastBinding, status: 'error' };
    }
    if (popup.closed) {
      return { binding: lastBinding, status: 'dismissed' };
    }
    await sleep(pollIntervalMs);
  }

  return { binding: lastBinding, status: 'timeout' };
};
