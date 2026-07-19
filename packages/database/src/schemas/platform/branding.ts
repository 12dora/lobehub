import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { users } from '../user';
import type { PlatformResourceStatus } from './common';

export type PlatformBrandingAssetKind = 'desktopIcon' | 'favicon' | 'icon' | 'logo' | 'ogImage';
export type PlatformBrandingAssetStatus = 'orphaned' | 'ready' | 'uploading';

/**
 * Platform branding draft / published config (M12). Empty shell in Migration 0.
 * Singleton is enforced at the service layer (one active published row).
 */
export const platformBranding = pgTable(
  'platform_branding',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformBranding', 16))
      .primaryKey()
      .notNull(),

    displayName: text('display_name'),
    shortName: text('short_name'),
    legalName: text('legal_name'),
    logoUrl: text('logo_url'),
    iconUrl: text('icon_url'),
    faviconUrl: text('favicon_url'),
    ogImageUrl: text('og_image_url'),
    supportUrl: text('support_url'),
    homeUrl: text('home_url'),
    privacyUrl: text('privacy_url'),
    termsUrl: text('terms_url'),
    emailSenderName: text('email_sender_name'),
    emailFrom: text('email_from'),
    pageTitleTemplate: text('page_title_template'),
    defaultAgentDisplayName: text('default_agent_display_name'),
    themeDefaults: jsonb('theme_defaults').$type<Record<string, unknown>>().default({}),
    desktop: jsonb('desktop').$type<Record<string, unknown>>().default({}),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_branding_status_idx').on(t.status),
    index('platform_branding_revision_idx').on(t.revision),
  ],
);

export type PlatformBrandingItem = typeof platformBranding.$inferSelect;
export type NewPlatformBranding = typeof platformBranding.$inferInsert;

/**
 * Platform-owned immutable Branding objects. Ownership is independent from the
 * administrator who uploaded the object; createdBy is audit attribution only.
 */
export const platformBrandingAssets = pgTable(
  'platform_branding_assets',
  {
    id: text('id').primaryKey().notNull(),
    objectKey: text('object_key').notNull(),
    mimeType: varchar('mime_type', { length: 64 }).notNull(),
    size: integer('size').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    kind: varchar('kind', { length: 32 }).$type<PlatformBrandingAssetKind>().notNull(),
    status: varchar('status', { length: 32 }).$type<PlatformBrandingAssetStatus>().notNull(),

    /** Nullable actor attribution; deleting an administrator never deletes the asset. */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Immutable idempotency actor lane, intentionally not a user foreign key. */
    requestActorId: text('request_actor_id').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    requestId: uuid('request_id').notNull(),
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),

    draftPinned: boolean('draft_pinned').notNull().default(false),
    firstPublishedRevision: integer('first_published_revision'),

    /** Short-lived owner used to prevent concurrent writes to the same object key. */
    uploadOwner: uuid('upload_owner'),
    uploadLeaseUntil: timestamptz('upload_lease_until'),

    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    cleanupAfter: timestamptz('cleanup_after').notNull(),
    lastCleanupError: varchar('last_cleanup_error', { length: 128 }),
    objectDeletedAt: timestamptz('object_deleted_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_branding_assets_object_key_unique').on(t.objectKey),
    uniqueIndex('platform_branding_assets_request_lane_unique').on(
      t.requestActorId,
      t.operation,
      t.requestId,
    ),
    index('platform_branding_assets_cleanup_idx').on(t.status, t.cleanupAfter),
    index('platform_branding_assets_created_by_idx').on(t.createdBy),
    index('platform_branding_assets_published_revision_idx').on(t.firstPublishedRevision),
    check('platform_branding_assets_size_positive', sql`${t.size} > 0`),
    check('platform_branding_assets_width_positive', sql`${t.width} > 0`),
    check('platform_branding_assets_height_positive', sql`${t.height} > 0`),
    check('platform_branding_assets_cleanup_attempts_nonnegative', sql`${t.cleanupAttempts} >= 0`),
    check(
      'platform_branding_assets_first_revision_positive',
      sql`${t.firstPublishedRevision} IS NULL OR ${t.firstPublishedRevision} > 0`,
    ),
  ],
);

export type PlatformBrandingAssetItem = typeof platformBrandingAssets.$inferSelect;
export type NewPlatformBrandingAsset = typeof platformBrandingAssets.$inferInsert;
