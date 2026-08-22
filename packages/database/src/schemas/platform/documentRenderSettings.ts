import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { PlatformDocumentRenderSettings } from '@/types/platform/documentRenderSettings';

import { createdAt, updatedAt } from '../_helpers';

/** Singleton row identity — there is exactly one platform document-render settings document. */
export const PLATFORM_DOCUMENT_RENDER_SETTINGS_ID = 'global';

/**
 * Platform document-render runtime settings — a single logical row.
 * `id` is always the singleton constant `'global'`. Non-secret; the model applies
 * built-in defaults (`enabled: false`) when the row is absent so a fresh install
 * keeps using environment variables.
 *
 * `revision` is a monotonic CAS token: writers must supply the expected revision
 * and the model advances it only on a successful conditional update.
 */
export const platformDocumentRenderSettings = pgTable(
  'platform_document_render_settings',
  {
    id: text('id').primaryKey().notNull(),

    config: jsonb('config')
      .$type<PlatformDocumentRenderSettings>()
      .notNull()
      .default(sql`'{"enabled":false}'::jsonb`),
    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(0),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_document_render_settings_id_singleton', sql`${t.id} = 'global'`),
    check('platform_document_render_settings_revision_check', sql`${t.revision} >= 0`),
  ],
);

export type PlatformDocumentRenderSettingsItem = typeof platformDocumentRenderSettings.$inferSelect;
export type NewPlatformDocumentRenderSettings = typeof platformDocumentRenderSettings.$inferInsert;
