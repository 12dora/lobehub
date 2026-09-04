/**
 * Platform agent catalog types, errors, and shared lock helpers (DB-005 split).
 */
import type {
  PlatformAgentAssignmentMode,
  PlatformAgentAssignmentTargetType,
  PlatformAgentDependencySnapshot,
  PlatformAgentSystemKey,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';

import {
  type PlatformAgentAssignmentItem,
  platformAgentAssignments,
  type PlatformAgentItem,
  type PlatformAgentVersionItem,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type ExactPlatformAgentVersion = Omit<
  PlatformAgentVersionItem,
  'checksum' | 'config' | 'dependencySnapshot'
> & {
  checksum: string;
  config: PlatformAgentVersionConfig;
  dependencySnapshot: PlatformAgentDependencySnapshot;
};

export type PlatformAgentAssignmentSafeItem = Pick<
  PlatformAgentAssignmentItem,
  | 'agentId'
  | 'createdAt'
  | 'enabled'
  | 'id'
  | 'mode'
  | 'pinnedVersionId'
  | 'status'
  | 'targetId'
  | 'targetType'
  | 'updatedAt'
  | 'versionPolicy'
>;

export interface PlatformAgentEffectiveInput {
  agent: PlatformAgentItem;
  assignment: PlatformAgentAssignmentSafeItem;
  targetPriority: 1 | 2 | 3;
  version: ExactPlatformAgentVersion;
}

export interface PlatformAgentDraftPatch {
  isDefault?: boolean;
  systemKey?: PlatformAgentSystemKey | null;
  updatedBy?: string | null;
}

export interface PlatformAgentIdentityPage {
  items: PlatformAgentItem[];
  nextCursor: string | null;
}

export interface PlatformAgentVersionPage {
  items: ExactPlatformAgentVersion[];
  nextCursor: string | null;
}

export interface PlatformAgentAssignmentPage {
  items: PlatformAgentAssignmentSafeItem[];
  nextCursor: string | null;
}

export interface PlatformAgentMaterializationDependentPage {
  items: Array<{ id: string; userId: string; versionId: string }>;
  nextCursor: string | null;
}

export interface PlatformAgentAssignmentTargetPage {
  items: string[];
  nextCursor: string | null;
}

export interface PlatformAgentRolloutMaterializationInput {
  userId: string;
}

export interface PlatformAgentRolloutMaterializationResult {
  appliedUserIds: Set<string>;
  previousByUserId: Map<string, { checksum: string; versionId: string } | null>;
}

export interface PlatformAgentAssignmentWrite {
  agentId: string;
  enabled: boolean;
  mode: PlatformAgentAssignmentMode;
  pinnedVersionId: string | null;
  /** When set, persisted on update. Create always writes `active`. */
  status?: PlatformAgentAssignmentSafeItem['status'];
  targetId: string;
  targetType: PlatformAgentAssignmentTargetType;
  versionPolicy: PlatformAgentVersionPolicy;
}

/**
 * Thrown only on the (lock-serialized, effectively unreachable) materialization race path so the
 * transaction rolls back the just-created local Agent instead of committing an orphan. The caller
 * reconciles by re-reading the winning owner-scoped mapping.
 */
export class PlatformAgentMaterializationRaceError extends Error {
  readonly code = 'PLATFORM_MATERIALIZATION_RACE';

  constructor() {
    super('PLATFORM_MATERIALIZATION_RACE');
  }
}

const PLATFORM_AGENT_REFERENCE_LOCK_NAMESPACE = 'aihub:platform-agent-reference:v1';

/**
 * Per-Agent transaction-level advisory lock for the "referenceable Agent" protocol.
 *
 * Global lock order (acquire strictly in this order to stay deadlock-free):
 *   (1) default-inbox singleton advisory lock
 *   (2) per-Agent reference advisory lock — sorted by agentId
 *   (3) identity row FOR UPDATE — sorted by id
 */
export const acquirePlatformAgentReferenceLock = async (
  db: LobeChatDatabase | Transaction,
  agentId: string,
): Promise<void> => {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${PLATFORM_AGENT_REFERENCE_LOCK_NAMESPACE}:${agentId}`})::bigint)`,
  );
};

export const targetPriority = sql<1 | 2 | 3>`CASE
  WHEN ${platformAgentAssignments.targetType} = 'user' THEN 3
  WHEN ${platformAgentAssignments.targetType} = 'global_role' THEN 2
  ELSE 1
END`;

export const safeAssignmentColumns = {
  agentId: platformAgentAssignments.agentId,
  createdAt: platformAgentAssignments.createdAt,
  enabled: platformAgentAssignments.enabled,
  id: platformAgentAssignments.id,
  mode: platformAgentAssignments.mode,
  pinnedVersionId: platformAgentAssignments.pinnedVersionId,
  status: platformAgentAssignments.status,
  targetId: platformAgentAssignments.targetId,
  targetType: platformAgentAssignments.targetType,
  updatedAt: platformAgentAssignments.updatedAt,
  versionPolicy: platformAgentAssignments.versionPolicy,
};
