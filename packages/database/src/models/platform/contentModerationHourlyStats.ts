import { and, desc, gte, lt, sql } from 'drizzle-orm';

import type {
  ModerationCategoryAction,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';

import {
  platformContentModerationHourlyStats,
  platformContentModerationRecords,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type ModerationStatsBucket = 'hour' | 'day';

export interface HourlyStatsIncrementInput {
  bucketStart: Date;
  effectiveAction: ModerationEffectiveAction;
  latencyMs?: number | null;
  policyAction: ModerationCategoryAction;
  requestKind: ModerationRequestKind;
  source: ModerationDecisionSource;
  topCategory?: string | null;
}

export interface HourlyStatsRange {
  bucket: ModerationStatsBucket;
  from: Date;
  timezone: string;
  to: Date;
}

export interface HourlyStatsSeriesPoint {
  allow: number;
  block: number;
  bucketStart: string;
  downgrade: number;
  error: number;
  log: number;
}

export interface HourlyStatsTotals {
  allow: number;
  avgLatencyMs: number | null;
  block: number;
  downgrade: number;
  error: number;
  log: number;
  total: number;
  wouldBlock: number;
  wouldDowngrade: number;
}

export interface ClassifierHealth {
  avgLatencyMs: number;
  sampleSize: number;
  successRate: number;
}

const resolveTimeZone = (timeZone: string): string => {
  const supported = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (!supported.has(timeZone)) {
    throw new Error(`Unknown IANA time zone: ${timeZone}`);
  }
  return timeZone;
};

/**
 * Hourly aggregation + classifier-health helper.
 *
 * `classifierHealth` is computed from the **records** table (last N rows whose
 * source is `llm_judge`/`moderations_api` or whose effective_action is `error`),
 * not from the hourly rollup — health needs per-attempt latency, which the
 * rollup only keeps as a sum.
 */
export class PlatformContentModerationHourlyStatsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  increment = async (input: HourlyStatsIncrementInput): Promise<void> => {
    const topCategory = input.topCategory ?? '';
    const latencyMs = input.latencyMs ?? null;
    const table = platformContentModerationHourlyStats;

    await this.db
      .insert(table)
      .values({
        bucketStart: input.bucketStart,
        count: 1,
        effectiveAction: input.effectiveAction,
        latencyCount: latencyMs === null ? 0 : 1,
        latencySumMs: latencyMs ?? 0,
        policyAction: input.policyAction,
        requestKind: input.requestKind,
        source: input.source,
        topCategory,
      })
      .onConflictDoUpdate({
        set: {
          count: sql`${table.count} + 1`,
          latencyCount: latencyMs === null ? table.latencyCount : sql`${table.latencyCount} + 1`,
          latencySumMs:
            latencyMs === null ? table.latencySumMs : sql`${table.latencySumMs} + ${latencyMs}`,
        },
        target: [
          table.bucketStart,
          table.requestKind,
          table.effectiveAction,
          table.policyAction,
          table.source,
          table.topCategory,
        ],
      });
  };

  series = async (params: HourlyStatsRange): Promise<HourlyStatsSeriesPoint[]> => {
    const timeZone = resolveTimeZone(params.timezone);
    const table = platformContentModerationHourlyStats;
    const format = params.bucket === 'hour' ? 'YYYY-MM-DD"T"HH24":00"' : 'YYYY-MM-DD';
    const bucketExpr = sql<string>`to_char(
      date_trunc(${params.bucket}, ${table.bucketStart} AT TIME ZONE ${timeZone}),
      ${format}
    )`;

    // Bucket is selected first so `GROUP BY 1` refers to it. Repeating the
    // expression would re-bind the timezone/format parameters and PostgreSQL
    // would no longer match the SELECT target (same trick as activitySeries).
    const rows = await this.db
      .select({
        bucketStart: bucketExpr.as('bucket_start'),
        allow:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'allow' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        block:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'block' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        downgrade:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'downgrade' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        error:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'error' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        log: sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'log' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
          Number,
        ),
      })
      .from(table)
      .where(and(gte(table.bucketStart, params.from), lt(table.bucketStart, params.to)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return rows.map((row) => ({
      allow: row.allow,
      block: row.block,
      bucketStart: row.bucketStart,
      downgrade: row.downgrade,
      error: row.error,
      log: row.log,
    }));
  };

  totals = async (params: { from: Date; to: Date }): Promise<HourlyStatsTotals> => {
    const table = platformContentModerationHourlyStats;
    const [row] = await this.db
      .select({
        allow:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'allow' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        block:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'block' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        downgrade:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'downgrade' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        error:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'error' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        latencyCount: sql<number>`COALESCE(SUM(${table.latencyCount}), 0)`.mapWith(Number),
        latencySumMs: sql<number>`COALESCE(SUM(${table.latencySumMs}), 0)`.mapWith(Number),
        log: sql<number>`COALESCE(SUM(CASE WHEN ${table.effectiveAction} = 'log' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
          Number,
        ),
        total: sql<number>`COALESCE(SUM(${table.count}), 0)`.mapWith(Number),
        wouldBlock:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.policyAction} = 'block' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
        wouldDowngrade:
          sql<number>`COALESCE(SUM(CASE WHEN ${table.policyAction} = 'downgrade' THEN ${table.count} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
      })
      .from(table)
      .where(and(gte(table.bucketStart, params.from), lt(table.bucketStart, params.to)));

    const latencyCount = row?.latencyCount ?? 0;
    const latencySumMs = row?.latencySumMs ?? 0;

    return {
      allow: row?.allow ?? 0,
      avgLatencyMs: latencyCount > 0 ? latencySumMs / latencyCount : null,
      block: row?.block ?? 0,
      downgrade: row?.downgrade ?? 0,
      error: row?.error ?? 0,
      log: row?.log ?? 0,
      total: row?.total ?? 0,
      wouldBlock: row?.wouldBlock ?? 0,
      wouldDowngrade: row?.wouldDowngrade ?? 0,
    };
  };

  byCategory = async (params: {
    from: Date;
    to: Date;
  }): Promise<Array<{ category: string; count: number }>> => {
    const table = platformContentModerationHourlyStats;
    const rows = await this.db
      .select({
        category: table.topCategory,
        count: sql<number>`COALESCE(SUM(${table.count}), 0)`.mapWith(Number),
      })
      .from(table)
      .where(
        and(
          gte(table.bucketStart, params.from),
          lt(table.bucketStart, params.to),
          sql`${table.topCategory} <> ''`,
        ),
      )
      .groupBy(table.topCategory)
      .orderBy(desc(sql`count`));
    return rows;
  };

  bySource = async (params: {
    from: Date;
    to: Date;
  }): Promise<Array<{ count: number; source: string }>> => {
    const table = platformContentModerationHourlyStats;
    const rows = await this.db
      .select({
        count: sql<number>`COALESCE(SUM(${table.count}), 0)`.mapWith(Number),
        source: table.source,
      })
      .from(table)
      .where(and(gte(table.bucketStart, params.from), lt(table.bucketStart, params.to)))
      .groupBy(table.source)
      .orderBy(desc(sql`count`));
    return rows;
  };

  byRequestKind = async (params: {
    from: Date;
    to: Date;
  }): Promise<Array<{ count: number; kind: string }>> => {
    const table = platformContentModerationHourlyStats;
    const rows = await this.db
      .select({
        count: sql<number>`COALESCE(SUM(${table.count}), 0)`.mapWith(Number),
        kind: table.requestKind,
      })
      .from(table)
      .where(and(gte(table.bucketStart, params.from), lt(table.bucketStart, params.to)))
      .groupBy(table.requestKind)
      .orderBy(desc(sql`count`));
    return rows;
  };

  /**
   * Recent classifier-attempt health from the records table (last `lastN` rows
   * whose source is a classifier or whose effective action is `error`).
   */
  classifierHealth = async (params: { lastN?: number } = {}): Promise<ClassifierHealth | null> => {
    const lastN = params.lastN ?? 100;
    const table = platformContentModerationRecords;
    const rows = await this.db
      .select({
        error: table.error,
        latencyMs: table.classifierLatencyMs,
      })
      .from(table)
      .where(
        sql`${table.source} IN ('llm_judge', 'moderations_api') OR ${table.effectiveAction} = 'error'`,
      )
      .orderBy(desc(table.createdAt))
      .limit(lastN);

    if (rows.length === 0) return null;

    const sampleSize = rows.length;
    const successes = rows.filter((row) => row.error === null).length;
    const latencies = rows
      .map((row) => row.latencyMs)
      .filter((value): value is number => typeof value === 'number');
    const avgLatencyMs =
      latencies.length === 0
        ? 0
        : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

    return {
      avgLatencyMs,
      sampleSize,
      successRate: successes / sampleSize,
    };
  };

  purgeOlderThan = async (days = 400): Promise<number> => {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await this.db
      .delete(platformContentModerationHourlyStats)
      .where(lt(platformContentModerationHourlyStats.bucketStart, cutoff))
      .returning({
        bucketStart: platformContentModerationHourlyStats.bucketStart,
      });
    return deleted.length;
  };
}
