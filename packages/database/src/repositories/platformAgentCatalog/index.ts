import type {
  PlatformAgentAssignmentMode,
  PlatformAgentAssignmentTargetType,
  PlatformAgentDependencySnapshot,
  PlatformAgentSystemKey,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { checksumPayload } from '../../models/platform/checksum';
import {
  type NewPlatformAgent,
  type PlatformAgentAssignmentItem,
  platformAgentAssignments,
  type PlatformAgentItem,
  platformAgents,
  type PlatformAgentVersionItem,
  platformAgentVersions,
  type PlatformUserAgentMaterializationErrorCategory,
  type PlatformUserAgentMaterializationItem,
  platformUserAgentMaterializations,
  type PlatformUserAgentMaterializationStatus,
} from '../../schemas/platform';
import { roles, userRoles } from '../../schemas/rbac';
import { users } from '../../schemas/user';
import type { LobeChatDatabase, Transaction } from '../../type';
import { idGenerator } from '../../utils/idGenerator';

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

const isRootDatabase = (db: LobeChatDatabase | Transaction): db is LobeChatDatabase =>
  'transaction' in db;

const inTransaction = async <T>(
  db: LobeChatDatabase | Transaction,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> => (isRootDatabase(db) ? db.transaction(operation) : operation(db));

const PLATFORM_AGENT_REFERENCE_LOCK_NAMESPACE = 'aihub:platform-agent-reference:v1';

/**
 * Per-Agent transaction-level advisory lock for the "referenceable Agent" protocol.
 *
 * Every path that creates or updates a reference to a platform Agent — assignment
 * insert/update and materialization upsert — and the archive path acquire this same
 * per-Agent lock, so a reference write and an archive of the same Agent are mutually
 * exclusive and cannot interleave into an archived-Agent orphan reference.
 *
 * Global lock order (acquire strictly in this order to stay deadlock-free):
 *   (1) default-inbox singleton advisory lock  (acquirePlatformDefaultInboxLock)
 *   (2) per-Agent reference advisory lock       (this)         — sorted by agentId
 *   (3) identity row FOR UPDATE                 (lockIdentity) — sorted by id
 *
 * Reference writers acquire (2) then (3); archive acquires (1) then (2) then (3);
 * setDefaultInbox acquires (1) then (3). No path ever takes a later lock before an
 * earlier one, so the wait-for graph has no cycle.
 */
export const acquirePlatformAgentReferenceLock = async (
  db: LobeChatDatabase | Transaction,
  agentId: string,
): Promise<void> => {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${PLATFORM_AGENT_REFERENCE_LOCK_NAMESPACE}:${agentId}`})::bigint)`,
  );
};

const targetPriority = sql<1 | 2 | 3>`CASE
  WHEN ${platformAgentAssignments.targetType} = 'user' THEN 3
  WHEN ${platformAgentAssignments.targetType} = 'global_role' THEN 2
  ELSE 1
END`;

const safeAssignmentColumns = {
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

/** PR-047 persistence primitives only; publication policy and resolution live in later services. */
export class PlatformAgentCatalogRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  createIdentity = async (
    values: Pick<NewPlatformAgent, 'agentKey' | 'isDefault' | 'systemKey'> & {
      createdBy?: string | null;
    },
  ): Promise<PlatformAgentItem> => {
    const [row] = await this.db
      .insert(platformAgents)
      .values({
        ...values,
        migrationRequired: false,
        title: values.agentKey,
      })
      .returning();
    return row;
  };

  getIdentity = async (id: string): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.id, id))
      .limit(1);
    return row;
  };

  listIdentities = async (params: {
    cursor?: string;
    limit?: number;
    query?: string;
    status?: PlatformAgentItem['status'];
  }): Promise<PlatformAgentIdentityPage> => {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const rows = await this.db
      .select()
      .from(platformAgents)
      .where(
        and(
          eq(platformAgents.migrationRequired, false),
          params.cursor ? gt(platformAgents.agentKey, params.cursor) : undefined,
          params.query ? ilike(platformAgents.agentKey, `%${params.query}%`) : undefined,
          params.status ? eq(platformAgents.status, params.status) : undefined,
        ),
      )
      .orderBy(asc(platformAgents.agentKey))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.agentKey ?? null) : null };
  };

  /** Lock the mutable Agent identity before publication CAS and dependency revalidation. */
  lockIdentity = async (id: string): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.id, id))
      .for('update')
      .limit(1);
    return row;
  };

  updateDraftCas = async (params: {
    expectedDraftSequence: number;
    expectedRevision: number;
    id: string;
    patch: PlatformAgentDraftPatch;
  }): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .update(platformAgents)
      .set({
        ...params.patch,
        draftSequence: params.expectedDraftSequence + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformAgents.id, params.id),
          eq(platformAgents.revision, params.expectedRevision),
          eq(platformAgents.draftSequence, params.expectedDraftSequence),
          eq(platformAgents.migrationRequired, false),
        ),
      )
      .returning();
    return row;
  };

  appendVersionCas = async (params: {
    agentId: string;
    config: PlatformAgentVersionConfig;
    createdBy?: string | null;
    dependencySnapshot: PlatformAgentDependencySnapshot;
    expectedDraftSequence: number;
    expectedRevision: number;
    version: string;
  }): Promise<ExactPlatformAgentVersion | undefined> =>
    inTransaction(this.db, async (transaction) => {
      const [identity] = await transaction
        .update(platformAgents)
        .set({
          draftSequence: params.expectedDraftSequence + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(platformAgents.id, params.agentId),
            eq(platformAgents.revision, params.expectedRevision),
            eq(platformAgents.draftSequence, params.expectedDraftSequence),
            eq(platformAgents.migrationRequired, false),
          ),
        )
        .returning({ id: platformAgents.id });
      if (!identity) return undefined;

      const checksum = checksumPayload({
        config: params.config,
        dependencySnapshot: params.dependencySnapshot,
      });
      const [version] = await transaction
        .insert(platformAgentVersions)
        .values({
          agentId: params.agentId,
          checksum,
          config: params.config,
          createdBy: params.createdBy,
          dependencySnapshot: params.dependencySnapshot,
          version: params.version,
        })
        .returning();
      return version as ExactPlatformAgentVersion;
    });

  getExactVersion = async (
    agentId: string,
    versionId: string,
  ): Promise<ExactPlatformAgentVersion | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgentVersions)
      .where(
        and(
          eq(platformAgentVersions.agentId, agentId),
          eq(platformAgentVersions.id, versionId),
          isNotNull(platformAgentVersions.checksum),
          isNotNull(platformAgentVersions.dependencySnapshot),
        ),
      )
      .limit(1);
    return row as ExactPlatformAgentVersion | undefined;
  };

  listExactVersions = async (params: {
    agentId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PlatformAgentVersionPage> => {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const rows = await this.db
      .select()
      .from(platformAgentVersions)
      .where(
        and(
          eq(platformAgentVersions.agentId, params.agentId),
          params.cursor ? gt(platformAgentVersions.id, params.cursor) : undefined,
          isNotNull(platformAgentVersions.checksum),
          isNotNull(platformAgentVersions.dependencySnapshot),
        ),
      )
      .orderBy(asc(platformAgentVersions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows) as ExactPlatformAgentVersion[];
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  };

  archiveIdentityCas = async (params: {
    expectedDraftSequence: number;
    expectedRevision: number;
    id: string;
    updatedBy?: string | null;
  }): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .update(platformAgents)
      .set({
        draftSequence: params.expectedDraftSequence + 1,
        isDefault: false,
        revision: params.expectedRevision + 1,
        status: 'archived',
        systemKey: null,
        updatedAt: new Date(),
        updatedBy: params.updatedBy,
      })
      .where(
        and(
          eq(platformAgents.id, params.id),
          eq(platformAgents.revision, params.expectedRevision),
          eq(platformAgents.draftSequence, params.expectedDraftSequence),
          eq(platformAgents.migrationRequired, false),
        ),
      )
      .returning();
    return row;
  };

  pointToVersionCas = async (params: {
    agentId: string;
    expectedDraftSequence: number;
    expectedRevision: number;
    publishedAt: Date;
    versionId: string;
  }): Promise<PlatformAgentItem | undefined> =>
    inTransaction(this.db, async (transaction) => {
      const [version] = await transaction
        .select({ id: platformAgentVersions.id })
        .from(platformAgentVersions)
        .where(
          and(
            eq(platformAgentVersions.agentId, params.agentId),
            eq(platformAgentVersions.id, params.versionId),
            isNotNull(platformAgentVersions.checksum),
            isNotNull(platformAgentVersions.dependencySnapshot),
          ),
        )
        .limit(1);
      if (!version) return undefined;

      const [identity] = await transaction
        .update(platformAgents)
        .set({
          currentVersionId: version.id,
          draftSequence: params.expectedDraftSequence + 1,
          publishedAt: params.publishedAt,
          revision: params.expectedRevision + 1,
          status: 'published',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(platformAgents.id, params.agentId),
            eq(platformAgents.revision, params.expectedRevision),
            eq(platformAgents.draftSequence, params.expectedDraftSequence),
            eq(platformAgents.migrationRequired, false),
          ),
        )
        .returning();
      return identity;
    });

  /**
   * Acquire the per-Agent reference lock (2) then the identity row lock (3), and return
   * the row only if it can still accept references. Any concurrent archive of this Agent
   * is serialized behind the same lock: a writer that wakes after the archive commits sees
   * `status = 'archived'` (or a vanished / migration-pending row) and is rejected here, which
   * — together with archive counting references under the same lock — closes the TOCTOU window.
   */
  private lockReferenceableAgent = async (
    db: LobeChatDatabase | Transaction,
    agentId: string,
  ): Promise<PlatformAgentItem | undefined> => {
    await acquirePlatformAgentReferenceLock(db, agentId);
    const [row] = await db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.id, agentId))
      .for('update')
      .limit(1);
    if (!row || row.migrationRequired || row.status === 'archived') return undefined;
    return row;
  };

  createAssignment = async (
    values: PlatformAgentAssignmentWrite,
  ): Promise<PlatformAgentAssignmentSafeItem | undefined> =>
    inTransaction(this.db, async (tx) => {
      const agent = await this.lockReferenceableAgent(tx, values.agentId);
      if (!agent) return undefined;
      const [row] = await tx
        .insert(platformAgentAssignments)
        .values({ ...values, status: 'active' })
        .returning(safeAssignmentColumns);
      return row;
    });

  updateAssignment = async (
    agentId: string,
    id: string,
    values: Omit<PlatformAgentAssignmentWrite, 'agentId'>,
  ): Promise<PlatformAgentAssignmentSafeItem | undefined> =>
    inTransaction(this.db, async (tx) => {
      const agent = await this.lockReferenceableAgent(tx, agentId);
      if (!agent) return undefined;
      const [row] = await tx
        .update(platformAgentAssignments)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(eq(platformAgentAssignments.id, id), eq(platformAgentAssignments.agentId, agentId)),
        )
        .returning(safeAssignmentColumns);
      return row;
    });

  deleteAssignment = async (
    agentId: string,
    id: string,
  ): Promise<PlatformAgentAssignmentSafeItem | undefined> => {
    const [row] = await this.db
      .delete(platformAgentAssignments)
      .where(
        and(eq(platformAgentAssignments.id, id), eq(platformAgentAssignments.agentId, agentId)),
      )
      .returning(safeAssignmentColumns);
    return row;
  };

  getAssignment = async (
    agentId: string,
    id: string,
  ): Promise<PlatformAgentAssignmentSafeItem | undefined> => {
    const [row] = await this.db
      .select(safeAssignmentColumns)
      .from(platformAgentAssignments)
      .where(
        and(eq(platformAgentAssignments.id, id), eq(platformAgentAssignments.agentId, agentId)),
      )
      .limit(1);
    return row;
  };

  listAssignments = async (params: {
    agentId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PlatformAgentAssignmentPage> => {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const rows = await this.db
      .select(safeAssignmentColumns)
      .from(platformAgentAssignments)
      .where(
        and(
          eq(platformAgentAssignments.agentId, params.agentId),
          params.cursor ? gt(platformAgentAssignments.id, params.cursor) : undefined,
        ),
      )
      .orderBy(asc(platformAgentAssignments.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  };

  listDependentMaterializations = async (params: {
    agentId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PlatformAgentMaterializationDependentPage> => {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const rows = await this.db
      .select({
        id: platformUserAgentMaterializations.id,
        userId: platformUserAgentMaterializations.userId,
        versionId: platformUserAgentMaterializations.platformAgentVersionId,
      })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.platformAgentId, params.agentId),
          params.cursor ? gt(platformUserAgentMaterializations.id, params.cursor) : undefined,
        ),
      )
      .orderBy(asc(platformUserAgentMaterializations.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  };

  countAssignments = async (agentId: string): Promise<number> => {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, agentId));
    return row?.count ?? 0;
  };

  /**
   * Batch assignment counts for a page of Agents in a single aggregate query.
   * Keyed by agentId; missing agents imply zero. Keeps `list` query count constant (ADM-04).
   */
  countAssignmentsByAgentIds = async (agentIds: string[]): Promise<Map<string, number>> => {
    if (agentIds.length === 0) return new Map();
    const rows = await this.db
      .select({ agentId: platformAgentAssignments.agentId, count: sql<number>`count(*)::int` })
      .from(platformAgentAssignments)
      .where(inArray(platformAgentAssignments.agentId, agentIds))
      .groupBy(platformAgentAssignments.agentId);
    return new Map(rows.map((row) => [row.agentId, row.count]));
  };

  /**
   * Batch exact-version lookup by version id in a single `IN` query. Version ids are
   * globally unique, so results are safe to key by id across different Agents (ADM-04).
   * Non-exact rows (missing checksum / dependency snapshot) are excluded.
   */
  getExactVersionsByIds = async (
    versionIds: string[],
  ): Promise<Map<string, ExactPlatformAgentVersion>> => {
    if (versionIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(platformAgentVersions)
      .where(
        and(
          inArray(platformAgentVersions.id, versionIds),
          isNotNull(platformAgentVersions.checksum),
          isNotNull(platformAgentVersions.dependencySnapshot),
        ),
      );
    return new Map((rows as ExactPlatformAgentVersion[]).map((row) => [row.id, row]));
  };

  /**
   * Count live references to an Agent under the caller's identity row lock, so the
   * result is TOCTOU-stable: a concurrent assignment / materialization insert takes a
   * FK KEY SHARE lock on this Agent row and blocks behind the archive's FOR UPDATE (ADM-02).
   *
   * Materialization invariant (R1-01): a row is a REAL materialization reference iff it carries
   * real materialization state — `materialized_agent_id IS NOT NULL` (a local Agent exists) OR
   * `last_synced_at IS NOT NULL` (the materialization pipeline has processed it; `upsertMaterialization`
   * always stamps `last_synced_at`). A pure visibility-only row (materialized_agent_id IS NULL AND
   * last_synced_at IS NULL), written solely to carry the owner's hidden preference, is NOT a
   * reference and never blocks archive. Real pending / materialized / error rows still block it.
   */
  countAgentReferences = async (
    agentId: string,
  ): Promise<{ assignments: number; materializations: number }> => {
    const [assignmentRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, agentId));
    const [materializationRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.platformAgentId, agentId),
          or(
            isNotNull(platformUserAgentMaterializations.materializedAgentId),
            isNotNull(platformUserAgentMaterializations.lastSyncedAt),
          ),
        ),
      );
    return {
      assignments: assignmentRow?.count ?? 0,
      materializations: materializationRow?.count ?? 0,
    };
  };

  countAssignmentTargets = async (params: {
    cutoff?: Date;
    targetId: string;
    targetType: PlatformAgentAssignmentTargetType;
  }): Promise<number> => {
    if (params.targetType === 'global') {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(params.cutoff ? lte(users.createdAt, params.cutoff) : undefined);
      return row?.count ?? 0;
    }
    if (params.targetType === 'user') {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.id, params.targetId),
            params.cutoff ? lte(users.createdAt, params.cutoff) : undefined,
          ),
        );
      return row?.count ?? 0;
    }
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct ${userRoles.userId})::int` })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .innerJoin(
        roles,
        and(eq(roles.id, userRoles.roleId), isNull(roles.workspaceId), eq(roles.isActive, true)),
      )
      .where(
        and(
          eq(userRoles.roleId, params.targetId),
          isNull(userRoles.workspaceId),
          params.cutoff ? lte(users.createdAt, params.cutoff) : undefined,
          params.cutoff ? lte(userRoles.createdAt, params.cutoff) : undefined,
          or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > CURRENT_TIMESTAMP`),
        ),
      );
    return row?.count ?? 0;
  };

  listAssignmentTargetUserIds = async (params: {
    cutoff: Date;
    cursor?: string;
    limit?: number;
    targetId: string;
    targetType: PlatformAgentAssignmentTargetType;
  }): Promise<PlatformAgentAssignmentTargetPage> => {
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
    if (params.targetType === 'user') {
      if (params.cursor && params.targetId <= params.cursor) return { items: [], nextCursor: null };
      const [row] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, params.targetId), lte(users.createdAt, params.cutoff)))
        .limit(1);
      return { items: row ? [row.id] : [], nextCursor: null };
    }

    const baseCondition = and(
      lte(users.createdAt, params.cutoff),
      params.cursor ? gt(users.id, params.cursor) : undefined,
    );
    const rows =
      params.targetType === 'global'
        ? await this.db
            .select({ id: users.id })
            .from(users)
            .where(baseCondition)
            .orderBy(asc(users.id))
            .limit(limit + 1)
        : await this.db
            .selectDistinct({ id: users.id })
            .from(users)
            .innerJoin(userRoles, eq(userRoles.userId, users.id))
            .innerJoin(
              roles,
              and(
                eq(roles.id, userRoles.roleId),
                isNull(roles.workspaceId),
                eq(roles.isActive, true),
              ),
            )
            .where(
              and(
                baseCondition,
                eq(userRoles.roleId, params.targetId),
                isNull(userRoles.workspaceId),
                lte(userRoles.createdAt, params.cutoff),
                or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > CURRENT_TIMESTAMP`),
              ),
            )
            .orderBy(asc(users.id))
            .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(({ id }) => id);
    return { items, nextCursor: hasMore ? (items.at(-1) ?? null) : null };
  };

  /**
   * Apply one bounded rollout page with two queries: one exact owner-scoped read and one bulk CAS
   * upsert. The caller MUST already hold the per-Agent reference advisory lock and validate the
   * locked Agent identity / Assignment snapshot in the same transaction. The bounded OR predicate
   * preserves each row's independently observed prior version, while the advisory lock serializes
   * every supported materialization writer for this Agent.
   */
  bulkCasRolloutMaterializations = async (params: {
    beforeWrite?: (
      previousByUserId: ReadonlyMap<string, { checksum: string; versionId: string } | null>,
    ) => Promise<ReadonlySet<string> | void>;
    platformAgentId: string;
    targetVersionChecksum: string;
    targetVersionId: string;
    targets: PlatformAgentRolloutMaterializationInput[];
  }): Promise<PlatformAgentRolloutMaterializationResult> => {
    if (params.targets.length === 0) {
      return { appliedUserIds: new Set(), previousByUserId: new Map() };
    }
    if (params.targets.length > 100) throw new Error('Rollout materialization batch exceeds 100');

    const userIds = [...new Set(params.targets.map(({ userId }) => userId))];
    const existingRows = await this.db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
          inArray(platformUserAgentMaterializations.userId, userIds),
        ),
      );
    const existingByUserId = new Map(existingRows.map((row) => [row.userId, row]));
    const previousByUserId = new Map<string, { checksum: string; versionId: string } | null>();
    const casConditions = userIds.map((userId) => {
      const existing = existingByUserId.get(userId);
      const isReal =
        existing && (existing.lastSyncedAt !== null || existing.materializedAgentId !== null);
      previousByUserId.set(
        userId,
        isReal
          ? {
              checksum: existing.platformAgentVersionChecksum,
              versionId: existing.platformAgentVersionId,
            }
          : null,
      );
      return and(
        eq(platformUserAgentMaterializations.userId, userId),
        existing && isReal
          ? and(
              eq(
                platformUserAgentMaterializations.platformAgentVersionId,
                existing.platformAgentVersionId,
              ),
              eq(
                platformUserAgentMaterializations.platformAgentVersionChecksum,
                existing.platformAgentVersionChecksum,
              ),
            )
          : and(
              isNull(platformUserAgentMaterializations.lastSyncedAt),
              isNull(platformUserAgentMaterializations.materializedAgentId),
            ),
      );
    });
    const blockedUserIds = (await params.beforeWrite?.(previousByUserId)) ?? new Set<string>();
    const writableUserIds = userIds.filter((userId) => !blockedUserIds.has(userId));
    if (writableUserIds.length === 0) {
      return { appliedUserIds: new Set(), previousByUserId };
    }
    const now = new Date();
    const written = await this.db
      .insert(platformUserAgentMaterializations)
      .values(
        writableUserIds.map((userId) => {
          const existing = existingByUserId.get(userId);
          return {
            hidden: existing?.hidden ?? false,
            id: existing?.id ?? idGenerator('platformUserAgentMaterializations', 16),
            lastErrorCategory: null,
            lastSyncedAt: now,
            materializedAgentId: existing?.materializedAgentId ?? null,
            platformAgentId: params.platformAgentId,
            platformAgentVersionChecksum: params.targetVersionChecksum,
            platformAgentVersionId: params.targetVersionId,
            status: existing?.materializedAgentId
              ? ('materialized' as const)
              : ('pending' as const),
            userId,
          };
        }),
      )
      .onConflictDoUpdate({
        set: {
          lastErrorCategory: null,
          lastSyncedAt: now,
          platformAgentVersionChecksum: sql`excluded.platform_agent_version_checksum`,
          platformAgentVersionId: sql`excluded.platform_agent_version_id`,
          status: sql`excluded.status`,
          updatedAt: now,
        },
        target: [
          platformUserAgentMaterializations.userId,
          platformUserAgentMaterializations.platformAgentId,
        ],
        where: or(...casConditions.filter((_, index) => writableUserIds.includes(userIds[index]))),
      })
      .returning({ userId: platformUserAgentMaterializations.userId });

    return {
      appliedUserIds: new Set(written.map(({ userId }) => userId)),
      previousByUserId,
    };
  };

  getDefaultIdentityForUpdate = async (): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.isDefault, true))
      .for('update')
      .limit(1);
    return row;
  };

  listEffectiveInputs = async (userId: string): Promise<PlatformAgentEffectiveInput[]> => {
    const effectiveVersionId = sql<string>`CASE
      WHEN ${platformAgentAssignments.versionPolicy} = 'pinned'
        THEN ${platformAgentAssignments.pinnedVersionId}
      ELSE ${platformAgents.currentVersionId}
    END`;
    const rows = await this.db
      .select({
        agent: platformAgents,
        assignment: safeAssignmentColumns,
        targetPriority,
        version: platformAgentVersions,
      })
      .from(platformAgentAssignments)
      .innerJoin(platformAgents, eq(platformAgents.id, platformAgentAssignments.agentId))
      .innerJoin(
        platformAgentVersions,
        and(
          eq(platformAgentVersions.agentId, platformAgents.id),
          eq(platformAgentVersions.id, effectiveVersionId),
          isNotNull(platformAgentVersions.checksum),
          isNotNull(platformAgentVersions.dependencySnapshot),
        ),
      )
      .leftJoin(
        userRoles,
        and(
          eq(platformAgentAssignments.targetType, 'global_role'),
          eq(platformAgentAssignments.targetId, userRoles.roleId),
          eq(userRoles.userId, userId),
          isNull(userRoles.workspaceId),
          or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > CURRENT_TIMESTAMP`),
        ),
      )
      .leftJoin(
        roles,
        and(eq(roles.id, userRoles.roleId), isNull(roles.workspaceId), eq(roles.isActive, true)),
      )
      .where(
        and(
          eq(platformAgentAssignments.enabled, true),
          eq(platformAgentAssignments.status, 'active'),
          eq(platformAgents.migrationRequired, false),
          eq(platformAgents.status, 'published'),
          or(
            eq(platformAgentAssignments.targetType, 'global'),
            and(
              eq(platformAgentAssignments.targetType, 'user'),
              eq(platformAgentAssignments.targetId, userId),
            ),
            and(eq(platformAgentAssignments.targetType, 'global_role'), isNotNull(roles.id)),
          ),
        ),
      )
      .orderBy(desc(targetPriority), platformAgents.agentKey, platformAgentAssignments.id);
    return rows as PlatformAgentEffectiveInput[];
  };

  getMaterialization = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformUserAgentMaterializationItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
        ),
      )
      .limit(1);
    return row;
  };

  /**
   * Owner-scoped set of local Agent ids that are materializations of a platform Agent for the
   * given user. Strictly filtered by the trusted `userId`. Used by the unified list to
   * de-duplicate: a materialized local row is represented by its platform list item, never a
   * second local entry. Only rows with a real local Agent (materializedAgentId set) are returned
   * — pure visibility-only rows carry no local Agent.
   */
  listMaterializedAgentIds = async (userId: string): Promise<Set<string>> => {
    const rows = await this.db
      .select({ materializedAgentId: platformUserAgentMaterializations.materializedAgentId })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          isNotNull(platformUserAgentMaterializations.materializedAgentId),
        ),
      );
    return new Set(rows.map((row) => row.materializedAgentId as string));
  };

  /**
   * Owner-scoped reverse lookup: given a local Agent id, return the platform Agent it was
   * materialized from for THIS user, or null. Strictly filtered by the trusted `userId`, so a local
   * id belonging to another user (or an ordinary, non-materialized Agent) can never resolve to a
   * platform Agent. Used by the chat runtime to force a materialized local id back through
   * owner-scoped entitlement + the exact pinned snapshot instead of running the local row directly.
   */
  getPlatformAgentIdByMaterializedAgentId = async (
    userId: string,
    materializedAgentId: string,
  ): Promise<string | null> => {
    const [row] = await this.db
      .select({ platformAgentId: platformUserAgentMaterializations.platformAgentId })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.materializedAgentId, materializedAgentId),
        ),
      )
      .limit(1);
    return row?.platformAgentId ?? null;
  };

  /**
   * Delayed materialization of a local user-owned Agent for a platform Agent, transactional and
   * owner-scoped (R-materialize). The whole thing runs under the per-Agent reference lock inside
   * ONE transaction so that:
   *
   * - Local Agent creation (`createLocalAgent`, run against the SAME tx) and the mapping insert
   *   commit atomically. N concurrent callers therefore leave exactly one mapping and one local
   *   Agent: the lock serializes them, the first sees no mapping and creates one, the rest see the
   *   existing mapping and reuse it — never creating a second Agent, never orphaning one.
   * - It joins the referenceable-Agent protocol: an Agent archived under the shared lock is
   *   rejected (`{ reason: 'archived' }`) instead of producing an orphan reference.
   * - The mapping is upgraded in place from a pure visibility-only row (materializedAgentId NULL)
   *   without disturbing the owner's hidden preference.
   *
   * The exact pinned `{ versionId, checksum }` is written verbatim (FK-validated against the
   * immutable version), so the local row can never point at a version/checksum the caller did not
   * pin. No secret is written — the mapping carries only ids and a checksum.
   */
  materializeLocalAgent = async (params: {
    createLocalAgent: (tx: Transaction) => Promise<{ id: string }>;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    userId: string;
  }): Promise<
    { agentId: string; created: boolean; ok: true } | { ok: false; reason: 'archived' }
  > =>
    inTransaction(this.db, async (tx) => {
      const scoped = new PlatformAgentCatalogRepository(tx);
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return { ok: false as const, reason: 'archived' as const };

      const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
      if (existing?.materializedAgentId) {
        return {
          agentId: existing.materializedAgentId,
          created: false as const,
          ok: true as const,
        };
      }

      const local = await params.createLocalAgent(tx);
      const now = new Date();
      const [row] = await tx
        .insert(platformUserAgentMaterializations)
        .values({
          hidden: existing?.hidden ?? false,
          lastSyncedAt: now,
          materializedAgentId: local.id,
          platformAgentId: params.platformAgentId,
          platformAgentVersionChecksum: params.platformAgentVersionChecksum,
          platformAgentVersionId: params.platformAgentVersionId,
          status: 'materialized',
          userId: params.userId,
        })
        .onConflictDoUpdate({
          // Only upgrade a pure visibility-only row; a row that already carries a real local Agent
          // is left untouched (setWhere false → no row returned → treated as a lost race below).
          set: {
            lastErrorCategory: null,
            lastSyncedAt: now,
            materializedAgentId: local.id,
            platformAgentVersionChecksum: params.platformAgentVersionChecksum,
            platformAgentVersionId: params.platformAgentVersionId,
            status: 'materialized',
            updatedAt: now,
          },
          setWhere: isNull(platformUserAgentMaterializations.materializedAgentId),
          target: [
            platformUserAgentMaterializations.userId,
            platformUserAgentMaterializations.platformAgentId,
          ],
        })
        .returning({ materializedAgentId: platformUserAgentMaterializations.materializedAgentId });

      if (row?.materializedAgentId === local.id) {
        return { agentId: local.id, created: true as const, ok: true as const };
      }
      // Unreachable while the per-Agent lock is held (the mapping check above is authoritative).
      // Throwing rolls back this tx — undoing the just-created local Agent — so a caller that
      // retries (re-reads the winning mapping) never leaves an orphan Agent behind.
      throw new PlatformAgentMaterializationRaceError();
    });

  /**
   * Owner-scoped set of platform Agent ids the given user has hidden. Strictly filtered by
   * the trusted `userId`, so one user's visibility choices can never widen another's read.
   */
  listHiddenPlatformAgentIds = async (userId: string): Promise<Set<string>> => {
    const rows = await this.db
      .select({ platformAgentId: platformUserAgentMaterializations.platformAgentId })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.hidden, true),
        ),
      );
    return new Set(rows.map((row) => row.platformAgentId));
  };

  /**
   * Owner-scoped write of the per-user hidden flag (R1). Joins the referenceable-Agent protocol
   * (hiding an archived Agent is rejected → returns false). A hidden row is written as a pure
   * visibility-only row — `last_synced_at` is left NULL and `materialized_agent_id` NULL — so it
   * is never counted as an archive reference (see `countAgentReferences`). Hiding an Agent that
   * already has a real materialization only flips the flag and preserves its sync/local state.
   *
   * Unhiding deletes a pure visibility-only row (so a hide→unhide cycle leaves no archive blocker)
   * but only clears the flag on a row that carries real materialization state.
   */
  setMaterializationHidden = async (params: {
    hidden: boolean;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    userId: string;
  }): Promise<boolean> =>
    inTransaction(this.db, async (tx) => {
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return false;

      const ownerScope = and(
        eq(platformUserAgentMaterializations.userId, params.userId),
        eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
      );

      if (params.hidden) {
        // Never touch last_synced_at: an inserted row stays visibility-only; an existing real
        // materialization keeps its sync/local state and only gains the hidden flag.
        await tx
          .insert(platformUserAgentMaterializations)
          .values({
            hidden: true,
            platformAgentId: params.platformAgentId,
            platformAgentVersionChecksum: params.platformAgentVersionChecksum,
            platformAgentVersionId: params.platformAgentVersionId,
            status: 'pending',
            userId: params.userId,
          })
          .onConflictDoUpdate({
            set: { hidden: true, updatedAt: new Date() },
            target: [
              platformUserAgentMaterializations.userId,
              platformUserAgentMaterializations.platformAgentId,
            ],
          });
        return true;
      }

      // Unhide: drop a pure visibility-only row so it can never linger as an archive blocker …
      const deleted = await tx
        .delete(platformUserAgentMaterializations)
        .where(
          and(
            ownerScope,
            isNull(platformUserAgentMaterializations.materializedAgentId),
            isNull(platformUserAgentMaterializations.lastSyncedAt),
          ),
        )
        .returning({ id: platformUserAgentMaterializations.id });
      // … otherwise (a real materialization row) just clear the flag, preserving its state.
      if (deleted.length === 0) {
        await tx
          .update(platformUserAgentMaterializations)
          .set({ hidden: false, updatedAt: new Date() })
          .where(ownerScope);
      }
      return true;
    });

  upsertMaterialization = async (params: {
    expectedCurrent?: {
      checksum: string;
      versionId: string;
    };
    hidden?: boolean;
    lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
    materializedAgentId?: string | null;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    status?: PlatformUserAgentMaterializationStatus;
    userId: string;
  }): Promise<PlatformUserAgentMaterializationItem | undefined> =>
    // Materialization is a reference to a platform Agent, so it joins the same
    // referenceable-Agent protocol as assignment writes: reject when the Agent has been
    // archived (or is missing / migration-pending) under the shared per-Agent lock.
    inTransaction(this.db, async (tx) => {
      const scoped = new PlatformAgentCatalogRepository(tx);
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return undefined;
      const hasHidden = Object.hasOwn(params, 'hidden') && params.hidden !== undefined;
      const hasLastErrorCategory =
        Object.hasOwn(params, 'lastErrorCategory') && params.lastErrorCategory !== undefined;
      const hasMaterializedAgent =
        Object.hasOwn(params, 'materializedAgentId') && params.materializedAgentId !== undefined;
      const status =
        params.status ??
        (hasMaterializedAgent
          ? params.materializedAgentId === null
            ? 'pending'
            : 'materialized'
          : undefined);
      const lastErrorCategory = hasLastErrorCategory
        ? params.lastErrorCategory
        : status && status !== 'error'
          ? null
          : undefined;
      // A real materialization reference carries real state; a visibility-only row (written by
      // setMaterializationHidden to hold only the hidden preference) does NOT — see
      // countAgentReferences. `upsertMaterialization` always intends a real materialization, so a
      // visibility-only row is never "already in the desired state": it must be upgraded, not
      // early-returned. This is what closes the visibility-first → materialize bypass.
      const isRealMaterialization = (item: PlatformUserAgentMaterializationItem) =>
        item.materializedAgentId !== null || item.lastSyncedAt !== null;
      const matchesDesiredState = (item: PlatformUserAgentMaterializationItem) =>
        isRealMaterialization(item) &&
        item.platformAgentVersionId === params.platformAgentVersionId &&
        item.platformAgentVersionChecksum === params.platformAgentVersionChecksum &&
        (!hasHidden || item.hidden === params.hidden) &&
        (!hasMaterializedAgent || item.materializedAgentId === params.materializedAgentId) &&
        (!(hasLastErrorCategory || (status && status !== 'error')) ||
          item.lastErrorCategory === lastErrorCategory) &&
        (!status || item.status === status);
      const insertValues = {
        hidden: params.hidden ?? false,
        lastErrorCategory,
        lastSyncedAt: new Date(),
        materializedAgentId: params.materializedAgentId,
        platformAgentId: params.platformAgentId,
        platformAgentVersionChecksum: params.platformAgentVersionChecksum,
        platformAgentVersionId: params.platformAgentVersionId,
        status: status ?? 'pending',
        userId: params.userId,
      };
      if (!params.expectedCurrent) {
        const [inserted] = await tx
          .insert(platformUserAgentMaterializations)
          .values(insertValues)
          .onConflictDoNothing({
            target: [
              platformUserAgentMaterializations.userId,
              platformUserAgentMaterializations.platformAgentId,
            ],
          })
          .returning();
        if (inserted) return inserted;
        const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
        if (!existing) return undefined;
        // No-expectedCurrent conflict resolves to exactly one of three cases:
        //   1) a real materialization already in the desired state → idempotent, do not refresh;
        if (matchesDesiredState(existing)) return existing;
        //   2) a real materialization NOT in the desired state → refuse: without an explicit
        //      expectedCurrent CAS we must never clobber it (e.g. overwrite a real v1 with v2);
        if (isRealMaterialization(existing)) return undefined;
        //   3) a visibility-only row → atomically upgrade it in place (below).
        const resolvedStatus = status ?? 'pending';
        // Atomic upgrade under the same per-Agent reference lock: stamp last_synced_at (the real
        // materialization marker) and write the target version/checksum/status, preserving the
        // owner's hidden preference unless the caller explicitly overrides it.
        const [upgraded] = await tx
          .update(platformUserAgentMaterializations)
          .set({
            ...(hasHidden ? { hidden: params.hidden } : {}),
            ...(hasMaterializedAgent ? { materializedAgentId: params.materializedAgentId } : {}),
            lastErrorCategory:
              resolvedStatus === 'error' ? (params.lastErrorCategory ?? null) : null,
            lastSyncedAt: new Date(),
            platformAgentVersionChecksum: params.platformAgentVersionChecksum,
            platformAgentVersionId: params.platformAgentVersionId,
            status: resolvedStatus,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(platformUserAgentMaterializations.userId, params.userId),
              eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
            ),
          )
          .returning();
        return upgraded && matchesDesiredState(upgraded) ? upgraded : undefined;
      }

      const set = {
        ...(hasHidden ? { hidden: params.hidden } : {}),
        ...(hasLastErrorCategory || (status && status !== 'error') ? { lastErrorCategory } : {}),
        ...(hasMaterializedAgent ? { materializedAgentId: params.materializedAgentId } : {}),
        ...(status ? { status } : {}),
        lastSyncedAt: new Date(),
        platformAgentVersionChecksum: params.platformAgentVersionChecksum,
        platformAgentVersionId: params.platformAgentVersionId,
        updatedAt: new Date(),
      };
      const stableMaterializedAgentId = !hasMaterializedAgent
        ? undefined
        : typeof params.materializedAgentId === 'string'
          ? or(
              isNull(platformUserAgentMaterializations.materializedAgentId),
              eq(platformUserAgentMaterializations.materializedAgentId, params.materializedAgentId),
            )
          : isNull(platformUserAgentMaterializations.materializedAgentId);
      const [updated] = await tx
        .update(platformUserAgentMaterializations)
        .set(set)
        .where(
          and(
            eq(platformUserAgentMaterializations.userId, params.userId),
            eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
            eq(
              platformUserAgentMaterializations.platformAgentVersionId,
              params.expectedCurrent.versionId,
            ),
            eq(
              platformUserAgentMaterializations.platformAgentVersionChecksum,
              params.expectedCurrent.checksum,
            ),
            stableMaterializedAgentId,
          ),
        )
        .returning();
      // The UPDATE is the CAS: it only writes when the row still matches expectedCurrent (and the
      // materialized-agent guard). A correct expectedCurrent updates / upgrades; a wrong one never
      // writes. The fallback below is a pure read-back — it returns the row only when it is ALREADY
      // a real materialization in the desired state (matchesDesiredState requires
      // isRealMaterialization), so a wrong expectedCurrent against a visibility-only or otherwise
      // non-matching row yields undefined and never a fallback upgrade.
      if (updated) return updated;
      const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
      return existing && matchesDesiredState(existing) ? existing : undefined;
    });
}
