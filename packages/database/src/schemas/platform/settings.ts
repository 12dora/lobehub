import { index, integer, jsonb, pgTable, primaryKey, text, varchar } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '../_helpers';
import type { PlatformResourceStatus } from './common';

export type PlatformSettingMode = 'user' | 'default' | 'locked' | 'hidden';

/**
 * Path-level platform setting policies (defaults / lock / hide).
 * Empty shell in Migration 0 — populated by M05.
 */
export const platformSettingPolicies = pgTable(
  'platform_setting_policies',
  {
    path: text('path').primaryKey().notNull(),
    mode: varchar('mode', { length: 32 }).$type<PlatformSettingMode>().notNull().default('user'),
    value: jsonb('value').$type<unknown>(),
    schemaVersion: integer('schema_version').notNull().default(1),
    /** Current published revision pointer (optimistic lock). */
    revision: integer('revision').notNull().default(0),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_setting_policies_status_idx').on(t.status),
    index('platform_setting_policies_path_status_idx').on(t.path, t.status),
  ],
);

export type PlatformSettingPolicyItem = typeof platformSettingPolicies.$inferSelect;
export type NewPlatformSettingPolicy = typeof platformSettingPolicies.$inferInsert;

/**
 * Explicit per-user setting overrides. Empty shell in Migration 0 — populated by M05.
 */
export const userSettingOverrides = pgTable(
  'user_setting_overrides',
  {
    userId: text('user_id').notNull(),
    path: text('path').notNull(),
    value: jsonb('value').$type<unknown>(),
    source: varchar('source', { length: 32 }).notNull().default('user'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.path], name: 'user_setting_overrides_pkey' }),
    index('user_setting_overrides_user_id_idx').on(t.userId),
  ],
);

export type UserSettingOverrideItem = typeof userSettingOverrides.$inferSelect;
export type NewUserSettingOverride = typeof userSettingOverrides.$inferInsert;
