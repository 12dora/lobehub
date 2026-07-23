import type { LobeChatDatabase } from '@lobechat/database';

import * as governanceService from './service';
import { DENIED_CONNECTOR_GOVERNANCE, type ResolvedConnectorGovernance } from './types';

/**
 * Effective org connector governance for runtime consumers (manifest build,
 * execution gate, shared OAuth identity substitution).
 *
 * Fail-closed on authorization-bearing fields: a governance read failure must
 * never restore per-user behavior while org policy may still deny tools or
 * mandate a shared OAuth identity. Prefer a process-local last-known-good
 * snapshot **only when its invalidation epoch is still current**; otherwise
 * return the deny-all policy shape that upstream consumers already enforce
 * (`active` + builtin APIs `disabled` + synthetic shared-auth owner).
 */
export const resolveConnectorGovernance = async (
  db: LobeChatDatabase,
): Promise<ResolvedConnectorGovernance> => {
  try {
    return await governanceService.resolvePublishedConnectorGovernance(db);
  } catch {
    const lastKnownGood = await governanceService.getLastKnownConnectorGovernanceIfCurrent(db);
    if (lastKnownGood) return lastKnownGood;
    return DENIED_CONNECTOR_GOVERNANCE;
  }
};
