import { index, integer, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, updatedAt } from '../_helpers';
import type { PlatformResourceStatus } from './common';

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
