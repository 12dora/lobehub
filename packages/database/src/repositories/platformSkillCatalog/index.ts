import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformSkill,
  type NewPlatformSkillVersion,
  type PlatformDistribution,
  platformResourceRevisions,
  type PlatformResourceStatus,
  type PlatformRevisionStatus,
  type PlatformSkillItem,
  platformSkills,
  type PlatformSkillSource,
  type PlatformSkillVersionItem,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { boundedLimit } from '../platformPagination';
import { likeContains } from '../platformSearch';
import { mergeDependentPage, selectAgentDependents, selectSkillDependents } from './dependents';
import type { PublishedSkillJoinRow } from './publishedJoin';
import { joinPublishedSkillVersions, joinPublishedSkillVersionsExact } from './publishedJoin';

export interface PlatformSkillPage {
  items: PlatformSkillItem[];
  nextCursor: string | null;
}

export interface PlatformSkillDependent {
  id: string;
  key: string;
  name: string;
  type: 'agent' | 'skill';
  version: string;
}

export interface PlatformPublishedSkillRow {
  payload: PlatformPublishedSkillSnapshot;
  revision: number;
  skillId: string;
  status: PlatformRevisionStatus;
  version: PlatformSkillVersionItem;
}

export interface PlatformPublishedSkillSnapshot {
  builtinOverrideTombstone?: true;
  skill: {
    allowBuiltinOverride: boolean;
    description: string | null;
    displayName: string;
    distribution: PlatformDistribution;
    enabled: boolean;
    skillKey: string;
    source: PlatformSkillSource;
  };
  versionId: string;
}

export interface PlatformSkillExactReference {
  skillKey: string;
  version: string;
}

export interface PlatformPublishedSkillPage {
  items: PlatformPublishedSkillRow[];
  nextCursor: string | null;
}

export interface PlatformSkillVersionCursor {
  createdAt: Date;
  id: string;
}

export interface PlatformSkillDependentCursor {
  id: string;
  key: string;
  type: 'agent' | 'skill';
  version: string;
}

/** Persistence boundary for stable Skill identities and append-only Skill versions. */
export class PlatformSkillCatalogRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  createSkill = async (values: NewPlatformSkill): Promise<PlatformSkillItem> => {
    const [row] = await this.db.insert(platformSkills).values(values).returning();
    return row;
  };

  createVersion = async (values: NewPlatformSkillVersion): Promise<PlatformSkillVersionItem> => {
    const [row] = await this.db.insert(platformSkillVersions).values(values).returning();
    return row;
  };

  getSkill = async (id: string): Promise<PlatformSkillItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkills)
      .where(eq(platformSkills.id, id))
      .limit(1);
    return row;
  };

  getSkillByKey = async (skillKey: string): Promise<PlatformSkillItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkills)
      .where(eq(platformSkills.skillKey, skillKey))
      .limit(1);
    return row;
  };

  getVersion = async (
    skillId: string,
    versionId: string,
  ): Promise<PlatformSkillVersionItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkillVersions)
      .where(
        and(eq(platformSkillVersions.skillId, skillId), eq(platformSkillVersions.id, versionId)),
      )
      .limit(1);
    return row;
  };

  getVersionByNumber = async (
    skillId: string,
    version: string,
  ): Promise<PlatformSkillVersionItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkillVersions)
      .where(
        and(eq(platformSkillVersions.skillId, skillId), eq(platformSkillVersions.version, version)),
      )
      .limit(1);
    return row;
  };

  listSkills = async (params: {
    cursor?: string;
    distribution?: PlatformDistribution;
    enabled?: boolean;
    limit?: number;
    query?: string;
    source?: PlatformSkillSource;
    status?: PlatformResourceStatus;
  }): Promise<PlatformSkillPage> => {
    const limit = boundedLimit(params.limit);
    const conditions = [];
    if (params.cursor) conditions.push(gt(platformSkills.skillKey, params.cursor));
    if (params.distribution) {
      conditions.push(eq(platformSkills.distribution, params.distribution));
    }
    if (params.enabled !== undefined) conditions.push(eq(platformSkills.enabled, params.enabled));
    if (params.query) {
      const query = likeContains(params.query);
      conditions.push(
        or(
          ilike(platformSkills.skillKey, query),
          ilike(platformSkills.name, query),
          ilike(platformSkills.description, query),
        )!,
      );
    }
    if (params.source) conditions.push(eq(platformSkills.source, params.source));
    if (params.status) conditions.push(eq(platformSkills.status, params.status));

    const rows = await this.db
      .select()
      .from(platformSkills)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(platformSkills.skillKey))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.skillKey ?? null) : null,
    };
  };

  getLatestVersion = async (skillId: string): Promise<PlatformSkillVersionItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkillVersions)
      .where(eq(platformSkillVersions.skillId, skillId))
      .orderBy(desc(platformSkillVersions.createdAt), desc(platformSkillVersions.id))
      .limit(1);
    return row;
  };

  listVersionPage = async (params: {
    cursor?: PlatformSkillVersionCursor;
    limit?: number;
    skillId: string;
  }) => {
    const limit = boundedLimit(params.limit);
    const conditions = [eq(platformSkillVersions.skillId, params.skillId)];
    if (params.cursor) {
      conditions.push(
        or(
          lt(platformSkillVersions.createdAt, params.cursor.createdAt),
          and(
            eq(platformSkillVersions.createdAt, params.cursor.createdAt),
            lt(platformSkillVersions.id, params.cursor.id),
          ),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(platformSkillVersions)
      .where(and(...conditions))
      .orderBy(desc(platformSkillVersions.createdAt), desc(platformSkillVersions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  };

  getLastPublishedRevisions = async (
    skillId: string,
    versionIds: string[],
  ): Promise<Map<string, number>> => {
    if (versionIds.length === 0) return new Map();
    const versionId = sql<string>`${platformResourceRevisions.payload}->>'versionId'`;
    const rows = await this.db
      .select({
        lastPublishedRevision: sql<number>`MAX(${platformResourceRevisions.revision})`,
        versionId,
      })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'skill'),
          eq(platformResourceRevisions.resourceId, skillId),
          eq(platformResourceRevisions.status, 'published'),
          inArray(versionId, versionIds),
        ),
      )
      .groupBy(versionId);
    return new Map(rows.map((row) => [row.versionId, Number(row.lastPublishedRevision)]));
  };

  listPublished = async (
    params: {
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<PlatformPublishedSkillPage> => {
    const limit = boundedLimit(params.limit);
    const snapshotSkillKey = sql<string>`${platformResourceRevisions.payload}->'skill'->>'skillKey'`;
    const conditions = [
      eq(platformResourceRevisions.resourceType, 'skill'),
      inArray(platformResourceRevisions.status, ['published', 'archived']),
      sql`COALESCE((${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean, false)`,
      eq(platformResourceRevisions.revision, platformSkills.revision),
    ];
    if (params.cursor) conditions.push(gt(snapshotSkillKey, params.cursor));
    const rows = await joinPublishedSkillVersions(this.db)
      .where(and(...conditions))
      .orderBy(asc(snapshotSkillKey))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row: PublishedSkillJoinRow) => ({
      ...row,
      payload: row.payload as unknown as PlatformPublishedSkillSnapshot,
    }));
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.payload.skill.skillKey ?? null) : null,
    };
  };

  lockSkill = async (id: string): Promise<PlatformSkillItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformSkills)
      .where(eq(platformSkills.id, id))
      .for('update')
      .limit(1);
    return row;
  };

  updateSkill = async (
    id: string,
    values: Partial<Omit<NewPlatformSkill, 'id' | 'skillKey'>>,
  ): Promise<PlatformSkillItem | undefined> => {
    const [row] = await this.db
      .update(platformSkills)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(platformSkills.id, id))
      .returning();
    return row;
  };

  updateSkillDraft = async (
    id: string,
    values: Partial<Omit<NewPlatformSkill, 'draftSequence' | 'id' | 'skillKey'>>,
  ): Promise<PlatformSkillItem | undefined> => {
    const [row] = await this.db
      .update(platformSkills)
      .set({
        ...values,
        draftSequence: sql`${platformSkills.draftSequence} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(platformSkills.id, id))
      .returning();
    return row;
  };

  bumpDraftSequence = async (id: string): Promise<number | undefined> => {
    const [row] = await this.db
      .update(platformSkills)
      .set({
        draftSequence: sql`${platformSkills.draftSequence} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(platformSkills.id, id))
      .returning({ draftSequence: platformSkills.draftSequence });
    return row?.draftSequence;
  };

  wasVersionPublished = async (skillId: string, versionId: string): Promise<boolean> => {
    const [row] = await this.db
      .select({ id: platformResourceRevisions.id })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'skill'),
          eq(platformResourceRevisions.resourceId, skillId),
          eq(platformResourceRevisions.status, 'published'),
          sql`${platformResourceRevisions.payload}->>'versionId' = ${versionId}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  };

  getPublishedRevisionForVersion = async (
    skillId: string,
    versionId: string,
  ): Promise<number | undefined> => {
    const [row] = await this.db
      .select({ revision: platformResourceRevisions.revision })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'skill'),
          eq(platformResourceRevisions.resourceId, skillId),
          eq(platformResourceRevisions.status, 'published'),
          sql`${platformResourceRevisions.payload}->>'versionId' = ${versionId}`,
        ),
      )
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(1);
    return row?.revision;
  };

  resolveVersion = async (
    skillKey: string,
    version?: string,
  ): Promise<PlatformPublishedSkillRow | undefined> => {
    const conditions = [
      eq(platformSkills.skillKey, skillKey),
      eq(platformResourceRevisions.resourceType, 'skill'),
      eq(platformResourceRevisions.resourceId, platformSkills.id),
      eq(platformResourceRevisions.status, 'published'),
      eq(platformSkillVersions.id, sql<string>`${platformResourceRevisions.payload}->>'versionId'`),
    ];
    if (version) {
      conditions.push(eq(platformSkillVersions.version, version));
    } else {
      conditions.push(
        eq(platformResourceRevisions.revision, platformSkills.revision),
        sql`COALESCE((${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean, false)`,
      );
    }
    const [row] = await joinPublishedSkillVersions(this.db)
      .where(and(...conditions))
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(1);
    if (!row) return undefined;
    return { ...row, payload: row.payload as unknown as PlatformPublishedSkillSnapshot };
  };

  /**
   * Publication-only exact read for dependents such as platform Agents.
   * Unlike resolveVersion, this additionally requires the current Skill identity
   * and the historical published snapshot to remain enabled and key-consistent.
   */
  getPublishedExecutionVersionExact = async (
    skillKey: string,
    version: string,
  ): Promise<PlatformPublishedSkillRow | undefined> => {
    const [row] = await joinPublishedSkillVersions(this.db)
      .where(
        and(
          eq(platformSkills.skillKey, skillKey),
          eq(platformSkills.status, 'published'),
          eq(platformSkills.enabled, true),
          eq(platformResourceRevisions.status, 'published'),
          eq(platformSkillVersions.version, version),
          sql`COALESCE((${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean, false)`,
          sql`${platformResourceRevisions.payload}->'skill'->>'skillKey' = ${skillKey}`,
        ),
      )
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(1);
    if (!row) return undefined;
    return { ...row, payload: row.payload as unknown as PlatformPublishedSkillSnapshot };
  };

  /**
   * Batch form of {@link resolveVersion} for explicit (skillKey, version) pairs.
   * Skill dependency graph validation uses this to resolve a whole frontier in one query.
   */
  resolveVersionsExact = async (
    references: readonly { skillKey: string; version: string }[],
  ): Promise<Map<string, PlatformPublishedSkillRow>> => {
    if (references.length === 0) return new Map();
    const requestedPairs = references.map(({ skillKey, version }) =>
      and(eq(platformSkills.skillKey, skillKey), eq(platformSkillVersions.version, version)),
    );
    // Join identity — must key the batch map by the *requested* skillKey so a
    // renamed skill still hits the map and surfaces dependency_identity_mismatch
    // (payload.skill.skillKey may diverge from the table identity).
    const rows = await joinPublishedSkillVersionsExact(this.db)
      .where(and(eq(platformResourceRevisions.status, 'published'), or(...requestedPairs)))
      .orderBy(
        asc(platformSkills.skillKey),
        asc(platformSkillVersions.version),
        desc(platformResourceRevisions.revision),
      );

    const exact = new Map<string, PlatformPublishedSkillRow>();
    for (const row of rows) {
      const payload = row.payload as unknown as PlatformPublishedSkillSnapshot;
      const key = `${row.skillKey}\0${row.version.version}`;
      if (!exact.has(key)) exact.set(key, { ...row, payload });
    }
    return exact;
  };

  /**
   * Batch form of {@link getPublishedExecutionVersionExact}. The Agent contract permits up to 100
   * Skill refs, so validation must not turn one request into 100 sequential roundtrips.
   */
  getPublishedExecutionVersionsExact = async (
    references: readonly PlatformSkillExactReference[],
  ): Promise<Map<string, PlatformPublishedSkillRow>> => {
    if (references.length === 0) return new Map();
    const requestedPairs = references.map(({ skillKey, version }) =>
      and(eq(platformSkills.skillKey, skillKey), eq(platformSkillVersions.version, version)),
    );
    const rows = await joinPublishedSkillVersions(this.db)
      .where(
        and(
          eq(platformSkills.status, 'published'),
          eq(platformSkills.enabled, true),
          eq(platformResourceRevisions.status, 'published'),
          sql`COALESCE((${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean, false)`,
          sql`${platformResourceRevisions.payload}->'skill'->>'skillKey' = ${platformSkills.skillKey}`,
          or(...requestedPairs),
        ),
      )
      .orderBy(
        asc(platformSkills.skillKey),
        asc(platformSkillVersions.version),
        desc(platformResourceRevisions.revision),
      );

    const exact = new Map<string, PlatformPublishedSkillRow>();
    for (const row of rows) {
      const payload = row.payload as unknown as PlatformPublishedSkillSnapshot;
      const key = `${payload.skill.skillKey}\0${row.version.version}`;
      if (!exact.has(key)) exact.set(key, { ...row, payload });
    }
    return exact;
  };

  getDependentsPage = async (params: {
    cursor?: PlatformSkillDependentCursor;
    limit?: number;
    skillKey: string;
    version?: string;
  }) => {
    const limit = boundedLimit(params.limit);
    const query = { ...params, limit };
    const skillRows = await selectSkillDependents(this.db, query);
    const agentRows = await selectAgentDependents(this.db, query);
    return mergeDependentPage(agentRows, skillRows, limit);
  };
}
