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

/**
 * Namespace prefix for a platform Agent's stable list-item identity. Local Agent ids
 * (`agt_…`) and slugs never contain this prefix, so an encoded id can never collide with a
 * user-owned Agent id/slug when merged into a unified list or routed back to a chat entry.
 *
 * This identity is a *request-entry hint only*. It is not proof of authorization: the server
 * must always re-resolve owner-scoped entitlement (`PlatformAgentEffectiveResolver`) before
 * acting on it — a client can forge any `platformAgentId` here.
 */
export const PLATFORM_AGENT_LIST_ID_PREFIX = 'platform-agent:' as const;

/** Encode a platform Agent id into its stable, collision-proof list-item identity. */
export const encodePlatformAgentListId = (platformAgentId: string): string =>
  `${PLATFORM_AGENT_LIST_ID_PREFIX}${platformAgentId}`;

/** Return the platformAgentId when `id` is an encoded platform list identity, else null. */
export const decodePlatformAgentListId = (id: string): string | null => {
  if (!id.startsWith(PLATFORM_AGENT_LIST_ID_PREFIX)) return null;
  const platformAgentId = id.slice(PLATFORM_AGENT_LIST_ID_PREFIX.length);
  return platformAgentId.length > 0 ? platformAgentId : null;
};

/**
 * Minimal, user-safe metadata attached to a platform Agent when it appears in an ordinary
 * user's unified Agent list (home sidebar / picker). It deliberately excludes every admin-only
 * field — assignment target, version pointer, checksum, mutation reason — exposing only what
 * the client needs to render a managed item and gate creator-only affordances.
 */
export interface PlatformAgentUserListMeta {
  /** Distribution mode the item was assigned under (drives mandatory-not-hideable UI). */
  distribution: PlatformAgentAssignmentMode;
  /** Always true — a platform item is managed, so the client hides edit/delete affordances. */
  managed: true;
  /** Stable platform Agent id (also carried inside the encoded list-item id). */
  platformAgentId: string;
  source: 'platform';
}

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
  migrationRequired: boolean;
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

/**
 * Secret-free pin persisted on an operation so resume / retry / queued steps replay the EXACT
 * version the operation started on, instead of re-resolving latest (M10 PR-049 · REWORK-2).
 * Carries only stable identifiers + the version checksum — never a secret, token, or decrypted
 * value; the full pinned config + dependency snapshot are re-derived from the immutable version at
 * `versionId`, and a checksum mismatch (tampered / advanced pointer) fails closed.
 */
export interface PlatformOperationPin {
  checksum: string;
  platformAgentId: string;
  versionId: string;
}

/**
 * Secret-free exact model reference persisted on a platform operation so every LLM call runs on the
 * EXACT historical provider revision the operation started on — not the current published pointer
 * (M10 PR-049 · MODEL-EXACT). Carries only stable keys + revision numbers + the revision checksum;
 * credentials are never persisted here and are re-read/decrypted per execution at this exact
 * revision, failing closed on a missing / disabled / checksum-mismatched revision.
 */
export interface PlatformOperationModelPin {
  modelKey: string;
  providerChecksum: string;
  providerKey: string;
  providerRevision: number;
}

/** JSONB shape stored under `agent_operations.metadata`. */
export interface PlatformOperationMetadata {
  /**
   * Server-controlled resume anchor: the id of the assistant turn this operation produced (M10
   * PR-049 · RR3-1/RR4-1). Written once at start; a DIRECT (regeneration) resume must match this
   * EXACTLY. Never derived from a client-writable `message.parentId`.
   */
  assistantMessageId?: string;
  /**
   * Server-recorded ids of the pending `role='tool'` messages the runtime created when this
   * operation paused for human intervention, keyed by the SERVER-derived interaction kind (M10
   * PR-049 · RR4-1/RR5-2). `approval` = a `humanIntervention:'required'` / policy-blocked tool
   * (resumed via `resumeApproval`); `toolResult` = a `humanIntervention:'always'` human-answer tool
   * such as `askUserQuestion` (resumed via `resumeToolResult`). A resume must match one of the ids
   * under its OWN kind EXACTLY — the ids are created by the runtime and recorded here, so a
   * client-forged tool message (spoofed parentId / pending plugin) can never bind and an approval
   * anchor can never be replayed as a tool-result (or vice versa). Absent until the op parks.
   */
  pendingResumeAnchors?: { approval?: string[]; toolResult?: string[] };
  /** Exact connector references (revision/checksum + tool allowlist) for historical execution. */
  platformConnectors?: PlatformAgentConnectorDependencyRef[];
  /** Exact model reference for historical-revision execution. */
  platformModel?: PlatformOperationModelPin;
  /** Version pin for resume/retry replay. */
  platformOperation?: PlatformOperationPin;
  /** Exact skill references (skillKey/version/checksum) for historical-version execution. */
  platformSkills?: PlatformAgentSkillDependencyRef[];
}
