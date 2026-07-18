import { TRPCError } from '@trpc/server';

import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';

/**
 * Reject an ordinary Agent mutation (update / remove / pin / group) when the target local Agent id
 * is actually a materialization of a platform Agent for THIS user (M10 PR-049 · ROOT-02).
 *
 * A materialized local row is only an FK / persistence-compatible attribution identity — its
 * managed fields (systemRole, model, provider, …) are NOT user-editable and the runtime config is
 * always taken from the pinned operation snapshot, never the row. Without this guard a user who
 * learns their materialized local id could edit or delete a managed Agent through the ordinary
 * endpoints (a delete would otherwise hit a raw FK restrict error). The lookup is:
 *
 * - flag-gated: with `ENABLE_PLATFORM_MANAGED_AGENTS` off it is a no-op, so ordinary local Agents
 *   are completely unaffected and there is zero platform access on the legacy path;
 * - owner-scoped: `getPlatformAgentIdByMaterializedAgentId` filters by the trusted `userId`, so a
 *   foreign / non-materialized id resolves to null and passes through untouched.
 */
export const assertAgentNotPlatformManaged = async (params: {
  agentId: string;
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return;
  const platformAgentId = await new PlatformAgentCatalogRepository(
    params.db,
  ).getPlatformAgentIdByMaterializedAgentId(params.userId, params.agentId);
  if (platformAgentId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This agent is managed by your organization and cannot be modified here.',
    });
  }
};
