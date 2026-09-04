import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { type PlatformAgentEffectiveInput } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { roles, userRoles } from '@/database/schemas/rbac';
import type { LobeChatDatabase } from '@/database/type';

import {
  PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
  type PlatformAgentEffectiveInputsFilter,
} from './effectiveResolverOrder';

type EffectiveInputFilter = PlatformAgentEffectiveInputsFilter;

/** Assignment-target priority expression — must match PlatformAgentCatalogRepository. */
const targetPrioritySql = sql<1 | 2 | 3>`CASE
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

/** Assignments always follow the identity's current published version — ignore legacy pins. */
const effectiveVersionIdSql = platformAgents.currentVersionId;

/** Normalize drizzle / node-pg / PGlite execute results into a row array. */
const rowsFromExecute = <T extends Record<string, unknown>>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
};

/**
 * Eligibility join/filter shared by targeted assignment scans and the full-list winner CTE.
 */
const eligibleAssignmentWhere = (
  userId: string,
  filter?: Pick<PlatformAgentEffectiveInputsFilter, 'platformAgentId' | 'systemKey'>,
) =>
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
  );

const selectEligibleAssignmentInputs = (
  db: LobeChatDatabase,
  userId: string,
  filter?: PlatformAgentEffectiveInputsFilter,
) =>
  db
    .select({
      agent: platformAgents,
      assignment: safeAssignmentColumns,
      targetPriority: targetPrioritySql,
      version: platformAgentVersions,
    })
    .from(platformAgentAssignments)
    .innerJoin(platformAgents, eq(platformAgents.id, platformAgentAssignments.agentId))
    .innerJoin(
      platformAgentVersions,
      and(
        eq(platformAgentVersions.agentId, platformAgents.id),
        eq(platformAgentVersions.id, effectiveVersionIdSql),
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
    .where(eligibleAssignmentWhere(userId, filter))
    .orderBy(desc(targetPrioritySql), platformAgents.agentKey, platformAgentAssignments.id);

/**
 * Targeted (single-agent / system-key) assignment scan — no hidden filter, no DISTINCT ON.
 * Authorization paths resolve first-winner in memory via {@link projectAuthorizedRows}.
 */
export const queryEligibleAssignmentInputs = async (
  db: LobeChatDatabase,
  userId: string,
  filter?: PlatformAgentEffectiveInputsFilter,
): Promise<PlatformAgentEffectiveInput[]> => {
  const query = selectEligibleAssignmentInputs(db, userId, filter);
  const isTargeted = Boolean(filter?.platformAgentId || filter?.systemKey);
  const rows =
    filter?.limit !== undefined && filter.limit > 0
      ? await query.limit(filter.limit)
      : isTargeted
        ? await query
        : await query.limit(10_000);
  return rows as PlatformAgentEffectiveInput[];
};

/**
 * Full-list production SQL (F5):
 * 1. DISTINCT ON (dedup_key) with priority order → canonical first winner per agent/system key
 *    (winner chosen regardless of hidden)
 * 2. Drop rows whose winner is hidden (mandatory never hidden)
 * 3. Order survivors by created_at DESC, id DESC and exclusive keyset-page
 *
 * Returns already-deduped, already-hidden-filtered winners so the resolver only accumulates
 * the wire cap (≤ 1000) — no unbounded in-memory seen sets.
 */
export const queryVisibleWinnerPage = async (
  db: LobeChatDatabase,
  userId: string,
  filter?: Pick<PlatformAgentEffectiveInputsFilter, 'cursor' | 'limit'>,
): Promise<PlatformAgentEffectiveInput[]> => {
  const limit =
    filter?.limit !== undefined && filter.limit > 0
      ? filter.limit
      : PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;
  const cursor = filter?.cursor;
  const cursorSql = cursor
    ? sql`AND (w.assignment_created_at, w.assignment_id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
    : sql``;

  // Step 1–3 in SQL: first-winner → hidden filter → created_at keyset page of assignment ids.
  const idResult = await db.execute(sql`
    WITH eligible AS (
      SELECT
        ${platformAgentAssignments.id} AS assignment_id,
        ${platformAgentAssignments.createdAt} AS assignment_created_at,
        ${platformAgents.id} AS agent_id,
        ${platformAgentAssignments.mode} AS mode,
        ${targetPrioritySql} AS target_priority,
        ${platformAgents.agentKey} AS agent_key,
        COALESCE(${platformAgents.systemKey}, ${platformAgents.id}) AS dedup_key
      FROM ${platformAgentAssignments}
      INNER JOIN ${platformAgents}
        ON ${platformAgents.id} = ${platformAgentAssignments.agentId}
      INNER JOIN ${platformAgentVersions}
        ON ${platformAgentVersions.agentId} = ${platformAgents.id}
        AND ${platformAgentVersions.id} = ${effectiveVersionIdSql}
        AND ${platformAgentVersions.checksum} IS NOT NULL
        AND ${platformAgentVersions.dependencySnapshot} IS NOT NULL
      LEFT JOIN ${userRoles}
        ON ${platformAgentAssignments.targetType} = 'global_role'
        AND ${platformAgentAssignments.targetId} = ${userRoles.roleId}
        AND ${userRoles.userId} = ${userId}
        AND ${userRoles.workspaceId} IS NULL
        AND (${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > CURRENT_TIMESTAMP)
      LEFT JOIN ${roles}
        ON ${roles.id} = ${userRoles.roleId}
        AND ${roles.workspaceId} IS NULL
        AND ${roles.isActive} = true
      WHERE ${platformAgentAssignments.enabled} = true
        AND ${platformAgentAssignments.status} = 'active'
        AND ${platformAgents.migrationRequired} = false
        AND ${platformAgents.status} = 'published'
        AND (
          ${platformAgentAssignments.targetType} = 'global'
          OR (
            ${platformAgentAssignments.targetType} = 'user'
            AND ${platformAgentAssignments.targetId} = ${userId}
          )
          OR (
            ${platformAgentAssignments.targetType} = 'global_role'
            AND ${roles.id} IS NOT NULL
          )
        )
    ),
    winners AS (
      SELECT DISTINCT ON (dedup_key)
        assignment_id,
        assignment_created_at,
        agent_id,
        mode,
        target_priority,
        agent_key,
        dedup_key
      FROM eligible
      ORDER BY dedup_key, target_priority DESC, agent_key ASC, assignment_id ASC
    )
    SELECT w.assignment_id AS assignment_id
    FROM winners w
    LEFT JOIN ${platformUserAgentMaterializations} m
      ON m.platform_agent_id = w.agent_id
      AND m.user_id = ${userId}
    WHERE (w.mode = 'mandatory' OR COALESCE(m.hidden, false) = false)
      ${cursorSql}
    ORDER BY w.assignment_created_at DESC, w.assignment_id DESC
    LIMIT ${limit}
  `);

  const pageIds = rowsFromExecute<{ assignment_id: string }>(idResult).map(
    (row) => row.assignment_id,
  );
  if (pageIds.length === 0) return [];

  // Hydrate full effective-input shapes for the ordered winner assignment ids.
  const hydrated = (await db
    .select({
      agent: platformAgents,
      assignment: safeAssignmentColumns,
      targetPriority: targetPrioritySql,
      version: platformAgentVersions,
    })
    .from(platformAgentAssignments)
    .innerJoin(platformAgents, eq(platformAgents.id, platformAgentAssignments.agentId))
    .innerJoin(
      platformAgentVersions,
      and(
        eq(platformAgentVersions.agentId, platformAgents.id),
        eq(platformAgentVersions.id, effectiveVersionIdSql),
        isNotNull(platformAgentVersions.checksum),
        isNotNull(platformAgentVersions.dependencySnapshot),
      ),
    )
    .where(inArray(platformAgentAssignments.id, pageIds))) as PlatformAgentEffectiveInput[];

  const byId = new Map(hydrated.map((row) => [row.assignment.id, row]));
  return pageIds
    .map((id) => byId.get(id))
    .filter((row): row is PlatformAgentEffectiveInput => Boolean(row));
};

/**
 * Production SQL page for effective inputs.
 *
 * - Full list: {@link queryVisibleWinnerPage} (DISTINCT ON → hidden → createdAt keyset).
 * - Targeted: {@link queryEligibleAssignmentInputs} (raw assignment rows; no hidden filter).
 */
export const queryEffectiveInputsPage = async (
  db: LobeChatDatabase,
  userId: string,
  filter?: PlatformAgentEffectiveInputsFilter,
): Promise<PlatformAgentEffectiveInput[]> => {
  const isTargeted = Boolean(filter?.platformAgentId || filter?.systemKey);
  if (isTargeted) {
    return queryEligibleAssignmentInputs(db, userId, filter);
  }
  return queryVisibleWinnerPage(db, userId, filter);
};

/**
 * Cross-batch NOTE (packages/database repository):
 * `PlatformAgentCatalogRepository.listEffectiveInputs` remains the targeted / auth assignment
 * scan (no cursor, no hidden filter). Full-list paging is owned by {@link queryVisibleWinnerPage}
 * in this service so DISTINCT ON + hidden-after-dedup + createdAt keyset stay one contract.
 * A future repository method may share the same CTE if other callers need the winner page.
 */
