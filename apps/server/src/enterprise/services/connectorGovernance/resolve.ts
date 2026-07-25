import type { LobeChatDatabase } from '@lobechat/database';

import * as governanceService from './service';
import { DENIED_CONNECTOR_GOVERNANCE, type ResolvedConnectorGovernance } from './types';

/**
 * Effective org connector governance for runtime consumers (manifest build,
 * execution gate, shared OAuth identity substitution).
 *
 * Fail-closed on authorization-bearing fields: a governance read failure always
 * returns the deny-all shape upstream consumers already enforce.
 */
export const resolveConnectorGovernance = async (
  db: LobeChatDatabase,
): Promise<ResolvedConnectorGovernance> => {
  try {
    return await governanceService.resolvePublishedConnectorGovernance(db);
  } catch {
    return DENIED_CONNECTOR_GOVERNANCE;
  }
};
