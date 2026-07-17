import type { ConnectorCatalogSecretStore, ConnectorSecretSlot } from './catalogTypes';

const SECRET_REVOKE_TIMEOUT_MS = 1000;
const SECRET_REVOKE_CONCURRENCY = 8;

export interface ConnectorSecretCleanupRef {
  connectorId: string;
  ref: string;
  slot: ConnectorSecretSlot;
}

const revokeOne = async (
  secrets: ConnectorCatalogSecretStore,
  cleanup: ConnectorSecretCleanupRef,
): Promise<void> => {
  if (!secrets.revokeSecretRef) return;
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
  } catch (error) {
    console.error('[connectorSecretCleanup] best-effort revoke failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
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
};
