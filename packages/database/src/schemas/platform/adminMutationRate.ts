import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { timestamptz, updatedAt } from '../_helpers';

/**
 * Multi-instance administrative mutation rate windows.
 *
 * Primary key is a SHA-256 digest of `actorId\\0procedure` — raw actor IDs and
 * procedure paths never appear in this table. Windows use the database clock
 * via atomic upsert SQL in the model layer.
 */
export const platformAdminMutationRateWindows = pgTable(
  'platform_admin_mutation_rate_windows',
  {
    /** SHA-256 hex digest of actor + canonical procedure scope. */
    scopeDigest: text('scope_digest').primaryKey().notNull(),

    /** Start of the current fixed window (server/DB time). */
    windowStart: timestamptz('window_start').notNull(),

    /** Consumed count inside the current window. */
    count: integer('count').notNull().default(0),

    updatedAt: updatedAt(),
  },
  (t) => [
    // Supports bounded retention cleanup by window age.
    index('platform_admin_mutation_rate_windows_window_start_idx').on(t.windowStart),
  ],
);

export type PlatformAdminMutationRateWindowItem =
  typeof platformAdminMutationRateWindows.$inferSelect;
export type NewPlatformAdminMutationRateWindow =
  typeof platformAdminMutationRateWindows.$inferInsert;
