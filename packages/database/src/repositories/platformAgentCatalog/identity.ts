/**
 * Agent identity / version aggregate (DB-005).
 */
import type { PlatformAgentDependencySnapshot, PlatformAgentVersionConfig } from '@lobechat/types';
import { and, asc, eq, gt, ilike, isNotNull, sql } from 'drizzle-orm';

import { checksumPayload } from '../../models/platform/checksum';
import {
  type NewPlatformAgent,
  platformAgentAssignments,
  type PlatformAgentItem,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
  platformUserAgentMaterializationTombstones,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { idGenerator } from '../../utils/idGenerator';
import { inTransaction } from '../platform/tx';
import { boundedLimit } from '../platformPagination';
import { likeContains } from '../platformSearch';
import {
  acquirePlatformAgentReferenceLock,
  type ExactPlatformAgentVersion,
  type PlatformAgentDraftPatch,
  type PlatformAgentIdentityPage,
  type PlatformAgentVersionPage,
} from './types';

export class PlatformAgentIdentityRepository {
  constructor(protected readonly db: LobeChatDatabase | Transaction) {}

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

  getIdentityByAgentKey = async (agentKey: string): Promise<PlatformAgentItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAgents)
      .where(eq(platformAgents.agentKey, agentKey))
      .limit(1);
    return row;
  };

  listIdentities = async (params: {
    cursor?: string;
    isDefault?: boolean;
    limit?: number;
    query?: string;
    status?: PlatformAgentItem['status'];
  }): Promise<PlatformAgentIdentityPage> => {
    const limit = boundedLimit(params.limit);
    const rows = await this.db
      .select()
      .from(platformAgents)
      .where(
        and(
          eq(platformAgents.migrationRequired, false),
          params.cursor ? gt(platformAgents.agentKey, params.cursor) : undefined,
          params.isDefault === undefined
            ? undefined
            : eq(platformAgents.isDefault, params.isDefault),
          params.query ? ilike(platformAgents.agentKey, likeContains(params.query)) : undefined,
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

  /**
   * Every version label an Agent already owns, oldest first (`createdAt` asc with the opaque
   * id as a stable tie-break: version ids are generated identifiers and MUST NOT be read as
   * creation order alone).
   *
   * The next server-generated label is derived from the highest VALID SemVer in this set, so
   * the caller needs the whole set rather than just the newest row. Legacy / non-exact rows
   * are deliberately included: `(agent_id, version)` is unique across ALL version rows, so a
   * label chosen while ignoring them would collide on insert.
   */
  listVersionLabels = async (agentId: string): Promise<string[]> => {
    const rows = await this.db
      .select({ version: platformAgentVersions.version })
      .from(platformAgentVersions)
      .where(eq(platformAgentVersions.agentId, agentId))
      .orderBy(asc(platformAgentVersions.createdAt), asc(platformAgentVersions.id));
    return rows.map((row) => row.version);
  };

  listExactVersions = async (params: {
    agentId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PlatformAgentVersionPage> => {
    const limit = boundedLimit(params.limit);
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

  /**
   * Hard-delete a platform agent and every row it owns. Callers must construct this repository
   * with the mutation transaction and hold the identity row lock first.
   *
   * Order matters because every child FK is `restrict` and version rows are immutable:
   * 1. detach `currentVersionId` (RESTRICT FK) and demote to `archived` so the published-pointer
   *    trigger + CHECK constraint stay satisfied while the pointer is nulled;
   * 2. tombstone any local materializations (local `agents` rows are preserved for history, but
   *    must remain excluded from ordinary lists and mutation guards after the mapping is gone);
   * 3. delete live materialization mappings (they cannot outlive the platform Agent FKs);
   * 4. delete assignments (clears both the agent and pinned-version FKs);
   * 5. flip the transaction-local escape hatch so the version-immutability trigger permits DELETE,
   *    then delete the immutable version rows;
   * 6. delete the identity row.
   */
  hardDeleteAgentCascade = async (agentId: string): Promise<void> => {
    await this.db
      .update(platformAgents)
      .set({ currentVersionId: null, publishedAt: null, status: 'archived', updatedAt: new Date() })
      .where(eq(platformAgents.id, agentId));

    // Preserve provenance for surviving local clones before the live mapping is removed.
    const materializations = await this.db
      .select({
        materializedAgentId: platformUserAgentMaterializations.materializedAgentId,
        userId: platformUserAgentMaterializations.userId,
      })
      .from(platformUserAgentMaterializations)
      .where(eq(platformUserAgentMaterializations.platformAgentId, agentId));
    const tombstones = materializations
      .filter(
        (row): row is { materializedAgentId: string; userId: string } =>
          typeof row.materializedAgentId === 'string' && row.materializedAgentId.length > 0,
      )
      .map((row) => ({
        formerPlatformAgentId: agentId,
        id: idGenerator('platformUserAgentMaterializationTombstones', 16),
        materializedAgentId: row.materializedAgentId,
        userId: row.userId,
      }));
    if (tombstones.length > 0) {
      await this.db
        .insert(platformUserAgentMaterializationTombstones)
        .values(tombstones)
        // A prior hard-delete of another identity should never leave two tombstones for one local id.
        .onConflictDoNothing({
          target: platformUserAgentMaterializationTombstones.materializedAgentId,
        });
    }

    await this.db
      .delete(platformUserAgentMaterializations)
      .where(eq(platformUserAgentMaterializations.platformAgentId, agentId));
    await this.db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, agentId));
    // Transaction-scoped guard release (see migration 0140): version rows are otherwise immutable.
    await this.db.execute(
      sql`select set_config('lobe.allow_platform_agent_version_delete', 'on', true)`,
    );
    await this.db.delete(platformAgentVersions).where(eq(platformAgentVersions.agentId, agentId));
    await this.db.delete(platformAgents).where(eq(platformAgents.id, agentId));
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
  /** Shared by assignment + materialization aggregates (DB-005). */
  protected lockReferenceableAgent = async (
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
}
