import type { z } from 'zod';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  type ManagedResourcePolicySnapshot,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { platformAgentEffectiveListOutputSchema } from '../../contracts/platformAgents';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;

interface PlatformAgentEffectiveResolverOptions {
  flags?: EnterpriseFeatureFlags;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  repository?: Pick<PlatformAgentCatalogRepository, 'listEffectiveInputs'>;
}

const isAgentRuntimeManaged = (snapshot: ManagedResourcePolicySnapshot): boolean =>
  snapshot.status === 'published' &&
  snapshot.published.agents.managed &&
  snapshot.published.agents.enforcementMode === 'enforced';

const emptyEffectiveList = (): EffectiveList => {
  const agents: EffectiveList['agents'] = [];
  return { agents, revision: checksumPayload({ agents }) };
};

/** User-safe effective platform Agent projection. Feature/policy-off paths never query Agent rows. */
export class PlatformAgentEffectiveResolver {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly options: PlatformAgentEffectiveResolverOptions = {},
  ) {}

  getEffectiveList = async (userId: string): Promise<EffectiveList> => {
    const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return emptyEffectiveList();

    const policy = await (
      this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
    ).getSnapshot();
    if (!isAgentRuntimeManaged(policy)) return emptyEffectiveList();

    const rows = await (
      this.options.repository ?? new PlatformAgentCatalogRepository(this.db)
    ).listEffectiveInputs(userId);
    rows.sort(
      (left, right) =>
        right.targetPriority - left.targetPriority ||
        left.agent.agentKey.localeCompare(right.agent.agentKey) ||
        left.assignment.id.localeCompare(right.assignment.id),
    );
    const seenAgents = new Set<string>();
    const seenSystemKeys = new Set<string>();
    const agents: EffectiveList['agents'] = [];
    for (const row of rows) {
      if (seenAgents.has(row.agent.id)) continue;
      if (row.agent.systemKey && seenSystemKeys.has(row.agent.systemKey)) continue;
      seenAgents.add(row.agent.id);
      if (row.agent.systemKey) seenSystemKeys.add(row.agent.systemKey);
      agents.push({
        agentKey: row.agent.agentKey,
        checksum: row.version.checksum,
        config: row.version.config,
        distribution: row.assignment.mode,
        mutable: false,
        platformAgentId: row.agent.id,
        source: 'platform',
        systemKey: row.agent.systemKey === 'default-inbox' ? row.agent.systemKey : null,
        version: row.version.version,
        versionId: row.version.id,
      });
    }
    return { agents, revision: checksumPayload({ agents }) };
  };

  getEffectiveAgent = async (userId: string, platformAgentId: string) => {
    const { agents } = await this.getEffectiveList(userId);
    return agents.find((agent) => agent.platformAgentId === platformAgentId) ?? null;
  };
}
