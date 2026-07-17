import type {
  PlatformAgentAssignmentMode,
  PlatformAgentAssignmentTargetType,
  PlatformAgentDependencySnapshot,
  PlatformAgentSystemKey,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';

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
import type { LobeChatDatabase, Transaction } from '../../type';

type ExactPlatformAgentVersion = Omit<
  PlatformAgentVersionItem,
  'checksum' | 'config' | 'dependencySnapshot'
> & {
  checksum: string;
  config: PlatformAgentVersionConfig;
  dependencySnapshot: PlatformAgentDependencySnapshot;
};

export interface PlatformAgentEffectiveInput {
  agent: PlatformAgentItem;
  assignment: PlatformAgentAssignmentItem;
  targetPriority: 1 | 2 | 3;
  version: ExactPlatformAgentVersion;
}

export interface PlatformAgentDraftPatch {
  isDefault?: boolean;
  systemKey?: PlatformAgentSystemKey | null;
  updatedBy?: string | null;
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

  getLatestExactVersion = async (
    agentId: string,
  ): Promise<ExactPlatformAgentVersion | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgentVersions)
      .where(
        and(
          eq(platformAgentVersions.agentId, agentId),
          isNotNull(platformAgentVersions.checksum),
          isNotNull(platformAgentVersions.dependencySnapshot),
        ),
      )
      .orderBy(desc(platformAgentVersions.createdAt), desc(platformAgentVersions.id))
      .limit(1);
    return row as ExactPlatformAgentVersion | undefined;
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
  ): Promise<PlatformAgentAssignmentItem> => {
    const [row] = await this.db
      .insert(platformAgentAssignments)
      .values({ ...values, status: 'active' })
      .returning();
    return row;
  };

  updateAssignment = async (
    id: string,
    values: Omit<PlatformAgentAssignmentWrite, 'agentId'>,
  ): Promise<PlatformAgentAssignmentItem | undefined> => {
    const [row] = await this.db
      .update(platformAgentAssignments)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(platformAgentAssignments.id, id))
      .returning();
    return row;
  };

  deleteAssignment = async (id: string): Promise<PlatformAgentAssignmentItem | undefined> => {
    const [row] = await this.db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.id, id))
      .returning();
    return row;
  };

  getAssignment = async (id: string): Promise<PlatformAgentAssignmentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgentAssignments)
      .where(eq(platformAgentAssignments.id, id))
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
        assignment: platformAgentAssignments,
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
