import { index, integer, jsonb, pgTable, primaryKey, text, varchar } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '../_helpers';
import type { PlatformResourceStatus } from './common';

/**
 * Control mode for a platform setting path (M05).
 * Visibility is a separate column — never encoded as mode.
 */
export type PlatformSettingMode = 'user' | 'default' | 'locked';

/** Presentation-only visibility (does not change resolve winner by itself). */
export type PlatformSettingVisibility = 'visible' | 'hidden';

/**
 * Aggregate settings resource pointer + draft (resourceType=settings, id=global).
 * Publish/rollback use a single atomic revision pointer via PlatformPublisherService.
 */
export const platformSettingsBundle = pgTable('platform_settings_bundle', {
  /** Deterministic singleton id — always `global`. */
  id: text('id').primaryKey().notNull(),
  /**
   * Full draft policy map:
   * `{ [path]: { mode, visibility, value, schemaVersion } }`
   */
  draft: jsonb('draft')
    .$type<
      Record<
        string,
        {
          mode: PlatformSettingMode;
          schemaVersion: number;
          value: unknown;
          visibility: PlatformSettingVisibility;
        }
      >
    >()
    .notNull()
    .default({}),
  status: varchar('status', { length: 32 })
    .$type<PlatformResourceStatus>()
    .notNull()
    .default('draft'),
  /** Optimistic-lock / published revision pointer. */
  revision: integer('revision').notNull().default(0),
  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PlatformSettingsBundleItem = typeof platformSettingsBundle.$inferSelect;
export type NewPlatformSettingsBundle = typeof platformSettingsBundle.$inferInsert;

/**
 * Path-level published platform setting policies (defaults / lock / hide).
 * Written atomically on publish from the aggregate draft snapshot.
 */
export const platformSettingPolicies = pgTable(
  'platform_setting_policies',
  {
    path: text('path').primaryKey().notNull(),
    mode: varchar('mode', { length: 32 }).$type<PlatformSettingMode>().notNull().default('user'),
    /**
     * Presentation visibility. Independent of `mode`.
     * `hidden` never silently locks or deletes overrides.
     */
    visibility: varchar('visibility', { length: 32 })
      .$type<PlatformSettingVisibility>()
      .notNull()
      .default('visible'),
    value: jsonb('value').$type<unknown>(),
    schemaVersion: integer('schema_version').notNull().default(1),
    /** Published bundle revision that last wrote this path. */
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
    index('platform_setting_policies_visibility_idx').on(t.visibility),
  ],
);

export type PlatformSettingPolicyItem = typeof platformSettingPolicies.$inferSelect;
export type NewPlatformSettingPolicy = typeof platformSettingPolicies.$inferInsert;

/**
 * Explicit per-user setting overrides.
 * Row existence = explicit user intent (even when value equals current default).
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
    index('user_setting_overrides_path_idx').on(t.path),
  ],
);

export type UserSettingOverrideItem = typeof userSettingOverrides.$inferSelect;
export type NewUserSettingOverride = typeof userSettingOverrides.$inferInsert;

/**
 * Monotonic per-user override revision token.
 * Survives deleting the last override so cache keys still change.
 */
export const userSettingOverrideRevisions = pgTable('user_setting_override_revisions', {
  userId: text('user_id').primaryKey().notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export type UserSettingOverrideRevisionItem = typeof userSettingOverrideRevisions.$inferSelect;
export type NewUserSettingOverrideRevision = typeof userSettingOverrideRevisions.$inferInsert;
