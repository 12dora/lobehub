import type { SkillItem, SkillListItem } from '@lobechat/types';

import type { PlatformPublishedSkillCatalog } from '@/types/platform/skills';

export interface AgentSkillsState {
  agentSkillDetailMap: Record<string, SkillItem>;
  agentSkills: SkillListItem[];
  agentSkillsLoading: boolean;
  /** Exact public metadata snapshot mirrored from the server runtime catalog. */
  platformSkillCatalog: PlatformPublishedSkillCatalog | null;
  platformSkillCatalogInvalidationRevision: string;
  platformSkillCatalogRequestEpoch: number;
  platformSkillRuntimeManaged: boolean;
  platformSkillRuntimeStatus: 'error' | 'loading' | 'ready' | 'unmanaged';
}

export const initialAgentSkillsState: AgentSkillsState = {
  agentSkillDetailMap: {},
  agentSkills: [],
  agentSkillsLoading: false,
  platformSkillCatalog: null,
  platformSkillCatalogInvalidationRevision: '0',
  platformSkillCatalogRequestEpoch: 0,
  platformSkillRuntimeManaged: false,
  platformSkillRuntimeStatus: 'unmanaged',
};
