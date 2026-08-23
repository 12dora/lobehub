import type { RemoteHeterogeneousAgentType } from '@lobechat/heterogeneous-agents';

export interface AgentProfile {
  avatar?: string;
  description?: string;
  title?: string;
}

export interface CapabilityResult {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface PlatformDef {
  comingSoon: boolean;
  desc: string;
  name: string;
  type: RemoteHeterogeneousAgentType;
}
