import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';

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

  private tokenMatches = (target: PlatformInstanceInventoryTarget) => {
    if (!target.token) return sql`false`;
    return target.token.kind === 'revision'
      ? and(
          eq(platformInstanceRevisionStates.loadedRevision, target.token.value),
          isNull(platformInstanceRevisionStates.loadedRevisionId),
        )!
      : and(
          eq(platformInstanceRevisionStates.loadedRevisionId, target.token.value),
          isNull(platformInstanceRevisionStates.loadedRevision),
        )!;
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
    const baseline = await this.db
      .select()
      .from(platformInstanceHeartbeats)
      .where(recency)
      .orderBy(
        desc(platformInstanceHeartbeats.lastHeartbeatAt),
        asc(platformInstanceHeartbeats.instanceId),
      )
      .limit(input.limit);
    const issues = new Map<string, PlatformInstanceHeartbeatItem>();
    if (input.fresh) {
      for (const target of input.targets) {
        if (target.status === 'disabled' || target.loadMode === 'request_scoped') continue;
        const issue =
          target.status === 'unavailable'
            ? sql`true`
            : or(
                isNull(platformInstanceRevisionStates.instanceId),
                ne(platformInstanceRevisionStates.health, 'healthy'),
                not(this.tokenMatches(target)),
              );
        const rows = await this.db
          .select({
            instanceId: platformInstanceHeartbeats.instanceId,
            lastHeartbeatAt: platformInstanceHeartbeats.lastHeartbeatAt,
            startedAt: platformInstanceHeartbeats.startedAt,
          })
          .from(platformInstanceHeartbeats)
          .leftJoin(
            platformInstanceRevisionStates,
            and(
              eq(platformInstanceRevisionStates.instanceId, platformInstanceHeartbeats.instanceId),
              eq(platformInstanceRevisionStates.domain, target.domain),
            ),
          )
          .where(and(recency, issue))
          .orderBy(
            desc(platformInstanceHeartbeats.lastHeartbeatAt),
            asc(platformInstanceHeartbeats.instanceId),
          )
          .limit(input.limit);
        for (const row of rows) issues.set(row.instanceId, row);
      }
    }
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
   * Reads exact aggregates and bounded issue-first diagnostics against one caller-supplied
   * database clock. Stale processes are counted but excluded from convergence classifications.
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
    const counts: PlatformInstanceInventorySnapshot['counts'] = [];
    for (const target of targets) {
      if (target.status === 'disabled' || target.loadMode === 'request_scoped') {
        counts.push({
          counts: {
            degraded: 0,
            diverged: 0,
            fresh: freshCount,
            matching: 0,
            stale: staleCount,
            unreported: 0,
          },
          domain: target.domain,
        });
        continue;
      }
      const matches = this.tokenMatches(target);
      const [aggregate] = await this.db
        .select({
          degraded: sql<number>`count(*) filter (where ${platformInstanceRevisionStates.instanceId} is not null and ${platformInstanceRevisionStates.health} <> 'healthy')`,
          diverged:
            target.status === 'available'
              ? sql<number>`count(*) filter (where ${platformInstanceRevisionStates.health} = 'healthy' and not (${matches}))`
              : sql<number>`0`,
          matching:
            target.status === 'available'
              ? sql<number>`count(*) filter (where ${platformInstanceRevisionStates.health} = 'healthy' and ${matches})`
              : sql<number>`0`,
          unreported: sql<number>`count(*) filter (where ${platformInstanceRevisionStates.instanceId} is null)`,
        })
        .from(platformInstanceHeartbeats)
        .leftJoin(
          platformInstanceRevisionStates,
          and(
            eq(platformInstanceRevisionStates.instanceId, platformInstanceHeartbeats.instanceId),
            eq(platformInstanceRevisionStates.domain, target.domain),
          ),
        )
        .where(gte(platformInstanceHeartbeats.lastHeartbeatAt, cutoff));
      counts.push({
        counts: {
          degraded: Number(aggregate?.degraded ?? 0),
          diverged: Number(aggregate?.diverged ?? 0),
          fresh: freshCount,
          matching: Number(aggregate?.matching ?? 0),
          stale: staleCount,
          unreported: Number(aggregate?.unreported ?? 0),
        },
        domain: target.domain,
      });
    }
    const [freshCandidates, staleCandidates] = await Promise.all([
      this.listDiagnosticCandidates({
        cutoff,
        fresh: true,
        limit: PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
        targets,
      }),
      this.listDiagnosticCandidates({
        cutoff,
        fresh: false,
        limit: PLATFORM_INSTANCE_STALE_DIAGNOSTIC_CANDIDATE_LIMIT,
        targets,
      }),
    ]);
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
    const [platformRows, identityRows] = await Promise.all([
      this.db
        .select()
        .from(platformInstanceHeartbeats)
        .where(platformCursor)
        .orderBy(
          desc(platformInstanceHeartbeats.lastHeartbeatAt),
          asc(platformInstanceHeartbeats.instanceId),
        )
        .limit(limit + 1),
      this.db
        .select()
        .from(platformIdentityProviderInstances)
        .where(identityCursor)
        .orderBy(
          desc(platformIdentityProviderInstances.lastHeartbeat),
          asc(platformIdentityProviderInstances.instanceId),
        )
        .limit(limit + 1),
    ]);
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
