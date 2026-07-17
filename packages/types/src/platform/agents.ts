export const PLATFORM_AGENT_ASSIGNMENT_MODES = ['mandatory', 'default', 'optional'] as const;
export type PlatformAgentAssignmentMode = (typeof PLATFORM_AGENT_ASSIGNMENT_MODES)[number];

export const PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES = ['global', 'global_role', 'user'] as const;
export type PlatformAgentAssignmentTargetType =
  (typeof PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES)[number];

export const PLATFORM_AGENT_VERSION_POLICIES = ['latest_published', 'pinned'] as const;
export type PlatformAgentVersionPolicy = (typeof PLATFORM_AGENT_VERSION_POLICIES)[number];

/** A non-null target id keeps the global assignment uniqueness constraint effective. */
export const PLATFORM_AGENT_GLOBAL_TARGET_ID = '__global__' as const;

/** Stable system identity for the existing internal `inbox` Agent. */
export const PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY = 'default-inbox' as const;

export type PlatformAgentSystemKey = typeof PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY;

export interface PlatformAgentModelParameters {
  frequencyPenalty?: number;
  maxTokens?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
}

/** Secret-free immutable Agent configuration. Dependencies are pinned separately. */
export interface PlatformAgentVersionConfig {
  avatar: string | null;
  backgroundColor: string | null;
  description: string | null;
  displayName: string;
  modelParameters: PlatformAgentModelParameters;
  openingMessage: string | null;
  openingQuestions: string[];
  systemRole: string;
  tags: string[];
}

export interface PlatformAgentModelDependencyRef {
  modelKey: string;
  providerChecksum: string;
  providerKey: string;
  providerRevision: number;
}

export interface PlatformAgentSkillDependencyRef {
  checksum: string;
  skillKey: string;
  version: string;
}

export interface PlatformAgentConnectorDependencyRef {
  allowedToolKeys: string[];
  connectorId: string;
  connectorKey: string;
  publishedChecksum: string;
  publishedRevision: number;
}

/** Exact published resources required by an immutable Agent version. */
export interface PlatformAgentDependencySnapshot {
  connectors: PlatformAgentConnectorDependencyRef[];
  model: PlatformAgentModelDependencyRef;
  skills: PlatformAgentSkillDependencyRef[];
}

export interface PlatformAgentIdentityDraft {
  agentKey: string;
  currentVersionId: string | null;
  draftSequence: number;
  id: string;
  isDefault: boolean;
  revision: number;
  status: 'archived' | 'draft' | 'published';
  systemKey: PlatformAgentSystemKey | null;
}

export interface PlatformAgentImmutableVersion {
  agentId: string;
  checksum: string;
  config: PlatformAgentVersionConfig;
  createdAt: Date;
  createdBy: string | null;
  dependencySnapshot: PlatformAgentDependencySnapshot;
  id: string;
  version: string;
}

export interface PlatformAgentAssignment {
  agentId: string;
  enabled: boolean;
  id: string;
  mode: PlatformAgentAssignmentMode;
  pinnedVersionId: string | null;
  targetId: string;
  targetType: PlatformAgentAssignmentTargetType;
  versionPolicy: PlatformAgentVersionPolicy;
}

/** Public user projection. It deliberately excludes assignment target and mutation reason. */
export interface PlatformEffectiveAgent {
  agentKey: string;
  checksum: string;
  config: PlatformAgentVersionConfig;
  distribution: PlatformAgentAssignmentMode;
  mutable: false;
  platformAgentId: string;
  source: 'platform';
  systemKey: PlatformAgentSystemKey | null;
  version: string;
  versionId: string;
}

export type PlatformAgentRolloutStatus =
  'cancelled' | 'completed' | 'dead' | 'failed' | 'pending' | 'running';

/** Secret-free admin projection over the M01 rollout job. */
export interface PlatformAgentRolloutProjection {
  assignmentId: string;
  completed: number;
  cursor: string | null;
  failed: number;
  jobId: string;
  status: PlatformAgentRolloutStatus;
  total: number;
  updatedAt: Date;
}

export interface PlatformUserAgentMaterialization {
  materializedAgentId: string | null;
  platformAgentId: string;
  platformAgentVersionId: string;
  userId: string;
}
