import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { PlatformModuleId } from '@/const/platform/modules';

import { createdAt, timestamptz, updatedAt } from '../_helpers';

/** Singleton row identity — there is exactly one platform module-settings document. */
export const PLATFORM_MODULE_SETTINGS_ID = 'global';

export type PlatformModuleSettingsMap = Partial<Record<PlatformModuleId, boolean>>;

/**
 * Platform module on/off settings — a single logical row.
 * `id` is always the singleton constant `'global'`.
 *
 * A missing row means "everything enabled" (never fail closed). `modules` is a
 * partial override map: omitted keys stay on. `revision` is a monotonic CAS token.
 */
export const platformModuleSettings = pgTable(
  'platform_module_settings',
  {
    id: text('id').primaryKey().notNull(),

    modules: jsonb('modules')
      .$type<PlatformModuleSettingsMap>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** When the first-run module wizard completed. Null = show the guide. */
    setupCompletedAt: timestamptz('setup_completed_at'),
    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(1),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_module_settings_id_singleton', sql`${t.id} = 'global'`),
    check('platform_module_settings_revision_check', sql`${t.revision} >= 1`),
  ],
);

export type PlatformModuleSettingsItem = typeof platformModuleSettings.$inferSelect;
export type NewPlatformModuleSettings = typeof platformModuleSettings.$inferInsert;
