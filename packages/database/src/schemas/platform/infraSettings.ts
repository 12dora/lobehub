import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { InfraSettingsPersistedConfig } from '@/types/platform/infraSettings';

import { createdAt, updatedAt } from '../_helpers';

export const INFRA_SETTINGS_OBJECT_STORAGE_ID = 'object_storage';
export const INFRA_SETTINGS_MAIL_ID = 'mail';

/**
 * Per-card infrastructure settings. `id` is `'object_storage'` or `'mail'`.
 * `revision` is a monotonic CAS token — writers must supply expectedRevision.
 * Secrets live as ciphertext fields inside `config` jsonb.
 */
export const platformInfraSettings = pgTable(
  'platform_infra_settings',
  {
    id: text('id').primaryKey().notNull(),

    config: jsonb('config')
      .$type<InfraSettingsPersistedConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_infra_settings_id_check', sql`${t.id} IN ('object_storage', 'mail')`),
    check('platform_infra_settings_revision_check', sql`${t.revision} >= 0`),
  ],
);

export type PlatformInfraSettingsItem = typeof platformInfraSettings.$inferSelect;
export type NewPlatformInfraSettings = typeof platformInfraSettings.$inferInsert;
