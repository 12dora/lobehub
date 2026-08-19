import { and, asc, eq, or, sql } from 'drizzle-orm';

import {
  platformAgents,
  platformAgentVersions,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import type { PlatformSkillDependent, PlatformSkillDependentCursor } from './index';

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareDependent = (left: PlatformSkillDependent, right: PlatformSkillDependent) =>
  compareCodepoint(left.type, right.type) ||
  compareCodepoint(left.key, right.key) ||
  compareCodepoint(left.version, right.version) ||
  compareCodepoint(left.id, right.id);

export interface SkillDependentsQuery {
  cursor?: PlatformSkillDependentCursor;
  limit: number;
  skillKey: string;
  version?: string;
}

const dependencyVersionCondition = (version?: string) =>
  version ? sql`dependency->>'version' = ${version}` : sql`true`;

export const selectSkillDependents = (
  db: LobeChatDatabase | Transaction,
  params: SkillDependentsQuery,
) => {
  const skillCursorCondition = params.cursor
    ? params.cursor.type === 'agent'
      ? undefined
      : sql`(${platformSkills.skillKey}, ${platformSkillVersions.version}, ${platformSkillVersions.id}) > (${params.cursor.key}, ${params.cursor.version}, ${params.cursor.id})`
    : undefined;
  const versionCondition = dependencyVersionCondition(params.version);
  return db
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
        or(
          and(
            eq(platformSkills.status, 'published'),
            eq(platformSkills.currentVersionId, platformSkillVersions.id),
          ),
          sql`EXISTS (
              SELECT 1 FROM ${platformResourceRevisions} skill_revision
              WHERE skill_revision.resource_type = 'skill'
                AND skill_revision.resource_id = ${platformSkills.id}
                AND skill_revision.status = 'published'
                AND skill_revision.payload->>'versionId' = ${platformSkillVersions.id}
            )`,
        )!,
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
    .limit(params.limit + 1);
};

export const selectAgentDependents = (
  db: LobeChatDatabase | Transaction,
  params: SkillDependentsQuery,
) => {
  const agentCursorCondition = params.cursor
    ? params.cursor.type === 'skill'
      ? sql`false`
      : sql`(${platformAgents.agentKey}, ${platformAgentVersions.version}, ${platformAgentVersions.id}) > (${params.cursor.key}, ${params.cursor.version}, ${params.cursor.id})`
    : undefined;
  const versionCondition = dependencyVersionCondition(params.version);
  return db
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
        or(
          and(
            eq(platformAgents.status, 'published'),
            eq(platformAgents.migrationRequired, false),
            eq(platformAgents.currentVersionId, platformAgentVersions.id),
          ),
          sql`EXISTS (
              SELECT 1 FROM ${platformResourceRevisions} agent_revision
              WHERE agent_revision.resource_type = 'agent'
                AND agent_revision.resource_id = ${platformAgents.id}
                AND agent_revision.status = 'published'
                AND agent_revision.payload->>'versionId' = ${platformAgentVersions.id}
            )`,
        )!,
        agentCursorCondition,
        sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${platformAgentVersions.dependencySnapshot}->'skills') dependency
            WHERE dependency->>'skillKey' = ${params.skillKey} AND ${versionCondition}
          )`,
      ),
    )
    .orderBy(
      asc(platformAgents.agentKey),
      asc(platformAgentVersions.version),
      asc(platformAgentVersions.id),
    )
    .limit(params.limit + 1);
};

export const mergeDependentPage = (
  agentRows: { id: string; key: string; name: string; version: string }[],
  skillRows: { id: string; key: string; name: string; version: string }[],
  limit: number,
) => {
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
