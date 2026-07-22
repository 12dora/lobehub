import type { LobeChatDatabase } from '@lobechat/database';

import { resolvePublishedConnectorGovernance } from './service';
import { EMPTY_CONNECTOR_GOVERNANCE, type ResolvedConnectorGovernance } from './types';

/**
 * Effective org connector governance for runtime consumers (manifest build,
 * execution gate, shared OAuth identity substitution).
 *
 * Fail-open to per-user behavior on any error: a governance read failure must
 * degrade to today's semantics, never block runs.
 */
export const resolveConnectorGovernance = async (
  db: LobeChatDatabase,
): Promise<ResolvedConnectorGovernance> => {
  try {
    return await resolvePublishedConnectorGovernance(db);
  } catch {
    return EMPTY_CONNECTOR_GOVERNANCE;
  }
};
