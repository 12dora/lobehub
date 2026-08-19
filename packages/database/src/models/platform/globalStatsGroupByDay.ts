/**
 * SQL `GROUP BY day` chart aggregation for platform usage (findAndGroupByDay).
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { asc, count, eq, sql } from 'drizzle-orm';

import { messages, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { genWhere } from '../../utils/genWhere';
import type { StatsFilterArg } from './globalStatsRange';
import {
  eachUtcDayKey,
  genInstantRangeWhere,
  resolveStatsRange,
  toStatsFilterParams,
} from './globalStatsRange';
import type { GlobalUsageLog, GlobalUsageRecordItem, GroupByDayDimRow } from './globalStatsShared';
import {
  asRows,
  capGroupByDayRecords,
  GROUP_BY_DAY_MAX_MODELS,
  GROUP_BY_DAY_MAX_PROVIDERS,
  GROUP_BY_DAY_OTHER_USER_ID,
  GROUP_BY_DAY_TOP_USERS,
  usageCostSql,
  usageInputTokensSql,
  usageOutputTokensSql,
  userDisplaySql,
} from './globalStatsShared';

dayjs.extend(utc);

export const queryUsageLogsByDay = async (
  db: LobeChatDatabase,
  arg?: StatsFilterArg,
): Promise<GlobalUsageLog[]> => {
  const params = toStatsFilterParams(arg);
  const range = resolveStatsRange(params);

  const costExpr = usageCostSql();
  const inputTokensExpr = usageInputTokensSql();
  const outputTokensExpr = usageOutputTokensSql();
  const dayExpr = sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const modelExpr = sql<string>`COALESCE(${messages.model}, '')`;
  const providerExpr = sql<string>`COALESCE(${messages.provider}, '')`;

  const rangeWhere = genWhere([
    eq(messages.role, 'assistant'),
    genInstantRangeWhere(range, messages.createdAt),
    params.userId ? eq(messages.userId, params.userId) : undefined,
  ]);

  const [dayTotals, dimResult] = await Promise.all([
    db
      .select({
        day: dayExpr.as('day'),
        totalRequests: count(messages.id).mapWith(Number),
        totalSpend: sql<number>`COALESCE(SUM(${costExpr}), 0)`.mapWith(Number),
        totalTokens:
          sql<number>`COALESCE(SUM(${inputTokensExpr} + ${outputTokensExpr}), 0)`.mapWith(Number),
      })
      .from(messages)
      .where(rangeWhere)
      .groupBy(dayExpr)
      .orderBy(asc(dayExpr)),
    // Rank and fold every dimension before rows cross the DB boundary. The
    // second aggregation gives the result a hard day × capped-dimension bound.
    db.execute(sql`
        WITH base AS (
          SELECT
            ${dayExpr} AS day,
            COALESCE(${messages.userId}, ${GROUP_BY_DAY_OTHER_USER_ID}) AS user_id,
            ${userDisplaySql} AS user_display,
            ${modelExpr} AS model,
            ${providerExpr} AS provider,
            COALESCE(SUM(${costExpr}), 0)::double precision AS spend,
            COALESCE(SUM(${inputTokensExpr}), 0)::double precision AS input_tokens,
            COALESCE(SUM(${outputTokensExpr}), 0)::double precision AS output_tokens
          FROM ${messages}
          LEFT JOIN ${users} ON ${messages.userId} = ${users.id}
          WHERE ${rangeWhere}
          GROUP BY ${dayExpr}, ${messages.userId}, ${userDisplaySql}, ${modelExpr}, ${providerExpr}
        ),
        user_ranked AS (
          SELECT
            day,
            user_id,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, user_id ASC
            ) AS rank
          FROM base
          GROUP BY day, user_id
        ),
        model_ranked AS (
          SELECT
            day,
            model,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, model ASC
            ) AS rank
          FROM base
          GROUP BY day, model
        ),
        provider_ranked AS (
          SELECT
            day,
            provider,
            ROW_NUMBER() OVER (
              PARTITION BY day
              ORDER BY SUM(input_tokens + output_tokens) DESC, provider ASC
            ) AS rank
          FROM base
          GROUP BY day, provider
        ),
        labeled AS (
          SELECT
            base.day,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS} THEN base.user_id
              ELSE ${GROUP_BY_DAY_OTHER_USER_ID}
            END AS user_id,
            CASE
              WHEN user_ranked.rank <= ${GROUP_BY_DAY_TOP_USERS}
                THEN COALESCE(NULLIF(TRIM(base.user_display), ''), base.user_id)
              ELSE 'Other'
            END AS user_display,
            CASE
              WHEN base.model = '' OR model_ranked.rank <= ${GROUP_BY_DAY_MAX_MODELS}
                THEN base.model
              ELSE '__other__'
            END AS model,
            CASE
              WHEN base.provider = '' OR provider_ranked.rank <= ${GROUP_BY_DAY_MAX_PROVIDERS}
                THEN base.provider
              ELSE '__other__'
            END AS provider,
            base.spend,
            base.input_tokens,
            base.output_tokens
          FROM base
          INNER JOIN user_ranked
            ON base.day = user_ranked.day AND base.user_id = user_ranked.user_id
          INNER JOIN model_ranked
            ON base.day = model_ranked.day AND base.model = model_ranked.model
          INNER JOIN provider_ranked
            ON base.day = provider_ranked.day AND base.provider = provider_ranked.provider
        )
        SELECT
          day,
          model,
          provider,
          SUM(spend)::double precision AS spend,
          SUM(input_tokens)::double precision AS "totalInputTokens",
          SUM(output_tokens)::double precision AS "totalOutputTokens",
          MAX(user_display) AS "userDisplay",
          user_id AS "userId"
        FROM labeled
        GROUP BY day, user_id, model, provider
        ORDER BY day, user_id, model, provider
      `),
  ]);
  const dimRows = asRows<GroupByDayDimRow>(dimResult);

  type DimRow = (typeof dimRows)[number];
  const rowsByDay = new Map<string, DimRow[]>();
  for (const row of dimRows) {
    const list = rowsByDay.get(row.day) ?? [];
    list.push(row);
    rowsByDay.set(row.day, list);
  }

  const recordsByDay = new Map<string, GlobalUsageRecordItem[]>();
  for (const [day, rows] of rowsByDay) {
    recordsByDay.set(day, capGroupByDayRecords(day, rows));
  }

  const byDay = new Map(
    dayTotals.map((row) => [
      row.day,
      {
        date: dayjs.utc(row.day).toDate().getTime(),
        day: row.day,
        records: recordsByDay.get(row.day) ?? [],
        totalRequests: row.totalRequests,
        totalSpend: row.totalSpend,
        totalTokens: row.totalTokens,
      } satisfies GlobalUsageLog,
    ]),
  );

  // Every UTC day the half-open window touches, last day inclusive.
  return eachUtcDayKey(range).map(
    (key) =>
      byDay.get(key) ?? {
        date: dayjs.utc(key).toDate().getTime(),
        day: key,
        records: [],
        totalRequests: 0,
        totalSpend: 0,
        totalTokens: 0,
      },
  );
};
