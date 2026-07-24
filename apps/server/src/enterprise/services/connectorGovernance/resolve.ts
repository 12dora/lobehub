import type { LobeChatDatabase } from '@lobechat/database';

import * as governanceService from './service';
import { DENIED_CONNECTOR_GOVERNANCE, type ResolvedConnectorGovernance } from './types';

/**
 * Effective org connector governance for runtime consumers (manifest build,
 * execution gate, shared OAuth identity substitution).
 *
 * Fail-closed on authorization-bearing fields: a governance read failure must
 * never restore a process-local last-known-good snapshot. LKG epochs are only
 * invalidated best-effort; a same-epoch LKG can predate a committed restrictive
 * publish whose invalidation was lost. Always return the deny-all shape that
 * upstream consumers already enforce (`active` + builtin APIs `disabled` +
 * synthetic shared-auth owner).
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
