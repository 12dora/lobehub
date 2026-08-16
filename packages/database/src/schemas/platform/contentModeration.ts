import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

import type {
  ContentModerationConfig,
  KeywordRule,
  ModerationCategory,
  ModerationCategoryAction,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/types/platform/contentModeration';

import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { users } from '../user';

export const PLATFORM_CONTENT_MODERATION_SETTINGS_ID = 'default';

export interface ContentModerationUserSnapshot {
  email?: string | null;
  fullName?: string | null;
  username?: string | null;
}

export interface ContentModerationMatchedRule {
  id: string;
  isRegex: boolean;
  pattern: string;
}

export type ContentModerationCategoryScores = Partial<Record<ModerationCategory, number>>;
export type ContentModerationThresholdSnapshot = Record<
  ModerationCategory,
  { action: ModerationCategoryAction; threshold: number }
>;

/**
 * Singleton platform content-moderation settings. `id` is always `'default'`.
 * `revision` is a monotonic CAS token — writers must supply expectedRevision.
 */
export const platformContentModerationSettings = pgTable(
  'platform_content_moderation_settings',
  {
    id: text('id').primaryKey().notNull(),

    config: jsonb('config').$type<ContentModerationConfig>().notNull(),
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_content_moderation_settings_id_singleton', sql`${t.id} = 'default'`),
    check('platform_content_moderation_settings_revision_check', sql`${t.revision} >= 0`),
  ],
);

export type PlatformContentModerationSettingsItem =
  typeof platformContentModerationSettings.$inferSelect;
export type NewPlatformContentModerationSettings =
  typeof platformContentModerationSettings.$inferInsert;

/**
 * Per-request content-moderation decision record.
 * `prompt_full` is stored only when `storeFullPrompt` is on; list/detail reads never select it.
 */
export const platformContentModerationRecords = pgTable(
  'platform_content_moderation_records',
  {
    id: text('id').primaryKey().notNull(),

    createdAt: createdAt(),

    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    userSnapshot: jsonb('user_snapshot').$type<ContentModerationUserSnapshot | null>(),

    requestKind: text('request_kind').$type<ModerationRequestKind>().notNull(),
    requestId: text('request_id'),
    topicId: text('topic_id'),
    messageId: text('message_id'),

    provider: text('provider').notNull(),
    model: text('model').notNull(),
    effectiveProvider: text('effective_provider'),
    effectiveModel: text('effective_model'),

    policyAction: text('policy_action').$type<ModerationCategoryAction>().notNull(),
    effectiveAction: text('effective_action').$type<ModerationEffectiveAction>().notNull(),
    source: text('source').$type<ModerationDecisionSource>().notNull(),

    topCategory: text('top_category').$type<ModerationCategory>(),
    topScore: numeric('top_score', { mode: 'number', precision: 6, scale: 4 }),
    categoryScores: jsonb('category_scores').$type<ContentModerationCategoryScores>().notNull(),
    thresholdSnapshot: jsonb('threshold_snapshot')
      .$type<ContentModerationThresholdSnapshot>()
      .notNull(),
    matchedRule: jsonb('matched_rule').$type<ContentModerationMatchedRule | null>(),

    promptHash: text('prompt_hash').notNull(),
    promptExcerpt: text('prompt_excerpt').notNull(),
    promptFull: text('prompt_full'),

    classifierLatencyMs: integer('classifier_latency_ms'),
    error: text('error'),
    /** True when a classifier error was treated as a user-facing block (`onError: 'block'`). */
    enforced: boolean('enforced').notNull().default(false),

    violationCount: integer('violation_count').notNull().default(0),
    autoBanned: boolean('auto_banned').notNull().default(false),
    notified: boolean('notified').notNull().default(false),

    revealedAt: timestamptz('revealed_at'),
    revealedBy: text('revealed_by'),
  },
  (t) => [
    index('platform_content_moderation_records_created_at_idx').on(t.createdAt.desc()),
    index('platform_content_moderation_records_user_id_created_at_idx').on(
      t.userId,
      t.createdAt.desc(),
    ),
    index('platform_content_moderation_records_effective_action_created_at_idx').on(
      t.effectiveAction,
      t.createdAt.desc(),
    ),
    index('platform_content_moderation_records_top_category_created_at_idx').on(
      t.topCategory,
      t.createdAt.desc(),
    ),
    index('platform_content_moderation_records_prompt_hash_idx').on(t.promptHash),
  ],
);

export type PlatformContentModerationRecordItem =
  typeof platformContentModerationRecords.$inferSelect;
export type NewPlatformContentModerationRecord =
  typeof platformContentModerationRecords.$inferInsert;

/**
 * Hourly aggregation so allow-volume can be charted without scanning the record table.
 * `top_category` is `''` when the decision had no top category (PK cannot contain NULL).
 */
export const platformContentModerationHourlyStats = pgTable(
  'platform_content_moderation_hourly_stats',
  {
    bucketStart: timestamptz('bucket_start').notNull(),
    requestKind: text('request_kind').$type<ModerationRequestKind>().notNull(),
    effectiveAction: text('effective_action').$type<ModerationEffectiveAction>().notNull(),
    policyAction: text('policy_action').$type<ModerationCategoryAction>().notNull(),
    source: text('source').$type<ModerationDecisionSource>().notNull(),
    topCategory: text('top_category').notNull().default(''),

    count: integer('count').notNull().default(0),
    latencySumMs: bigint('latency_sum_ms', { mode: 'number' }).notNull().default(0),
    latencyCount: integer('latency_count').notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [
        t.bucketStart,
        t.requestKind,
        t.effectiveAction,
        t.policyAction,
        t.source,
        t.topCategory,
      ],
      name: 'platform_content_moderation_hourly_stats_pk',
    }),
  ],
);

export type PlatformContentModerationHourlyStatsItem =
  typeof platformContentModerationHourlyStats.$inferSelect;
export type NewPlatformContentModerationHourlyStats =
  typeof platformContentModerationHourlyStats.$inferInsert;

/**
 * Decision cache keyed by sha256(normalized prompt).
 * Readers must ignore rows whose `expires_at` is in the past.
 */
export const platformContentModerationDecisions = pgTable(
  'platform_content_moderation_decisions',
  {
    promptHash: text('prompt_hash').primaryKey().notNull(),
    categories: jsonb('categories').$type<ContentModerationCategoryScores>().notNull(),
    source: text('source').$type<ModerationDecisionSource>().notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: createdAt(),
    lastHitAt: timestamptz('last_hit_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [index('platform_content_moderation_decisions_expires_at_idx').on(t.expiresAt)],
);

export type PlatformContentModerationDecisionItem =
  typeof platformContentModerationDecisions.$inferSelect;
export type NewPlatformContentModerationDecision =
  typeof platformContentModerationDecisions.$inferInsert;

export type { KeywordRule };
