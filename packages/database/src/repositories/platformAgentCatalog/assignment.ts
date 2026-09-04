/**
 * Agent assignment / rollout aggregate (DB-005).
 */
import type { PlatformAgentAssignmentTargetType } from '@lobechat/types';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import {
  platformAgentAssignments,
  type PlatformAgentItem,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '../../schemas/platform';
import { roles, userRoles } from '../../schemas/rbac';
import { users } from '../../schemas/user';
import { idGenerator } from '../../utils/idGenerator';
import { inTransaction } from '../platform/tx';
import { boundedLimit } from '../platformPagination';
import { PlatformAgentIdentityRepository } from './identity';
import {
  type ExactPlatformAgentVersion,
  type PlatformAgentAssignmentPage,
  type PlatformAgentAssignmentSafeItem,
  type PlatformAgentAssignmentTargetPage,
  type PlatformAgentAssignmentWrite,
  type PlatformAgentEffectiveInput,
  type PlatformAgentMaterializationDependentPage,
  type PlatformAgentRolloutMaterializationInput,
  type PlatformAgentRolloutMaterializationResult,
  safeAssignmentColumns,
  targetPriority,
} from './types';

export class PlatformAgentAssignmentRepository extends PlatformAgentIdentityRepository {
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
    const limit = boundedLimit(params.limit);
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
    const limit = boundedLimit(params.limit);
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
    cutoff?: string;
    targetId: string;
    targetType: PlatformAgentAssignmentTargetType;
  }): Promise<number> => {
    if (params.targetType === 'global') {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          params.cutoff ? sql`${users.createdAt} <= ${params.cutoff}::timestamptz` : undefined,
        );
      return row?.count ?? 0;
    }
    if (params.targetType === 'user') {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.id, params.targetId),
            params.cutoff ? sql`${users.createdAt} <= ${params.cutoff}::timestamptz` : undefined,
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
          params.cutoff ? sql`${users.createdAt} <= ${params.cutoff}::timestamptz` : undefined,
          params.cutoff ? sql`${userRoles.createdAt} <= ${params.cutoff}::timestamptz` : undefined,
          or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > CURRENT_TIMESTAMP`),
        ),
      );
    return row?.count ?? 0;
  };

  listAssignmentTargetUserIds = async (params: {
    cutoff: string;
    cursor?: string;
    limit?: number;
    targetId: string;
    targetType: PlatformAgentAssignmentTargetType;
  }): Promise<PlatformAgentAssignmentTargetPage> => {
    const limit = boundedLimit(params.limit, 100, 500);
    if (params.targetType === 'user') {
      if (params.cursor && params.targetId <= params.cursor) return { items: [], nextCursor: null };
      const [row] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, params.targetId),
            sql`${users.createdAt} <= ${params.cutoff}::timestamptz`,
          ),
        )
        .limit(1);
      return { items: row ? [row.id] : [], nextCursor: null };
    }

    const baseCondition = and(
      sql`${users.createdAt} <= ${params.cutoff}::timestamptz`,
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
                sql`${userRoles.createdAt} <= ${params.cutoff}::timestamptz`,
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
    const writableUserIdSet = new Set(writableUserIds);
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
        where: or(...casConditions.filter((_, index) => writableUserIdSet.has(userIds[index]))),
      })
      .returning({ userId: platformUserAgentMaterializations.userId });

    return {
      appliedUserIds: new Set(written.map(({ userId }) => userId)),
      previousByUserId,
    };
  };

  /**
   * Non-locking default-inbox pointer read. Callers that also take the per-Agent reference
   * lock must peek with this, then lock (2) then (3) — never `FOR UPDATE` the identity first.
   */
  getDefaultIdentity = async (): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.isDefault, true))
      .limit(1);
    return row;
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

  /**
   * Assignment-scoped effective inputs for one user. Optional `platformAgentId` / `systemKey`
   * filters keep single-agent entitlement paths from scanning the entire catalog.
   * Full-list callers MUST pass `limit` so a large catalog cannot force unbounded memory.
   */
  listEffectiveInputs = async (
    userId: string,
    filter?: { limit?: number; platformAgentId?: string; systemKey?: string },
  ): Promise<PlatformAgentEffectiveInput[]> => {
    // Assignments always follow the identity's current published version — ignore legacy pins.
    const effectiveVersionId = platformAgents.currentVersionId;
    const query = this.db
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
          filter?.platformAgentId ? eq(platformAgents.id, filter.platformAgentId) : undefined,
          filter?.systemKey ? eq(platformAgents.systemKey, filter.systemKey) : undefined,
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
    // Targeted single-agent / system-key lookups stay unbounded (tiny). Full-list path requires a
    // hard SQL ceiling so the repository never materializes an open-ended result set.
    const rows =
      filter?.limit !== undefined && filter.limit > 0
        ? await query.limit(filter.limit)
        : filter?.platformAgentId || filter?.systemKey
          ? await query
          : await query.limit(10_000);
    return rows as PlatformAgentEffectiveInput[];
  };
}
