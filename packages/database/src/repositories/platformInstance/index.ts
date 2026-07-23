import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import {
  type PlatformIdentityProviderInstanceItem,
  platformIdentityProviderInstances,
  type PlatformInstanceDomain,
  type PlatformInstanceHeartbeatItem,
  platformInstanceHeartbeats,
  type PlatformInstanceLoadMode,
  type PlatformInstanceRevisionErrorCategory,
  type PlatformInstanceRevisionHealth,
  type PlatformInstanceRevisionSource,
  type PlatformInstanceRevisionStateItem,
  platformInstanceRevisionStates,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export const PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const PLATFORM_INSTANCE_STALE_AFTER_MS = 90_000;
export const PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT = 101;
export const PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT = 11;

export type PlatformInstanceInventoryToken =
  { kind: 'immutable_id'; value: string } | { kind: 'revision'; value: number };

export interface PlatformInstanceInventoryTarget {
  domain: PlatformInstanceDomain;
  loadMode: PlatformInstanceLoadMode;
  status: 'available' | 'disabled' | 'unavailable';
  token: PlatformInstanceInventoryToken | null;
}

export interface PlatformInstanceInventoryCounts {
  degraded: number;
  diverged: number;
  fresh: number;
  matching: number;
  stale: number;
  unreported: number;
}

/**
 * Boolean SQL: revision-state row matches the inventory target token carried on the
 * `targets` CTE (`token_kind` / `token_revision` / `token_immutable_id`).
 * Preserves single-target semantics: revision matches only when id is null and vice versa;
 * missing token never matches.
 */
const targetTokenMatchesSql = sql`(
  CASE
    WHEN targets.token_kind = 'revision' THEN
      ${platformInstanceRevisionStates.loadedRevision} = targets.token_revision
      AND ${platformInstanceRevisionStates.loadedRevisionId} IS NULL
    WHEN targets.token_kind = 'immutable_id' THEN
      ${platformInstanceRevisionStates.loadedRevisionId} = targets.token_immutable_id
      AND ${platformInstanceRevisionStates.loadedRevision} IS NULL
    ELSE FALSE
  END
)`;

const isActiveInventoryTarget = (target: PlatformInstanceInventoryTarget) =>
  target.status !== 'disabled' && target.loadMode !== 'request_scoped';

/** Parameterized VALUES list for active inventory targets (Postgres / PGlite). */
const inventoryTargetsValuesSql = (targets: PlatformInstanceInventoryTarget[]) =>
  sql.join(
    targets.map((target) => {
      const tokenKind = target.token?.kind ?? null;
      const tokenRevision = target.token?.kind === 'revision' ? target.token.value : null;
      const tokenImmutableId = target.token?.kind === 'immutable_id' ? target.token.value : null;
      return sql`(
        ${target.domain}::text,
        ${target.status}::text,
        ${tokenKind}::text,
        ${tokenRevision}::integer,
        ${tokenImmutableId}::text
      )`;
    }),
    sql`, `,
  );

const zeroDomainCounts = (fresh: number, stale: number): PlatformInstanceInventoryCounts => ({
  degraded: 0,
  diverged: 0,
  fresh,
  matching: 0,
  stale,
  unreported: 0,
});

interface DomainAggregateRow extends Record<string, unknown> {
  degraded: number | string;
  diverged: number | string;
  domain: PlatformInstanceDomain;
  matching: number | string;
  unreported: number | string;
}

interface DiagnosticIssueRow extends Record<string, unknown> {
  instanceId: string;
  lastHeartbeatAt: Date | string;
  startedAt: Date | string;
}

const asQueryRows = <T>(result: { rows: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.rows;

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

export interface PlatformInstanceInventoryDiagnostic {
  instance: PlatformInstanceHeartbeatItem;
  states: PlatformInstanceRevisionStateItem[];
}

export interface PlatformInstanceInventorySnapshot {
  counts: Array<{ counts: PlatformInstanceInventoryCounts; domain: PlatformInstanceDomain }>;
  freshCandidates: PlatformInstanceInventoryDiagnostic[];
  freshCount: number;
  snapshotAt: Date;
  staleCandidates: PlatformInstanceInventoryDiagnostic[];
  staleCount: number;
}

export interface PlatformInstanceRevisionInventoryCursor {
  instanceId: string;
  lastHeartbeatAt: Date;
}

export type PlatformInstanceRevisionInventoryItem =
  | {
      instance: PlatformIdentityProviderInstanceItem;
      instanceKind: 'identity_startup';
    }
  | {
      instance: PlatformInstanceHeartbeatItem;
      instanceKind: 'platform';
      states: PlatformInstanceRevisionStateItem[];
    };

export interface PlatformInstanceRevisionInventoryPage {
  items: PlatformInstanceRevisionInventoryItem[];
  nextCursor: PlatformInstanceRevisionInventoryCursor | null;
  snapshotAt: Date;
}

export interface UpsertPlatformInstanceRevisionStateInput {
  domain: PlatformInstanceDomain;
  errorCategory?: PlatformInstanceRevisionErrorCategory | null;
  health: PlatformInstanceRevisionHealth;
  instanceId: string;
  loadedRevision?: number | null;
  loadedRevisionId?: string | null;
  loadMode: PlatformInstanceLoadMode;
  source: PlatformInstanceRevisionSource;
}

export const PLATFORM_IDENTITY_REVISION_LAG_REASONS = ['degraded', 'diverged'] as const;

export type PlatformIdentityRevisionLagReason =
  (typeof PLATFORM_IDENTITY_REVISION_LAG_REASONS)[number];

export interface PlatformIdentityRevisionLagSnapshot {
  freshInstances: number;
  laggingInstances: Array<{ count: number; reason: PlatformIdentityRevisionLagReason }>;
  snapshotAt: Date;
}

/**
 * Persistence boundary for anonymous process inventory and normalized revision/load state.
 * All recency timestamps are authored by PostgreSQL so caller clock skew cannot affect health.
 */
export class PlatformInstanceRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  listFreshInstances = async (): Promise<PlatformInstanceHeartbeatItem[]> => {
    return this.db
      .select()
      .from(platformInstanceHeartbeats)
      .where(
        gte(
          platformInstanceHeartbeats.lastHeartbeatAt,
          sql`clock_timestamp() - ${PLATFORM_INSTANCE_STALE_AFTER_MS} * interval '1 millisecond'`,
        ),
      )
      .orderBy(desc(platformInstanceHeartbeats.lastHeartbeatAt));
  };

  listRevisionStates = async (
    instanceId?: string,
  ): Promise<PlatformInstanceRevisionStateItem[]> => {
    const query = this.db.select().from(platformInstanceRevisionStates);
    return instanceId
      ? query
          .where(eq(platformInstanceRevisionStates.instanceId, instanceId))
          .orderBy(asc(platformInstanceRevisionStates.domain))
      : query.orderBy(
          asc(platformInstanceRevisionStates.instanceId),
          asc(platformInstanceRevisionStates.domain),
        );
  };

  /**
   * Fresh diagnostic issue set across all active domains in one statement.
   * An instance is an issue if ANY active target is unavailable, missing state,
   * non-healthy, or token-mismatched — same union semantics as the former per-domain loop.
   */
  private listDiagnosticIssueInstances = async (input: {
    cutoff: Date;
    limit: number;
    targets: PlatformInstanceInventoryTarget[];
  }): Promise<PlatformInstanceHeartbeatItem[]> => {
    const activeTargets = input.targets.filter(isActiveInventoryTarget);
    if (activeTargets.length === 0) return [];

    const result = await this.db.execute<DiagnosticIssueRow>(sql`
      WITH targets(domain, status, token_kind, token_revision, token_immutable_id) AS (
        VALUES ${inventoryTargetsValuesSql(activeTargets)}
      )
      SELECT
        ${platformInstanceHeartbeats.instanceId} AS "instanceId",
        ${platformInstanceHeartbeats.lastHeartbeatAt} AS "lastHeartbeatAt",
        ${platformInstanceHeartbeats.startedAt} AS "startedAt"
      FROM ${platformInstanceHeartbeats}
      WHERE ${platformInstanceHeartbeats.lastHeartbeatAt} >= ${input.cutoff}
        AND EXISTS (
          SELECT 1
          FROM targets
          LEFT JOIN ${platformInstanceRevisionStates}
            ON ${platformInstanceRevisionStates.instanceId} = ${platformInstanceHeartbeats.instanceId}
            AND ${platformInstanceRevisionStates.domain} = targets.domain
          WHERE targets.status = 'unavailable'
            OR ${platformInstanceRevisionStates.instanceId} IS NULL
            OR ${platformInstanceRevisionStates.health} <> 'healthy'
            OR NOT ${targetTokenMatchesSql}
        )
      ORDER BY
        ${platformInstanceHeartbeats.lastHeartbeatAt} DESC,
        ${platformInstanceHeartbeats.instanceId} ASC
      LIMIT ${input.limit}
    `);

    return asQueryRows(result).map((row) => ({
      instanceId: row.instanceId,
      lastHeartbeatAt: asDate(row.lastHeartbeatAt),
      startedAt: asDate(row.startedAt),
    }));
  };

  private listDiagnosticCandidates = async (input: {
    cutoff: Date;
    fresh: boolean;
    limit: number;
    targets: PlatformInstanceInventoryTarget[];
  }): Promise<PlatformInstanceInventoryDiagnostic[]> => {
    const recency = input.fresh
      ? gte(platformInstanceHeartbeats.lastHeartbeatAt, input.cutoff)
      : lt(platformInstanceHeartbeats.lastHeartbeatAt, input.cutoff);
    // Constant query budget: baseline + optional single multi-domain issue query + states.
    const baseline = await this.db
      .select()
      .from(platformInstanceHeartbeats)
      .where(recency)
      .orderBy(
        desc(platformInstanceHeartbeats.lastHeartbeatAt),
        asc(platformInstanceHeartbeats.instanceId),
      )
      .limit(input.limit);
    const issueRows = input.fresh
      ? await this.listDiagnosticIssueInstances({
          cutoff: input.cutoff,
          limit: input.limit,
          targets: input.targets,
        })
      : [];
    const issues = new Map(issueRows.map((row) => [row.instanceId, row]));
    const candidates = [...issues.values(), ...baseline]
      .filter(
        (instance, index, all) =>
          all.findIndex(({ instanceId }) => instanceId === instance.instanceId) === index,
      )
      .sort(
        (left, right) =>
          Number(issues.has(right.instanceId)) - Number(issues.has(left.instanceId)) ||
          right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime() ||
          left.instanceId.localeCompare(right.instanceId),
      )
      .slice(0, input.limit);
    const ids = candidates.map(({ instanceId }) => instanceId);
    const states =
      ids.length === 0
        ? []
        : await this.db
            .select()
            .from(platformInstanceRevisionStates)
            .where(inArray(platformInstanceRevisionStates.instanceId, ids))
            .orderBy(
              asc(platformInstanceRevisionStates.instanceId),
              asc(platformInstanceRevisionStates.domain),
            );
    return candidates.map((instance) => ({
      instance,
      states: states.filter((state) => state.instanceId === instance.instanceId),
    }));
  };

  /**
   * Per-domain convergence aggregates in one GROUP BY over a targets VALUES list.
   * Inactive targets (disabled / request_scoped) are omitted from SQL and zero-filled in JS.
   */
  private listDomainInventoryAggregates = async (input: {
    cutoff: Date;
    targets: PlatformInstanceInventoryTarget[];
  }): Promise<
    Map<PlatformInstanceDomain, Omit<PlatformInstanceInventoryCounts, 'fresh' | 'stale'>>
  > => {
    const activeTargets = input.targets.filter(isActiveInventoryTarget);
    const byDomain = new Map<
      PlatformInstanceDomain,
      Omit<PlatformInstanceInventoryCounts, 'fresh' | 'stale'>
    >();
    if (activeTargets.length === 0) return byDomain;

    const result = await this.db.execute<DomainAggregateRow>(sql`
      WITH targets(domain, status, token_kind, token_revision, token_immutable_id) AS (
        VALUES ${inventoryTargetsValuesSql(activeTargets)}
      )
      SELECT
        targets.domain AS domain,
        count(*) FILTER (
          WHERE ${platformInstanceRevisionStates.instanceId} IS NOT NULL
            AND ${platformInstanceRevisionStates.health} <> 'healthy'
        )::int AS degraded,
        count(*) FILTER (
          WHERE targets.status = 'available'
            AND ${platformInstanceRevisionStates.health} = 'healthy'
            AND NOT ${targetTokenMatchesSql}
        )::int AS diverged,
        count(*) FILTER (
          WHERE targets.status = 'available'
            AND ${platformInstanceRevisionStates.health} = 'healthy'
            AND ${targetTokenMatchesSql}
        )::int AS matching,
        count(*) FILTER (
          WHERE ${platformInstanceRevisionStates.instanceId} IS NULL
        )::int AS unreported
      FROM targets
      CROSS JOIN ${platformInstanceHeartbeats}
      LEFT JOIN ${platformInstanceRevisionStates}
        ON ${platformInstanceRevisionStates.instanceId} = ${platformInstanceHeartbeats.instanceId}
        AND ${platformInstanceRevisionStates.domain} = targets.domain
      WHERE ${platformInstanceHeartbeats.lastHeartbeatAt} >= ${input.cutoff}
      GROUP BY targets.domain
    `);

    for (const row of asQueryRows(result)) {
      byDomain.set(row.domain, {
        degraded: Number(row.degraded ?? 0),
        diverged: Number(row.diverged ?? 0),
        matching: Number(row.matching ?? 0),
        unreported: Number(row.unreported ?? 0),
      });
    }
    return byDomain;
  };

  /**
   * Reads exact aggregates and bounded issue-first diagnostics against one caller-supplied
   * database clock. Stale processes are counted but excluded from convergence classifications.
   * Query count is constant in the number of domains (VALUES + GROUP BY / EXISTS), not O(domains).
   */
  getConvergenceInventorySnapshot = async (
    targets: PlatformInstanceInventoryTarget[],
    snapshotAt?: Date,
  ): Promise<PlatformInstanceInventorySnapshot> => {
    const clock = snapshotAt ?? (await this.readSnapshotAt());
    const cutoff = new Date(clock.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const [inventory] = await this.db
      .select({
        fresh: sql<number>`count(*) filter (where ${platformInstanceHeartbeats.lastHeartbeatAt} >= ${cutoff})`,
        stale: sql<number>`count(*) filter (where ${platformInstanceHeartbeats.lastHeartbeatAt} < ${cutoff})`,
      })
      .from(platformInstanceHeartbeats);
    const freshCount = Number(inventory?.fresh ?? 0);
    const staleCount = Number(inventory?.stale ?? 0);
    // Single multi-domain aggregate (no per-target round-trip; no Promise.all on tx client).
    const aggregates = await this.listDomainInventoryAggregates({ cutoff, targets });
    const counts: PlatformInstanceInventorySnapshot['counts'] = targets.map((target) => {
      if (!isActiveInventoryTarget(target)) {
        return { counts: zeroDomainCounts(freshCount, staleCount), domain: target.domain };
      }
      const aggregate = aggregates.get(target.domain);
      return {
        counts: {
          degraded: aggregate?.degraded ?? 0,
          diverged: aggregate?.diverged ?? 0,
          fresh: freshCount,
          matching: aggregate?.matching ?? 0,
          stale: staleCount,
          unreported: aggregate?.unreported ?? 0,
        },
        domain: target.domain,
      };
    });
    // Sequential under the same transaction client as the aggregates above.
    const freshCandidates = await this.listDiagnosticCandidates({
      cutoff,
      fresh: true,
      limit: PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
      targets,
    });
    const staleCandidates = await this.listDiagnosticCandidates({
      cutoff,
      fresh: false,
      limit: PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT,
      targets,
    });
    return {
      counts,
      freshCandidates,
      freshCount,
      snapshotAt: clock,
      staleCandidates,
      staleCount,
    };
  };

  /**
   * Complete, stable operational inventory ordered by (heartbeat DESC, instance id ASC).
   * Unlike convergence diagnostics, this path is not issue-first and is never sample-truncated.
   */
  listRevisionInventoryPage = async (
    params: {
      cursor?: PlatformInstanceRevisionInventoryCursor;
      limit?: number;
      snapshotAt?: Date;
    } = {},
  ): Promise<PlatformInstanceRevisionInventoryPage> => {
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 50);
    const snapshotAt = params.snapshotAt ?? (await this.readSnapshotAt());
    const platformCursor = params.cursor
      ? or(
          lt(platformInstanceHeartbeats.lastHeartbeatAt, params.cursor.lastHeartbeatAt),
          and(
            eq(platformInstanceHeartbeats.lastHeartbeatAt, params.cursor.lastHeartbeatAt),
            gt(platformInstanceHeartbeats.instanceId, params.cursor.instanceId),
          ),
        )
      : undefined;
    const identityCursor = params.cursor
      ? or(
          lt(platformIdentityProviderInstances.lastHeartbeat, params.cursor.lastHeartbeatAt),
          and(
            eq(platformIdentityProviderInstances.lastHeartbeat, params.cursor.lastHeartbeatAt),
            gt(platformIdentityProviderInstances.instanceId, params.cursor.instanceId),
          ),
        )
      : undefined;
    // Sequential reads: callers wrap this in a transaction (statusService inventory page).
    const platformRows = await this.db
      .select()
      .from(platformInstanceHeartbeats)
      .where(platformCursor)
      .orderBy(
        desc(platformInstanceHeartbeats.lastHeartbeatAt),
        asc(platformInstanceHeartbeats.instanceId),
      )
      .limit(limit + 1);
    const identityRows = await this.db
      .select()
      .from(platformIdentityProviderInstances)
      .where(identityCursor)
      .orderBy(
        desc(platformIdentityProviderInstances.lastHeartbeat),
        asc(platformIdentityProviderInstances.instanceId),
      )
      .limit(limit + 1);
    const candidates = [
      ...platformRows.map((instance) => ({
        heartbeat: instance.lastHeartbeatAt,
        instance,
        instanceId: instance.instanceId,
        instanceKind: 'platform' as const,
      })),
      ...identityRows.map((instance) => ({
        heartbeat: instance.lastHeartbeat,
        instance,
        instanceId: instance.instanceId,
        instanceKind: 'identity_startup' as const,
      })),
    ]
      .sort(
        (left, right) =>
          right.heartbeat.getTime() - left.heartbeat.getTime() ||
          left.instanceId.localeCompare(right.instanceId),
      )
      .slice(0, limit + 1);
    const hasMore = candidates.length > limit;
    const visible = hasMore ? candidates.slice(0, limit) : candidates;
    const platformIds = visible
      .filter(({ instanceKind }) => instanceKind === 'platform')
      .map(({ instanceId }) => instanceId);
    const states =
      platformIds.length === 0
        ? []
        : await this.db
            .select()
            .from(platformInstanceRevisionStates)
            .where(inArray(platformInstanceRevisionStates.instanceId, platformIds))
            .orderBy(
              asc(platformInstanceRevisionStates.instanceId),
              asc(platformInstanceRevisionStates.domain),
            );
    const items: PlatformInstanceRevisionInventoryItem[] = visible.map((candidate) =>
      candidate.instanceKind === 'platform'
        ? {
            instance: candidate.instance,
            instanceKind: candidate.instanceKind,
            states: states.filter(({ instanceId }) => instanceId === candidate.instanceId),
          }
        : { instance: candidate.instance, instanceKind: candidate.instanceKind },
    );
    const last = visible.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last ? { instanceId: last.instanceId, lastHeartbeatAt: last.heartbeat } : null,
      snapshotAt,
    };
  };

  /** Read-only aggregate over the production OIDC startup registry; no diagnostics or IDs leave. */
  getIdentityRevisionLagSnapshot = async (
    targetRevision: string | null,
    snapshotAt?: Date,
  ): Promise<PlatformIdentityRevisionLagSnapshot> => {
    const clock = snapshotAt ?? (await this.readSnapshotAt());
    const cutoff = new Date(clock.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const fallback = inArray(platformIdentityProviderInstances.startupSource, [
      'break_glass',
      'lkg',
    ]);
    const matches = targetRevision
      ? eq(platformIdentityProviderInstances.activeIdentityRevision, targetRevision)
      : isNull(platformIdentityProviderInstances.activeIdentityRevision);
    const [aggregate] = await this.db
      .select({
        degraded: sql<number>`count(*) filter (
          where ${platformIdentityProviderInstances.health} = 'degraded' or ${fallback}
        )::int`,
        diverged: sql<number>`count(*) filter (
          where ${platformIdentityProviderInstances.health} = 'healthy'
            and not (${fallback})
            and not (${matches})
        )::int`,
        fresh: count(),
      })
      .from(platformIdentityProviderInstances)
      .where(gte(platformIdentityProviderInstances.lastHeartbeat, cutoff));

    return {
      freshInstances: Number(aggregate?.fresh ?? 0),
      laggingInstances: [
        { count: Number(aggregate?.degraded ?? 0), reason: 'degraded' },
        { count: Number(aggregate?.diverged ?? 0), reason: 'diverged' },
      ],
      snapshotAt: clock,
    };
  };

  readSnapshotAt = async (): Promise<Date> => {
    const result = await this.db.execute<{ snapshotAt: Date | string }>(
      sql`SELECT clock_timestamp() AS "snapshotAt"`,
    );
    const raw = result.rows[0]?.snapshotAt;
    const snapshotAt = raw instanceof Date ? raw : new Date(raw ?? Number.NaN);
    if (Number.isNaN(snapshotAt.getTime())) {
      throw new Error('PLATFORM_INSTANCE_SNAPSHOT_CLOCK_UNAVAILABLE');
    }
    return snapshotAt;
  };

  registerInstance = async (instanceId: string): Promise<PlatformInstanceHeartbeatItem> => {
    const [row] = await this.db
      .insert(platformInstanceHeartbeats)
      .values({ instanceId })
      .onConflictDoUpdate({
        set: { instanceId },
        target: platformInstanceHeartbeats.instanceId,
      })
      .returning();
    return row;
  };

  upsertHeartbeat = async (instanceId: string): Promise<PlatformInstanceHeartbeatItem> => {
    const [row] = await this.db
      .insert(platformInstanceHeartbeats)
      .values({ instanceId })
      .onConflictDoUpdate({
        set: { lastHeartbeatAt: sql`clock_timestamp()` },
        target: platformInstanceHeartbeats.instanceId,
      })
      .returning();
    return row;
  };

  upsertRevisionState = async (
    input: UpsertPlatformInstanceRevisionStateInput,
  ): Promise<PlatformInstanceRevisionStateItem> => {
    const values = {
      domain: input.domain,
      errorCategory: input.errorCategory ?? null,
      health: input.health,
      instanceId: input.instanceId,
      loadedRevision: input.loadedRevision ?? null,
      loadedRevisionId: input.loadedRevisionId ?? null,
      loadMode: input.loadMode,
      source: input.source,
    };
    const [row] = await this.db
      .insert(platformInstanceRevisionStates)
      .values(values)
      .onConflictDoUpdate({
        set: {
          errorCategory: values.errorCategory,
          health: values.health,
          loadedAt: sql`clock_timestamp()`,
          loadedRevision: values.loadedRevision,
          loadedRevisionId: values.loadedRevisionId,
          loadMode: values.loadMode,
          source: values.source,
        },
        target: [platformInstanceRevisionStates.instanceId, platformInstanceRevisionStates.domain],
      })
      .returning();
    return row;
  };
}
