import { index, integer, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt } from '../_helpers';
import type { PlatformAuditResult } from './common';

/**
 * Append-only platform audit log.
 * Application code must only INSERT / SELECT; retention cleanup is an offline job.
 *
 * Diff payloads must be redacted before insert (API keys, tokens, client secrets,
 * Authorization headers, cookies, full key vaults must never appear).
 */
export const platformAuditLogs = pgTable(
  'platform_audit_logs',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAuditLogs', 16))
      .primaryKey()
      .notNull(),

    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),

    /** Target resource type (may mirror PlatformResourceType or free-form system targets). */
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: text('target_id'),

    result: varchar('result', { length: 32 }).$type<PlatformAuditResult>().notNull(),
    reason: text('reason'),
    requestId: text('request_id'),

    /** Hashed IP (or truncated digest) — never store raw client IP long-term. */
    ipHash: text('ip_hash'),
    /** Truncated user-agent summary. */
    userAgent: text('user_agent'),

    beforeDiff: jsonb('before_diff').$type<Record<string, unknown> | null>(),
    afterDiff: jsonb('after_diff').$type<Record<string, unknown> | null>(),

    configRevision: integer('config_revision'),

    createdAt: createdAt(),
  },
  (t) => [
    index('platform_audit_logs_created_at_idx').on(t.createdAt),
    index('platform_audit_logs_actor_user_id_idx').on(t.actorUserId),
    index('platform_audit_logs_target_type_id_idx').on(t.targetType, t.targetId),
    index('platform_audit_logs_action_idx').on(t.action),
    index('platform_audit_logs_request_id_idx').on(t.requestId),
  ],
);

export type PlatformAuditLogItem = typeof platformAuditLogs.$inferSelect;
export type NewPlatformAuditLog = typeof platformAuditLogs.$inferInsert;
