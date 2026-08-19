import type { SQL } from 'drizzle-orm';
import { and, eq, lte, or, sql } from 'drizzle-orm';

import type { PlatformJobItem } from '../../schemas/platform';
import { platformJobs } from '../../schemas/platform';
import type { Transaction } from '../../type';

export const DEFAULT_LEASE_MS = 30_000;
export const databaseNow = sql<Date>`statement_timestamp()`;

export const databaseLeaseUntil = (leaseMs: number) =>
  sql<Date>`statement_timestamp() + (${leaseMs} * interval '1 millisecond')`;

export const MAX_ATTEMPTS_LEASE_EXPIRED_ERROR = {
  code: 'MAX_ATTEMPTS_EXCEEDED',
  reason: 'lease_expired_after_attempt_budget',
} as const;

export const MAX_ATTEMPTS_LEASE_EXPIRED_ERROR_JSON = JSON.stringify(
  MAX_ATTEMPTS_LEASE_EXPIRED_ERROR,
);

export const withinAttemptBudgetSql = sql<boolean>`(
  ${platformJobs.maxAttempts} IS NULL
  OR ${platformJobs.attempt} < ${platformJobs.maxAttempts}
)`;

export const attemptBudgetExhaustedSql = sql<boolean>`(
  ${platformJobs.maxAttempts} IS NOT NULL
  AND ${platformJobs.attempt} >= ${platformJobs.maxAttempts}
)`;

export const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

export const coerceClaimedJob = (row: PlatformJobItem): PlatformJobItem => ({
  ...row,
  createdAt: asDate(row.createdAt) ?? row.createdAt,
  finishedAt: asDate(row.finishedAt),
  heartbeatAt: asDate(row.heartbeatAt),
  leaseUntil: asDate(row.leaseUntil),
  startedAt: asDate(row.startedAt),
  updatedAt: asDate(row.updatedAt) ?? row.updatedAt,
});

export const claimCandidateWhere = (typeFilter?: SQL) => {
  const conditions = [
    or(
      eq(platformJobs.status, 'pending'),
      and(eq(platformJobs.status, 'running'), lte(platformJobs.leaseUntil, databaseNow)),
    )!,
    withinAttemptBudgetSql,
  ];

  if (typeFilter) {
    conditions.push(typeFilter);
  }

  return and(...conditions);
};

export const deadLetterLeaseExhausted = async (tx: Transaction, typeFilter?: SQL) => {
  await tx
    .update(platformJobs)
    .set({
      finishedAt: databaseNow,
      lastError: sql<Record<string, unknown>>`coalesce(
        ${platformJobs.lastError},
        ${sql.raw(`'${MAX_ATTEMPTS_LEASE_EXPIRED_ERROR_JSON}'`)}::jsonb
      )`,
      leaseOwner: null,
      leaseUntil: null,
      status: 'dead',
      updatedAt: databaseNow,
    })
    .where(
      and(
        eq(platformJobs.status, 'running'),
        lte(platformJobs.leaseUntil, databaseNow),
        attemptBudgetExhaustedSql,
        typeFilter,
      ),
    );
};
