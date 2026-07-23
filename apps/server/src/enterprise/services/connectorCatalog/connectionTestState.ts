/**
 * Process-local, revision/token-bound connection-test bookkeeping.
 *
 * platform_connectors has no connection_test_* columns (unlike AI catalog), so
 * this store is the 二开 persistence path that survives admin get/refetch within
 * a process. Test identity is bound to the draft revision + draftToken so any
 * subsequent draft mutation invalidates the result (stale).
 *
 * Multi-instance durability requires a schema column — see OUT_OF_SCOPE_NEEDED.
 */
import type { z } from 'zod';

import type { connectorConnectionTestStateSchema } from '../../contracts/platformConnectors';

export type ConnectorConnectionTestState = z.infer<typeof connectorConnectionTestStateSchema>;

type StoredConnectionTest = Omit<ConnectorConnectionTestState, 'stale'>;

const byConnectorId = new Map<string, StoredConnectionTest>();

export const recordConnectorConnectionTest = (
  connectorId: string,
  state: StoredConnectionTest,
): void => {
  byConnectorId.set(connectorId, {
    errorCategory: state.errorCategory,
    latencyMs: state.latencyMs,
    messageCode: state.messageCode,
    status: state.status,
    testedAt: state.testedAt,
    testedDraftToken: state.testedDraftToken,
    testedRevision: state.testedRevision,
  });
};

/**
 * Project the stored test onto the current draft identity.
 * Missing → null. Token/revision mismatch → same status with stale:true.
 */
export const resolveConnectorConnectionTest = (
  connectorId: string,
  current: { draftToken: string; revision: number },
): ConnectorConnectionTestState | null => {
  const stored = byConnectorId.get(connectorId);
  if (!stored) return null;
  const stale =
    stored.testedDraftToken !== current.draftToken || stored.testedRevision !== current.revision;
  return { ...stored, stale };
};

export const clearConnectorConnectionTest = (connectorId: string): void => {
  byConnectorId.delete(connectorId);
};

export const resetConnectorConnectionTestStateForTest = (): void => {
  byConnectorId.clear();
};
