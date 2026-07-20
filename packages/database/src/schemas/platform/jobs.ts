import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import type { PlatformJobStatus } from './common';

/**
 * Platform background jobs: distribution, migration, connector sync, bulk ops.
 *
 * Workers claim jobs with a lease + heartbeat. After a worker crash the lease
 * expires and another worker may resume from `cursor`. `(type, idempotency_key)`
 * is unique so retries never re-run side effects for the same logical work unit.
 */
export const platformJobs = pgTable(
  'platform_jobs',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformJobs', 16))
      .primaryKey()
      .notNull(),

    type: varchar('type', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 })
      .$type<PlatformJobStatus>()
      .notNull()
      .default('pending'),

    /**
     * Stable idempotency key within `type`. Required for all creatable jobs so
     * concurrent / retried enqueue calls collapse to a single row.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),

    progressTotal: integer('progress_total'),
    progressDone: integer('progress_done').notNull().default(0),

    /** Opaque resume cursor written by the worker after each checkpoint. */
    cursor: jsonb('cursor').$type<Record<string, unknown> | string | number | null>(),

    resultSummary: jsonb('result_summary').$type<Record<string, unknown> | null>(),
    lastError: jsonb('last_error').$type<Record<string, unknown> | null>(),

    /** Number of execution attempts (increments on each claim). */
    attempt: integer('attempt').notNull().default(0),
    /** Soft max retries before moving to `dead`. Null = unlimited. */
    maxAttempts: integer('max_attempts'),

    /** Lease holder id (worker instance). */
    leaseOwner: text('lease_owner'),
    /** Exclusive lease expiry; other workers may reclaim after this instant. */
    leaseUntil: timestamptz('lease_until'),
    /** Last successful heartbeat from the lease owner. */
    heartbeatAt: timestamptz('heartbeat_at'),

    requestedBy: text('requested_by'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_jobs_type_idempotency_key_unique').on(t.type, t.idempotencyKey),
    index('platform_jobs_status_lease_until_idx').on(t.status, t.leaseUntil),
    index('platform_jobs_type_status_idx').on(t.type, t.status),
    index('platform_jobs_secret_rewrap_failure_parent_domain_row_idx')
      .on(
        sql`(${t.input}->>'parentJobId')`,
        sql`(${t.input}->>'domain')`,
        sql`(${t.input}->>'rowId')`,
      )
      .where(sql`${t.type} = 'platform.secret.rewrap.failure.v1' AND ${t.status} = 'failed'`),
    index('platform_jobs_rollout_agent_id_id_idx')
      .on(sql`(${t.input}->'snapshot'->>'agentId')`, t.id)
      .where(sql`${t.type} = 'platform.agent.rollout.v1'`),
    index('platform_jobs_rollout_transition_parent_status_user_idx')
      .on(sql`(${t.input}->>'parentJobId')`, t.status, sql`(${t.input}->>'userId')`)
      .where(sql`${t.type} = 'platform.agent.rollout.transition.v1'`),
    index('platform_jobs_created_at_idx').on(t.createdAt),
    index('platform_jobs_requested_by_idx').on(t.requestedBy),
  ],
);

export type PlatformJobItem = typeof platformJobs.$inferSelect;
export type NewPlatformJob = typeof platformJobs.$inferInsert;
