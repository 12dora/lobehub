import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

import { updatedAt } from '../_helpers';

/**
 * Domains that maintain a process-cached catalog authority token for system-health polling.
 * Generation advances atomically with catalog publish so multi-instance peeks converge via
 * a single PK read (no catalog-wide scan on the steady-state path).
 */
export const PLATFORM_CATALOG_AUTHORITY_DOMAINS = ['ai_catalog', 'skill_catalog'] as const;

export type PlatformCatalogAuthorityDomain = (typeof PLATFORM_CATALOG_AUTHORITY_DOMAINS)[number];

/**
 * Persisted per-domain generation + token stamp for multi-instance catalog authority.
 *
 * - `domain` is the sole primary key (`ai_catalog` | `skill_catalog`).
 * - `generation` is a monotonic counter bumped in the same transaction as publish.
 * - `token_kind` / `token_value` store a durable change stamp (not a full catalog hash).
 *   Process peeks still rebuild the canonical catalog token once when generation advances.
 */
export const platformCatalogAuthority = pgTable('platform_catalog_authority', {
  domain: text('domain').$type<PlatformCatalogAuthorityDomain>().primaryKey().notNull(),
  generation: bigint('generation', { mode: 'number' }).notNull().default(0),
  tokenKind: text('token_kind').notNull(),
  tokenValue: text('token_value').notNull(),
  updatedAt: updatedAt(),
});

export type PlatformCatalogAuthorityItem = typeof platformCatalogAuthority.$inferSelect;
export type NewPlatformCatalogAuthority = typeof platformCatalogAuthority.$inferInsert;
