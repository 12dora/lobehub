import type { BrowserDeviceProfile } from '@lobechat/types';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from '../_helpers';

export const PLATFORM_BROWSER_PROFILE_ID = 'default';

/**
 * JSON storage boundary. The shape is owned by `@lobechat/types`; the runtime
 * generator/validator in `@lobechat/model-runtime/browserProfile` remains the
 * semantic source of truth for the values.
 */
export type PlatformBrowserProfilePayload = BrowserDeviceProfile;

/** One installation-wide synthetic browser device profile. */
export const platformBrowserProfiles = pgTable(
  'platform_browser_profiles',
  {
    id: text('id').primaryKey().notNull(),
    profile: jsonb('profile').$type<PlatformBrowserProfilePayload>().notNull(),
    revision: integer('revision').notNull().default(0),
    seed: text('seed').notNull(),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('platform_browser_profiles_id_check', sql`${table.id} = 'default'`),
    check('platform_browser_profiles_revision_check', sql`${table.revision} >= 0`),
  ],
);

export type PlatformBrowserProfileItem = typeof platformBrowserProfiles.$inferSelect;
export type NewPlatformBrowserProfile = typeof platformBrowserProfiles.$inferInsert;
