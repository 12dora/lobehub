import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { users } from '../user';

/**
 * Cached EasyAuth permission snapshot per user (M02).
 * Used for aihub.access checks and role sync; degraded=true when last fetch failed.
 */
export const platformEasyauthGrantSnapshots = pgTable(
  'platform_easyauth_grant_snapshots',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformEasyauthGrantSnapshots', 16))
      .primaryKey()
      .notNull(),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** Authentik / EasyAuth external subject id used in the permissions API path. */
    externalUserId: text('external_user_id').notNull(),
    appKey: varchar('app_key', { length: 64 }).notNull().default('aihub'),

    groups: jsonb('groups').$type<unknown[]>().notNull().default([]),
    grants: jsonb('grants').$type<unknown[]>().notNull().default([]),

    grantVersion: integer('grant_version').notNull().default(0),
    catalogVersion: integer('catalog_version').notNull().default(0),
    snapshotVersion: text('snapshot_version').notNull().default('0'),

    expiresAt: timestamptz('expires_at'),
    fetchedAt: timestamptz('fetched_at').notNull().defaultNow(),
    /** True when last EasyAuth call failed and this row is a stale fallback. */
    degraded: boolean('degraded').notNull().default(false),
    /** Redacted last error message (never tokens). */
    lastError: text('last_error'),
    /** Whether grants include aihub.access (denormalized for fast checks). */
    accessGranted: boolean('access_granted').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_easyauth_grant_snapshots_user_app_unique').on(t.userId, t.appKey),
    index('platform_easyauth_grant_snapshots_external_idx').on(t.externalUserId, t.appKey),
    index('platform_easyauth_grant_snapshots_access_idx').on(t.accessGranted),
  ],
);

export type PlatformEasyauthGrantSnapshotItem = typeof platformEasyauthGrantSnapshots.$inferSelect;
export type NewPlatformEasyauthGrantSnapshot = typeof platformEasyauthGrantSnapshots.$inferInsert;
