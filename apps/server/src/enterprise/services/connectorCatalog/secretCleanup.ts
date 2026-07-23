import debug from 'debug';

import type { ConnectorCatalogSecretStore, ConnectorSecretSlot } from './catalogTypes';

const log = debug('lobe-server:connector-secret-cleanup');

const SECRET_REVOKE_TIMEOUT_MS = 1000;
const SECRET_REVOKE_CONCURRENCY = 8;

export interface ConnectorSecretCleanupRef {
  connectorId: string;
  ref: string;
  slot: ConnectorSecretSlot;
}

/**
 * Refs that failed bounded revoke are remembered so opportunistic GC can retry
 * (process-local; survives until the next successful revoke or process restart).
 */
const pendingGcRetry = new Set<string>();

const cleanupKey = (cleanup: ConnectorSecretCleanupRef): string =>
  `${cleanup.connectorId}:${cleanup.slot}:${cleanup.ref}`;

export const getPendingConnectorSecretCleanupCountForTest = (): number => pendingGcRetry.size;

export const clearPendingConnectorSecretCleanupForTest = (): void => {
  pendingGcRetry.clear();
};

const revokeOne = async (
  secrets: ConnectorCatalogSecretStore,
  cleanup: ConnectorSecretCleanupRef,
): Promise<boolean> => {
  if (!secrets.revokeSecretRef) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secrets.revokeSecretRef(cleanup),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('secret revoke timeout')),
          SECRET_REVOKE_TIMEOUT_MS,
        );
      }),
    ]);
    pendingGcRetry.delete(cleanupKey(cleanup));
    return true;
  } catch (error) {
    pendingGcRetry.add(cleanupKey(cleanup));
    log(
      'best-effort revoke failed errorClass=%s slot=%s',
      error instanceof Error ? error.name : 'UnknownError',
      cleanup.slot,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** DB references must already be detached before this bounded cleanup runs. */
export const cleanupConnectorSecretRefs = async (
  secrets: ConnectorCatalogSecretStore,
  refs: ConnectorSecretCleanupRef[],
): Promise<void> => {
  const deduplicated = [
    ...new Map(refs.map((item) => [`${item.connectorId}:${item.slot}:${item.ref}`, item])).values(),
  ];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(SECRET_REVOKE_CONCURRENCY, deduplicated.length) },
    async () => {
      while (cursor < deduplicated.length) {
        const index = cursor;
        cursor += 1;
        const cleanup = deduplicated[index];
        if (cleanup) await revokeOne(secrets, cleanup);
      }
    },
  );
  await Promise.all(workers);
  // When immediate revoke fails, ask the store GC path to collect later.
  if (pendingGcRetry.size > 0 && secrets.garbageCollectOrphanedSecrets) {
    try {
      await secrets.garbageCollectOrphanedSecrets();
    } catch (error) {
      log(
        'deferred GC after failed revoke errorClass=%s',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }
};
