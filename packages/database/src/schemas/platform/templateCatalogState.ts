import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';

import { timestamptz } from '../_helpers';

export const PLATFORM_TEMPLATE_CATALOG_DOMAINS = ['agent_templates', 'task_templates'] as const;
export type PlatformTemplateCatalogDomain = (typeof PLATFORM_TEMPLATE_CATALOG_DOMAINS)[number];

/**
 * One-row-per-domain marker that the platform template catalog has been taken over.
 *
 * Written the first time built-in examples are auto-seeded, when an operator mutates the
 * catalog, or by migration 0026 for an already-populated tenant. `seeded_locale = 'legacy'`
 * is the sentinel for those last two cases (the original console locale is unknown).
 * Presence of the marker — not row count — is what stops a later empty catalog from being
 * re-seeded: deleting every template must leave users with nothing.
 */
export const platformTemplateCatalogState = pgTable(
  'platform_template_catalog_state',
  {
    /** Catalog this marker belongs to (`agent_templates` | `task_templates`). */
    domain: text('domain').$type<PlatformTemplateCatalogDomain>().primaryKey().notNull(),
    seededAt: timestamptz('seeded_at').notNull().defaultNow(),
    /** Locale used for the first seed (or the locale observed when marking an existing catalog). */
    seededLocale: text('seeded_locale').notNull(),
    /** Operator who triggered the first seed; null for startup / anonymous fallback. */
    seededBy: text('seeded_by'),
  },
  (t) => [
    check(
      'platform_template_catalog_state_domain_check',
      sql`${t.domain} IN ('agent_templates', 'task_templates')`,
    ),
  ],
);

export type PlatformTemplateCatalogStateItem = typeof platformTemplateCatalogState.$inferSelect;
export type NewPlatformTemplateCatalogState = typeof platformTemplateCatalogState.$inferInsert;
