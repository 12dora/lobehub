import type { PlatformAgentVersionConfig } from '@lobechat/types';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  type ManagedResourcePolicySnapshot,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  PlatformAgentCatalogRepository,
  type PlatformAgentEffectiveInput,
} from '@/database/repositories/platformAgentCatalog';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { roles, userRoles } from '@/database/schemas/rbac';
import type { LobeChatDatabase } from '@/database/type';

import type { platformAgentEffectiveListOutputSchema } from '../../contracts/platformAgents';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  redactPlatformReadError,
} from './errors';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;
type EffectiveAgent = EffectiveList['agents'][number];
type Distribution = EffectiveAgent['distribution'];

/** Matches `platformAgentEffectiveListOutputSchema.agents.max(1000)` — never exceed the wire contract. */
export const PLATFORM_AGENT_EFFECTIVE_LIST_MAX = 1000;

/**
 * SQL page size for full-list keyset pagination over **visible winners** (post DISTINCT ON +
 * hidden filter). The resolver walks pages until {@link PLATFORM_AGENT_EFFECTIVE_LIST_MAX}
 * winners are collected or the source is exhausted. Dedup lives in SQL — no growing in-memory
 * `seen` / systemKey sets across pages.
 */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH = PLATFORM_AGENT_EFFECTIVE_LIST_MAX;

/** @deprecated Prefer {@link PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH}; kept as the first-page size. */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_OVERSCAN = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;

/**
 * @deprecated Removed with keyset pagination — the resolver no longer caps scanned rows.
 * Retained as a numeric alias of the batch size so older imports compile during transition.
 */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_MAX_SCAN = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;

/**
 * Keyset cursor for full-list paging of **visible winners**.
 *
 * Stable list order (after SQL first-winner selection + hidden filter):
 * `assignment.created_at DESC, assignment.id DESC`.
 *
 * First-winner selection (DISTINCT ON) still uses the product priority order
 * `targetPriority DESC, agentKey ASC, assignment.id ASC` so multi-target assignments
 * keep user > global_role > global. Only the surviving winners are keyset-paged by recency.
 */
export interface PlatformAgentEffectiveInputCursor {
  createdAt: Date | string;
  id: string;
}

/**
 * Immutable, copy-safe exact-version snapshot captured at the start of one operation (R2).
 * A caller pins this value for the whole operation and never re-resolves the current pointer,
 * so publishing v2 mid-flight cannot swap the version out from under an in-progress operation.
 * The object and its `config` are deep-frozen; a caller mutation cannot pollute the resolver
 * or a later snapshot.
 */
export interface PlatformAgentOperationSnapshot {
  checksum: string;
  config: PlatformAgentVersionConfig;
  platformAgentId: string;
  versionId: string;
}

/**
 * Operation-scoped handle (R2). Wraps a single captured snapshot; `getSnapshot()` replays that
 * exact frozen value for the whole operation and never re-resolves the current pointer.
 */
export interface PlatformAgentOperationHandle {
  readonly distribution?: Distribution;
  getSnapshot: () => PlatformAgentOperationSnapshot;
  readonly platformAgentId: string;
}

/** Authorized (assignment-resolved) Agent before per-user hidden filtering. */
interface AuthorizedAgent {
  agentKey: string;
  checksum: string;
  config: PlatformAgentVersionConfig;
  distribution: Distribution;
  platformAgentId: string;
  systemKey: 'default-inbox' | null;
  version: string;
  versionId: string;
}

/**
 * Repository surface used by the resolver. Wider than a pure Pick so keyset `cursor` is part of
 * the contract. Production full-list paging uses in-service SQL when no custom repository is
 * injected; injected repositories (tests / overrides) MUST honor cursor the same way for
 * targeted paths that still go through the repository.
 */
export type PlatformAgentEffectiveInputsFilter = {
  /** Keyset after this visible-winner row (exclusive). Full-list path only. */
  cursor?: PlatformAgentEffectiveInputCursor;
  limit?: number;
  platformAgentId?: string;
  systemKey?: string;
};

type ResolverRepository = {
  listEffectiveInputs: (
    userId: string,
    filter?: PlatformAgentEffectiveInputsFilter,
  ) => Promise<PlatformAgentEffectiveInput[]>;
  listHiddenPlatformAgentIds: (
    userId: string,
  ) => Promise<Awaited<ReturnType<PlatformAgentCatalogRepository['listHiddenPlatformAgentIds']>>>;
};

interface PlatformAgentEffectiveResolverOptions {
  flags?: EnterpriseFeatureFlags;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  /**
   * Override for the production full-list keyset SQL ({@link queryEffectiveInputsPage}).
   * Tests inject a keyset-faithful fake here so regressions in cursor wiring fail; production
   * leaves this unset and always hits the real SQL builder.
   */
  queryEffectiveInputsPage?: (
    db: LobeChatDatabase,
    userId: string,
    filter?: PlatformAgentEffectiveInputsFilter,
  ) => Promise<PlatformAgentEffectiveInput[]>;
  repository?: ResolverRepository;
}

type EffectiveInputFilter = PlatformAgentEffectiveInputsFilter;

type EffectiveInputRow = PlatformAgentEffectiveInput;

/** Compare winner-list keyset order: createdAt DESC, assignment.id DESC. */
export const compareEffectiveWinnerOrder = (
  left: EffectiveInputRow,
  right: EffectiveInputRow,
): number => {
  const leftAt = toMillis(left.assignment.createdAt);
  const rightAt = toMillis(right.assignment.createdAt);
  return rightAt - leftAt || right.assignment.id.localeCompare(left.assignment.id);
};

/** Canonical first-winner priority: targetPriority DESC, agentKey ASC, assignment.id ASC. */
export const compareEffectiveInputPriority = (
  left: EffectiveInputRow,
  right: EffectiveInputRow,
): number =>
  right.targetPriority - left.targetPriority ||
  left.agent.agentKey.localeCompare(right.agent.agentKey) ||
  left.assignment.id.localeCompare(right.assignment.id);

/** @deprecated Prefer {@link compareEffectiveInputPriority} / {@link compareEffectiveWinnerOrder}. */
export const compareEffectiveInputOrder = compareEffectiveInputPriority;

export const cursorFromEffectiveInputRow = (
  row: EffectiveInputRow,
): PlatformAgentEffectiveInputCursor => ({
  createdAt: row.assignment.createdAt,
  id: row.assignment.id,
});

const toMillis = (value: Date | string | number): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
};

/**
 * True when `row` is strictly after `cursor` in winner list order
 * (`createdAt DESC, assignment.id DESC`).
 */
export const isEffectiveInputAfterCursor = (
  row: EffectiveInputRow,
  cursor: PlatformAgentEffectiveInputCursor,
): boolean => {
  const rowAt = toMillis(row.assignment.createdAt);
  const cursorAt = toMillis(cursor.createdAt);
  if (rowAt !== cursorAt) return rowAt < cursorAt;
  return row.assignment.id.localeCompare(cursor.id) < 0;
};

/**
 * In-memory stand-in for the production full-list SQL pipeline
 * ({@link queryVisibleWinnerPage}):
 * 1. first-winner per dedup key by priority (regardless of hidden)
 * 2. drop non-mandatory winners whose agent is hidden
 * 3. order surviving winners by createdAt DESC, id DESC
 * 4. exclusive keyset page + limit
 *
 * Used by unit tests only. Scale regressions must call the real SQL path.
 */
export const sliceEffectiveInputsByKeyset = (
  orderedRows: EffectiveInputRow[],
  filter?: Pick<PlatformAgentEffectiveInputsFilter, 'cursor' | 'limit'> & {
    hidden?: ReadonlySet<string>;
  },
): EffectiveInputRow[] => {
  const winners = projectFirstWinnersThenHide(orderedRows, filter?.hidden ?? new Set());
  winners.sort(compareEffectiveWinnerOrder);
  const limit = filter?.limit ?? winners.length;
  const cursor = filter?.cursor;
  let start = 0;
  if (cursor) {
    start = winners.findIndex((item) => isEffectiveInputAfterCursor(item, cursor));
    if (start < 0) return [];
  }
  return winners.slice(start, start + limit);
};

/**
 * First-winner per agent (and per systemKey) by priority, then drop hidden non-mandatory winners.
 * Mirrors the SQL DISTINCT ON → hidden-filter order so a lower-priority duplicate never resurfaces.
 */
export const projectFirstWinnersThenHide = (
  rows: EffectiveInputRow[],
  hidden: ReadonlySet<string>,
): EffectiveInputRow[] => {
  const byPriority = [...rows].sort(compareEffectiveInputPriority);
  const seenAgents = new Set<string>();
  const seenSystemKeys = new Set<string>();
  const winners: EffectiveInputRow[] = [];

  for (const row of byPriority) {
    if (seenAgents.has(row.agent.id)) continue;
    if (row.agent.systemKey && seenSystemKeys.has(row.agent.systemKey)) continue;
    seenAgents.add(row.agent.id);
    if (row.agent.systemKey) seenSystemKeys.add(row.agent.systemKey);

    const distribution = row.assignment.mode as Distribution;
    if (distribution !== 'mandatory' && hidden.has(row.agent.id)) {
      // Winner is hidden → whole key suppressed (do not fall through to a lower-priority row).
      continue;
    }
    winners.push(row);
  }
  return winners;
};

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

const effectiveVersionIdSql = sql<string>`CASE
  WHEN ${platformAgentAssignments.versionPolicy} = 'pinned'
    THEN ${platformAgentAssignments.pinnedVersionId}
  ELSE ${platformAgents.currentVersionId}
END`;

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

const isAgentRuntimeManaged = (snapshot: ManagedResourcePolicySnapshot): boolean =>
  snapshot.status === 'published' &&
  snapshot.published.agents.managed &&
  snapshot.published.agents.enforcementMode === 'enforced';

const emptyEffectiveList = (): EffectiveList => {
  const agents: EffectiveList['agents'] = [];
  return { agents, revision: checksumPayload({ agents }) };
};

/** Recursively freeze a structured-cloned value so no caller can mutate a captured snapshot. */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

const projectEffective = (agent: AuthorizedAgent): EffectiveAgent => ({
  agentKey: agent.agentKey,
  checksum: agent.checksum,
  config: agent.config,
  distribution: agent.distribution,
  mutable: false,
  platformAgentId: agent.platformAgentId,
  source: 'platform',
  systemKey: agent.systemKey,
  version: agent.version,
  versionId: agent.versionId,
});

/**
 * First-winner de-dupe for a single targeted resolution (not the full-list pager).
 * Full-list paging dedupes in SQL ({@link queryVisibleWinnerPage}).
 */
interface WinnerDedupe {
  agents: Set<string>;
  systemKeys: Set<string>;
}

const createWinnerDedupe = (): WinnerDedupe => ({
  agents: new Set<string>(),
  systemKeys: new Set<string>(),
});

/**
 * Project one page of **already-visible winners** (post SQL DISTINCT ON + hidden filter)
 * into EffectiveAgent rows. No cross-page seen sets — SQL already deduped.
 *
 * @deprecated Prefer mapping winner rows directly; retained for unit tests that inject raw pages.
 */
export const projectVisibleWinnersFromPage = (
  rows: EffectiveInputRow[],
  hidden: ReadonlySet<string>,
  /**
   * Mutated: only **accepted** winner agent ids are added (never hidden skips).
   * Size is therefore ≤ wire max across the whole full-list walk.
   */
  winnerAgentIds: Set<string>,
  /** Mutated: system keys of accepted winners only. */
  winnerSystemKeys: Set<string>,
  remainingSlots: number,
): AuthorizedAgent[] => {
  if (remainingSlots <= 0) return [];

  // When callers still pass raw multi-assignment pages (legacy unit tests), apply the
  // correct order: first-winner then hide — never hide-then-promote-duplicate.
  const visible = projectFirstWinnersThenHide(rows, hidden);
  const winners: AuthorizedAgent[] = [];

  for (const row of visible) {
    if (winners.length >= remainingSlots) break;
    if (winnerAgentIds.has(row.agent.id)) continue;
    if (row.agent.systemKey && winnerSystemKeys.has(row.agent.systemKey)) continue;

    winnerAgentIds.add(row.agent.id);
    if (row.agent.systemKey) winnerSystemKeys.add(row.agent.systemKey);

    winners.push({
      agentKey: row.agent.agentKey,
      checksum: row.version.checksum,
      config: row.version.config,
      distribution: row.assignment.mode as Distribution,
      platformAgentId: row.agent.id,
      systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
      version: row.version.version,
      versionId: row.version.id,
    });
  }

  return winners;
};

/** User-safe effective platform Agent projection. Feature/policy-off paths never query Agent rows. */
export class PlatformAgentEffectiveResolver {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly options: PlatformAgentEffectiveResolverOptions = {},
  ) {}

  /** Production full-list keyset SQL (or test override of the same contract). */
  private runFullListQuery = (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<EffectiveInputRow[]> =>
    (this.options.queryEffectiveInputsPage ?? queryEffectiveInputsPage)(this.db, userId, filter);

  /**
   * One page of effective inputs.
   *
   * Full-list path (no platformAgentId / systemKey) ALWAYS uses {@link queryEffectiveInputsPage}
   * so keyset cursor advancement cannot be silently dropped by
   * `PlatformAgentCatalogRepository.listEffectiveInputs` (still cursor-less — targeted only).
   * Targeted single-agent / system-key lookups may use an injected repository.
   */
  private listEffectiveInputPage = async (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<EffectiveInputRow[]> => {
    const isFullList = !filter?.platformAgentId && !filter?.systemKey;
    if (isFullList) {
      return this.runFullListQuery(userId, filter);
    }
    if (this.options.repository) {
      return this.options.repository.listEffectiveInputs(userId, filter);
    }
    return this.runFullListQuery(userId, filter);
  };

  /**
   * Project assignment rows into de-duplicated authorized Agents in stable winner order.
   * Does not apply the wire cap or hidden filtering — callers decide those policy layers.
   * Optional shared de-dupe allows keyset pages to continue first-winner state across pages.
   */
  private projectAuthorizedRows = (
    rows: EffectiveInputRow[],
    dedupe: WinnerDedupe = createWinnerDedupe(),
  ): AuthorizedAgent[] => {
    const ordered = [...rows].sort(compareEffectiveInputPriority);
    const authorized: AuthorizedAgent[] = [];
    for (const row of ordered) {
      if (dedupe.agents.has(row.agent.id)) continue;
      if (row.agent.systemKey && dedupe.systemKeys.has(row.agent.systemKey)) continue;
      dedupe.agents.add(row.agent.id);
      if (row.agent.systemKey) dedupe.systemKeys.add(row.agent.systemKey);
      authorized.push({
        agentKey: row.agent.agentKey,
        checksum: row.version.checksum,
        config: row.version.config,
        distribution: row.assignment.mode,
        platformAgentId: row.agent.id,
        systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
        version: row.version.version,
        versionId: row.version.id,
      });
    }
    return authorized;
  };

  /**
   * Authorization-only resolution: the assignment-scoped, de-duplicated Agents a user is
   * entitled to (server-authoritative role/scope/expiry filtering lives in the repository
   * query). Does NOT apply per-user hidden filtering — that is a list-view concern applied
   * by `getEffectiveList`, not an authorization boundary.
   *
   * Pass `filter` for single-agent / system-key lookups so the repository never scans the full
   * assignment catalog. Full-list callers pass a SQL `limit` (and optional keyset `cursor`) so the
   * repository never loads an unbounded assignment set.
   */
  private resolveAuthorized = async (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<AuthorizedAgent[]> => {
    const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return [];

    const policy = await (
      this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
    ).getSnapshot();
    if (!isAgentRuntimeManaged(policy)) return [];

    const rows = await this.listEffectiveInputPage(userId, filter);
    return this.projectAuthorizedRows(rows);
  };

  getEffectiveList = async (userId: string): Promise<EffectiveList> => {
    try {
      const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
      if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return emptyEffectiveList();

      const policy = await (
        this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
      ).getSnapshot();
      if (!isAgentRuntimeManaged(policy)) return emptyEffectiveList();

      // Full-list SQL already applies owner-scoped hidden filtering after first-winner dedup.
      // Pages return unique visible winners; accumulate only up to the wire max — no seen sets.
      const agents: EffectiveAgent[] = [];
      let cursor: PlatformAgentEffectiveInputCursor | undefined;

      for (;;) {
        const rows = await this.listEffectiveInputPage(userId, {
          cursor,
          limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
        });

        // Non-progress guard: page must strictly advance past the cursor (avoids infinite loop
        // if SQL keyset wiring regresses). Production {@link queryVisibleWinnerPage} always advances.
        if (cursor && rows.length > 0 && !isEffectiveInputAfterCursor(rows[0]!, cursor)) {
          break;
        }

        for (const row of rows) {
          if (agents.length >= PLATFORM_AGENT_EFFECTIVE_LIST_MAX) break;
          agents.push(
            projectEffective({
              agentKey: row.agent.agentKey,
              checksum: row.version.checksum,
              config: row.version.config,
              distribution: row.assignment.mode as Distribution,
              platformAgentId: row.agent.id,
              systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
              version: row.version.version,
              versionId: row.version.id,
            }),
          );
        }

        const sourceExhausted = rows.length < PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;
        const listFull = agents.length >= PLATFORM_AGENT_EFFECTIVE_LIST_MAX;
        if (sourceExhausted || listFull || rows.length === 0) break;

        cursor = cursorFromEffectiveInputRow(rows.at(-1)!);
      }

      return { agents, revision: checksumPayload({ agents }) };
    } catch (error) {
      // Redact any unexpected driver / SQL failure at the read boundary (REWORK-5).
      throw redactPlatformReadError(error);
    }
  };

  getEffectiveAgent = async (userId: string, platformAgentId: string) => {
    try {
      // Targeted repository path — never pay for full-catalog resolution for one agent.
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      const target = authorized[0];
      if (!target) return null;
      if (target.distribution !== 'mandatory') {
        const hidden = this.options.repository
          ? await this.options.repository.listHiddenPlatformAgentIds(userId)
          : await new PlatformAgentCatalogRepository(this.db).listHiddenPlatformAgentIds(userId);
        if (hidden.has(platformAgentId)) return null;
      }
      return projectEffective(target);
    } catch (error) {
      // Same redaction boundary as list/beginOperation — raw SQL must never escape the router.
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Capture an immutable operation snapshot ONCE against the authorization set (not the
   * hidden-filtered list). The only capture entry point; callers reach it through
   * `beginOperation`, never re-resolving mid-operation. Returns null when the user is not
   * entitled to the Agent — no assignment / target / role metadata is exposed.
   */
  private captureOperationSnapshot = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformAgentOperationSnapshot | null> => {
    const authorized = await this.resolveAuthorized(userId, { platformAgentId });
    const target = authorized[0];
    if (!target) return null;
    return deepFreeze<PlatformAgentOperationSnapshot>(
      structuredClone({
        checksum: target.checksum,
        config: target.config,
        platformAgentId: target.platformAgentId,
        versionId: target.versionId,
      }),
    );
  };

  private createOperationHandle = (
    snapshot: PlatformAgentOperationSnapshot,
    distribution?: Distribution,
  ): PlatformAgentOperationHandle =>
    Object.freeze<PlatformAgentOperationHandle>({
      distribution,
      getSnapshot: () => snapshot,
      platformAgentId: snapshot.platformAgentId,
    });

  /**
   * Begin an operation-scoped boundary (R2). Captures the exact version exactly once, then
   * returns a handle whose `getSnapshot()` only ever replays that frozen capture — there is no
   * path to re-resolve current/latest within a handle, so publishing v2 cannot swap the version
   * out from under an in-flight operation. A fresh `beginOperation` is the only way to capture a
   * newer version. The handle is a frozen closure over an immutable value — no global cache, no
   * cross-request state, nothing to leak. Returns null when the user is not entitled to the Agent.
   */
  beginOperation = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformAgentOperationHandle | null> => {
    try {
      const snapshot = await this.captureOperationSnapshot(userId, platformAgentId);
      if (!snapshot) return null;
      return this.createOperationHandle(snapshot);
    } catch (error) {
      // Redact any unexpected driver / SQL failure so entitlement resolution never leaks internals.
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Capture the exact effective Agent assigned to a stable system role (PR-051 default inbox).
   * This uses the same authorized set as {@link beginOperation}, but ignores the list-only hidden
   * preference: hiding a catalog tile must never turn the fixed inbox into an unmanaged bypass.
   * A genuinely absent assigned/published system Agent returns null; resolver/DB failures throw.
   */
  beginSystemOperation = async (
    userId: string,
    systemKey: NonNullable<AuthorizedAgent['systemKey']>,
  ): Promise<PlatformAgentOperationHandle | null> => {
    try {
      const authorized = await this.resolveAuthorized(userId, { systemKey });
      const target = authorized[0];
      if (!target) return null;
      const snapshot = deepFreeze<PlatformAgentOperationSnapshot>(
        structuredClone({
          checksum: target.checksum,
          config: target.config,
          platformAgentId: target.platformAgentId,
          versionId: target.versionId,
        }),
      );
      return this.createOperationHandle(snapshot, target.distribution);
    } catch (error) {
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Snapshot-free entitlement re-check (M10 PR-049 · RR3-1). Returns whether `userId` is CURRENTLY
   * entitled to `platformAgentId`, using the exact same owner-scoped assignment + managed-policy +
   * flag resolution as {@link beginOperation}, but WITHOUT capturing the latest version snapshot.
   *
   * A resume uses this to verify LIVE entitlement (so a revoked / no-longer-assigned user fails
   * closed) while still replaying its OWN exact pinned version via `materializeFromPin` — entitlement
   * is checked against current state, the running version stays pinned. Never resolves "latest".
   */
  isEntitled = async (userId: string, platformAgentId: string): Promise<boolean> => {
    try {
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      return authorized.length > 0;
    } catch (error) {
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Owner-scoped visibility write. Only ever acts on the trusted `userId`'s own row (there is
   * no target-user parameter to forge), and only for an Agent the user is entitled to. Hiding a
   * mandatory Agent is accepted but has no read effect — mandatory always stays visible.
   *
   * If the Agent is archived between authorization and the write (a lost archive race), the
   * repository returns false under its per-Agent lock and this maps to a stable NotFound rather
   * than silently succeeding (R1-02).
   */
  setAgentHidden = async (
    userId: string,
    platformAgentId: string,
    hidden: boolean,
  ): Promise<void> => {
    try {
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      const target = authorized[0];
      if (!target) throw new PlatformAgentNotFoundError();
      // A mandatory Agent can never be hidden by an ordinary user (ROOT-01). Reject the write
      // instead of silently accepting a no-op, so the boundary is explicit. Un-hiding (hidden=false)
      // stays a harmless no-op for mandatory.
      if (hidden && target.distribution === 'mandatory') {
        throw new PlatformAgentInvalidInputError();
      }
      const written = await new PlatformAgentCatalogRepository(this.db).setMaterializationHidden({
        hidden,
        platformAgentId: target.platformAgentId,
        platformAgentVersionChecksum: target.checksum,
        platformAgentVersionId: target.versionId,
        userId,
      });
      if (!written) throw new PlatformAgentNotFoundError();
    } catch (error) {
      // NotFound passes through; any unexpected driver / SQL failure is redacted (REWORK-5).
      throw redactPlatformReadError(error);
    }
  };
}
