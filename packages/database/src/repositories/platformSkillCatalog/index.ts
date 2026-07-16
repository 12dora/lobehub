import { isRecord } from '@lobechat/utils/object';
import { and, asc, eq, gt, ilike, or } from 'drizzle-orm';

import {
  type NewPlatformSkill,
  type NewPlatformSkillVersion,
  platformAgents,
  platformAgentVersions,
  type PlatformDistribution,
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

const agentSkillReferences = (config: unknown): Array<{ skillKey: string; version: string }> => {
  if (!isRecord(config) || !Array.isArray(config.skills)) return [];
  return config.skills.flatMap((item) => {
    if (!isRecord(item) || typeof item.skillKey !== 'string' || typeof item.version !== 'string') {
      return [];
    }
    return [{ skillKey: item.skillKey, version: item.version }];
  });
};

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

  listVersions = async (skillId: string): Promise<PlatformSkillVersionItem[]> => {
    return this.db
      .select()
      .from(platformSkillVersions)
      .where(eq(platformSkillVersions.skillId, skillId))
      .orderBy(asc(platformSkillVersions.createdAt), asc(platformSkillVersions.id));
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
    return row;
  };

  getDependents = async (skillKey: string, version?: string): Promise<PlatformSkillDependent[]> => {
    const skillRows = await this.db
      .select({
        id: platformSkillVersions.id,
        manifest: platformSkillVersions.manifest,
        name: platformSkills.name,
        skillKey: platformSkills.skillKey,
        status: platformSkills.status,
        version: platformSkillVersions.version,
      })
      .from(platformSkillVersions)
      .innerJoin(platformSkills, eq(platformSkillVersions.skillId, platformSkills.id));
    const agentRows = await this.db
      .select({
        agentKey: platformAgents.agentKey,
        config: platformAgentVersions.config,
        id: platformAgentVersions.id,
        name: platformAgents.title,
        status: platformAgents.status,
        version: platformAgentVersions.version,
      })
      .from(platformAgentVersions)
      .innerJoin(platformAgents, eq(platformAgentVersions.agentId, platformAgents.id));

    const skillDependents = skillRows.flatMap((row): PlatformSkillDependent[] => {
      if (row.status !== 'published') return [];
      const matches = row.manifest.skillDependencies.some(
        (dependency) =>
          dependency.skillKey === skillKey && (!version || dependency.version === version),
      );
      return matches
        ? [{ id: row.id, key: row.skillKey, name: row.name, type: 'skill', version: row.version }]
        : [];
    });
    const agentDependents = agentRows.flatMap((row): PlatformSkillDependent[] => {
      if (row.status !== 'published') return [];
      const matches = agentSkillReferences(row.config).some(
        (dependency) =>
          dependency.skillKey === skillKey && (!version || dependency.version === version),
      );
      return matches
        ? [{ id: row.id, key: row.agentKey, name: row.name, type: 'agent', version: row.version }]
        : [];
    });
    return [...skillDependents, ...agentDependents].sort((left, right) =>
      `${left.type}:${left.key}:${left.version}`.localeCompare(
        `${right.type}:${right.key}:${right.version}`,
      ),
    );
  };
}
