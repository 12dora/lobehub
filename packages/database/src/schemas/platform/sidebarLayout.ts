import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { SidebarLayoutConfig } from '@/types/platform/sidebarLayout';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Platform home-sidebar layout policy — a single logical row (id='global').
 * `mode` is 'user' (each user customizes their own) or 'platform' (centrally managed).
 * `layout` holds the platform-managed layout; null until an admin configures it.
 *
 * DB CHECK constraints are declared here for schema documentation / future migrations.
 * Applying them on existing installations requires a db-core migration (not created here).
 */
export const platformSidebarLayout = pgTable(
  'platform_sidebar_layout',
  {
    id: text('id').primaryKey().notNull(),

    layout: jsonb('layout').$type<SidebarLayoutConfig | null>(),
    mode: text('mode').notNull().default('user'),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_sidebar_layout_id_singleton', sql`${t.id} = 'global'`),
    check('platform_sidebar_layout_mode_check', sql`${t.mode} IN ('user', 'platform')`),
  ],
);

export type PlatformSidebarLayoutItem = typeof platformSidebarLayout.$inferSelect;
export type NewPlatformSidebarLayout = typeof platformSidebarLayout.$inferInsert;
