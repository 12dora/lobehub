import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from '../_helpers';

/**
 * Platform authentication / registration settings — a single logical row.
 * `id` is always the singleton constant `'global'`. Non-secret; the model applies
 * built-in defaults when the row is absent so a fresh install behaves as "open".
 *
 * `revision` is a monotonic CAS token: writers must supply the expected revision
 * and the model advances it only on a successful conditional update.
 */
export const platformAuthSettings = pgTable(
  'platform_auth_settings',
  {
    id: text('id').primaryKey().notNull(),

    emailDomainAllowlist: jsonb('email_domain_allowlist').$type<string[]>().notNull().default([]),
    emailDomainAllowlistEnabled: boolean('email_domain_allowlist_enabled').notNull().default(false),
    openRegistration: boolean('open_registration').notNull().default(true),
    /** Optimistic concurrency token; update requires expectedRevision match. */
    revision: integer('revision').notNull().default(0),

    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_auth_settings_id_singleton', sql`${t.id} = 'global'`),
    check('platform_auth_settings_revision_check', sql`${t.revision} >= 0`),
    // Enabled allowlisting with an empty list would mean "no restriction" at the matcher —
    // reject that combination so enabling the control always restricts something.
    check(
      'platform_auth_settings_allowlist_nonempty_when_enabled',
      sql`(NOT ${t.emailDomainAllowlistEnabled}) OR (jsonb_array_length(${t.emailDomainAllowlist}) > 0)`,
    ),
  ],
);

export type PlatformAuthSettingsItem = typeof platformAuthSettings.$inferSelect;
export type NewPlatformAuthSettings = typeof platformAuthSettings.$inferInsert;
