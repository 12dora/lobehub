import type {
  PlatformAgentAssignmentMode,
  PlatformAgentAssignmentTargetType,
  PlatformAgentDependencySnapshot,
  PlatformAgentSystemKey,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

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

export interface PlatformAgentAssignmentWrite {
  agentId: string;
  enabled: boolean;
  mode: PlatformAgentAssignmentMode;
  pinnedVersionId: string | null;
  targetId: string;
  targetType: PlatformAgentAssignmentTargetType;
  versionPolicy: PlatformAgentVersionPolicy;
}

const isRootDatabase = (db: LobeChatDatabase | Transaction): db is LobeChatDatabase =>
  'transaction' in db;

const inTransaction = async <T>(
  db: LobeChatDatabase | Transaction,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> => (isRootDatabase(db) ? db.transaction(operation) : operation(db));

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

  createAssignment = async (
    values: PlatformAgentAssignmentWrite,
  ): Promise<PlatformAgentAssignmentSafeItem> => {
    const [row] = await this.db
      .insert(platformAgentAssignments)
      .values({ ...values, status: 'active' })
      .returning(safeAssignmentColumns);
    return row;
  };

  updateAssignment = async (
    agentId: string,
    id: string,
    values: Omit<PlatformAgentAssignmentWrite, 'agentId'>,
  ): Promise<PlatformAgentAssignmentSafeItem | undefined> => {
    const [row] = await this.db
      .update(platformAgentAssignments)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(eq(platformAgentAssignments.id, id), eq(platformAgentAssignments.agentId, agentId)),
      )
      .returning(safeAssignmentColumns);
    return row;
  };

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
      .where(eq(platformUserAgentMaterializations.platformAgentId, agentId));
    return {
      assignments: assignmentRow?.count ?? 0,
      materializations: materializationRow?.count ?? 0,
    };
  };

  countAssignmentTargets = async (params: {
    targetId: string;
    targetType: PlatformAgentAssignmentTargetType;
  }): Promise<number> => {
    if (params.targetType === 'global') {
      const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(users);
      return row?.count ?? 0;
    }
    if (params.targetType === 'user') {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.id, params.targetId));
      return row?.count ?? 0;
    }
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct ${userRoles.userId})::int` })
      .from(userRoles)
      .innerJoin(
        roles,
        and(eq(roles.id, userRoles.roleId), isNull(roles.workspaceId), eq(roles.isActive, true)),
      )
      .where(
        and(
          eq(userRoles.roleId, params.targetId),
          isNull(userRoles.workspaceId),
          or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > CURRENT_TIMESTAMP`),
        ),
      );
    return row?.count ?? 0;
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
  }): Promise<PlatformUserAgentMaterializationItem | undefined> => {
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
    const matchesDesiredState = (item: PlatformUserAgentMaterializationItem) =>
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
      const [inserted] = await this.db
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
      const existing = await this.getMaterialization(params.userId, params.platformAgentId);
      return existing && matchesDesiredState(existing) ? existing : undefined;
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
    const [updated] = await this.db
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
    if (updated) return updated;
    const existing = await this.getMaterialization(params.userId, params.platformAgentId);
    return existing && matchesDesiredState(existing) ? existing : undefined;
  };
}
