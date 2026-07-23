import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Platform authentication / registration settings — a single logical row.
 * `id` is always the singleton constant `'global'`. Non-secret; the model applies
 * built-in defaults when the row is absent so a fresh install behaves as "open".
 */
export const platformAuthSettings = pgTable('platform_auth_settings', {
  id: text('id').primaryKey().notNull(),

  emailDomainAllowlist: jsonb('email_domain_allowlist').$type<string[]>().notNull().default([]),
  emailDomainAllowlistEnabled: boolean('email_domain_allowlist_enabled').notNull().default(false),
  openRegistration: boolean('open_registration').notNull().default(true),

  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PlatformAuthSettingsItem = typeof platformAuthSettings.$inferSelect;
export type NewPlatformAuthSettings = typeof platformAuthSettings.$inferInsert;
