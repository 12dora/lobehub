import { and, asc, desc, eq, gt, ilike, lt, or, sql } from 'drizzle-orm';

import {
  type NewPlatformSkill,
  type NewPlatformSkillVersion,
  platformAgents,
  platformAgentVersions,
  type PlatformDistribution,
  platformResourceRevisions,
  type PlatformResourceStatus,
  type PlatformSkillItem,
  platformSkills,
  type PlatformSkillSource,
  type PlatformSkillVersionItem,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

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
  skill: PlatformSkillItem;
  version: PlatformSkillVersionItem;
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

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareDependent = (left: PlatformSkillDependent, right: PlatformSkillDependent) =>
  compareCodepoint(left.type, right.type) ||
  compareCodepoint(left.key, right.key) ||
  compareCodepoint(left.version, right.version) ||
  compareCodepoint(left.id, right.id);

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
    const limit = Math.min(params.limit ?? 50, 100);
    const conditions = [];
    if (params.cursor) conditions.push(gt(platformSkills.skillKey, params.cursor));
    if (params.distribution) {
      conditions.push(eq(platformSkills.distribution, params.distribution));
    }
    if (params.enabled !== undefined) conditions.push(eq(platformSkills.enabled, params.enabled));
    if (params.query) {
      const query = `%${params.query}%`;
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
    const limit = Math.min(params.limit ?? 50, 100);
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

  listPublished = async (): Promise<PlatformPublishedSkillRow[]> => {
    return this.db
      .select({ skill: platformSkills, version: platformSkillVersions })
      .from(platformSkills)
      .innerJoin(
        platformSkillVersions,
        eq(platformSkills.currentVersionId, platformSkillVersions.id),
      )
      .where(and(eq(platformSkills.status, 'published'), eq(platformSkills.enabled, true)))
      .orderBy(asc(platformSkills.skillKey));
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

  resolveVersion = async (
    skillKey: string,
    version?: string,
  ): Promise<PlatformPublishedSkillRow | undefined> => {
    const conditions = [eq(platformSkills.skillKey, skillKey)];
    if (version) {
      conditions.push(eq(platformSkillVersions.version, version));
    } else {
      conditions.push(
        eq(platformSkills.status, 'published'),
        eq(platformSkills.enabled, true),
        eq(platformSkills.currentVersionId, platformSkillVersions.id),
      );
    }
    const [row] = await this.db
      .select({ skill: platformSkills, version: platformSkillVersions })
      .from(platformSkills)
      .innerJoin(platformSkillVersions, eq(platformSkillVersions.skillId, platformSkills.id))
      .where(and(...conditions))
      .limit(1);
    if (!row) return undefined;
    if (!version) {
      return row.skill.id === row.version.skillId ? row : undefined;
    }
    if (row.skill.status === 'published' && row.skill.currentVersionId === row.version.id) {
      return row;
    }
    return (await this.wasVersionPublished(row.skill.id, row.version.id)) ? row : undefined;
  };

  getDependentsPage = async (params: {
    cursor?: PlatformSkillDependentCursor;
    limit?: number;
    skillKey: string;
    version?: string;
  }) => {
    const limit = Math.min(params.limit ?? 50, 100);
    const agentCursorCondition = params.cursor
      ? params.cursor.type === 'skill'
        ? sql`false`
        : sql`(${platformAgents.agentKey}, ${platformAgentVersions.version}, ${platformAgentVersions.id}) > (${params.cursor.key}, ${params.cursor.version}, ${params.cursor.id})`
      : undefined;
    const skillCursorCondition = params.cursor
      ? params.cursor.type === 'agent'
        ? undefined
        : sql`(${platformSkills.skillKey}, ${platformSkillVersions.version}, ${platformSkillVersions.id}) > (${params.cursor.key}, ${params.cursor.version}, ${params.cursor.id})`
      : undefined;
    const versionCondition = params.version
      ? sql`dependency->>'version' = ${params.version}`
      : sql`true`;
    const skillRows = await this.db
      .select({
        id: platformSkillVersions.id,
        name: platformSkills.name,
        key: platformSkills.skillKey,
        version: platformSkillVersions.version,
      })
      .from(platformSkillVersions)
      .innerJoin(platformSkills, eq(platformSkillVersions.skillId, platformSkills.id))
      .where(
        and(
          eq(platformSkills.status, 'published'),
          skillCursorCondition,
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${platformSkillVersions.manifest}->'skillDependencies') dependency
            WHERE dependency->>'skillKey' = ${params.skillKey} AND ${versionCondition}
          )`,
        ),
      )
      .orderBy(
        asc(platformSkills.skillKey),
        asc(platformSkillVersions.version),
        asc(platformSkillVersions.id),
      )
      .limit(limit + 1);
    const agentRows = await this.db
      .select({
        id: platformAgentVersions.id,
        key: platformAgents.agentKey,
        name: platformAgents.title,
        version: platformAgentVersions.version,
      })
      .from(platformAgentVersions)
      .innerJoin(platformAgents, eq(platformAgentVersions.agentId, platformAgents.id))
      .where(
        and(
          eq(platformAgents.status, 'published'),
          agentCursorCondition,
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${platformAgentVersions.config}->'skills') dependency
            WHERE dependency->>'skillKey' = ${params.skillKey} AND ${versionCondition}
          )`,
        ),
      )
      .orderBy(
        asc(platformAgents.agentKey),
        asc(platformAgentVersions.version),
        asc(platformAgentVersions.id),
      )
      .limit(limit + 1);

    const merged: PlatformSkillDependent[] = [
      ...agentRows.map((row) => ({ ...row, type: 'agent' as const })),
      ...skillRows.map((row) => ({ ...row, type: 'skill' as const })),
    ].sort(compareDependent);
    const hasMore = merged.length > limit;
    const items = hasMore ? merged.slice(0, limit) : merged;
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? { id: last.id, key: last.key, type: last.type, version: last.version }
          : null,
    };
  };
}
