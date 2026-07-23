import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type { SidebarLayoutConfig } from '@/types/platform/sidebarLayout';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Platform home-sidebar layout policy — a single logical row (id='global').
 * `mode` is 'user' (each user customizes their own) or 'platform' (centrally managed).
 * `layout` holds the platform-managed layout; null until an admin configures it.
 */
export const platformSidebarLayout = pgTable('platform_sidebar_layout', {
  id: text('id').primaryKey().notNull(),

  layout: jsonb('layout').$type<SidebarLayoutConfig | null>(),
  mode: text('mode').notNull().default('user'),

  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PlatformSidebarLayoutItem = typeof platformSidebarLayout.$inferSelect;
export type NewPlatformSidebarLayout = typeof platformSidebarLayout.$inferInsert;
