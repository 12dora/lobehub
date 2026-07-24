import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { SidebarLayoutConfig } from '@/types/platform/sidebarLayout';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Platform home-sidebar layout policy — a single logical row (id='global').
 * `mode` is 'user' (each user customizes their own) or 'platform' (centrally managed).
 * `layout` holds the platform-managed layout; null until an admin configures it.
 *
 * `revision` is a monotonic CAS token: writers must supply the expected revision
 * and the model advances it only on a successful conditional update.
 */
export const platformSidebarLayout = pgTable(
  'platform_sidebar_layout',
  {
    id: text('id').primaryKey().notNull(),

    layout: jsonb('layout').$type<SidebarLayoutConfig | null>(),
    mode: text('mode').notNull().default('user'),
    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(0),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_sidebar_layout_id_singleton', sql`${t.id} = 'global'`),
    check('platform_sidebar_layout_mode_check', sql`${t.mode} IN ('user', 'platform')`),
    check('platform_sidebar_layout_revision_check', sql`${t.revision} >= 0`),
  ],
);

export type PlatformSidebarLayoutItem = typeof platformSidebarLayout.$inferSelect;
export type NewPlatformSidebarLayout = typeof platformSidebarLayout.$inferInsert;
