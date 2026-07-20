import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core';

import { timestamptz } from '../_helpers';

export const PLATFORM_INSTANCE_DOMAINS = [
  'agent_catalog',
  'ai_catalog',
  'branding',
  'connector_catalog',
  'identity',
  'managed_policy',
  'settings',
  'skill_catalog',
] as const;

export type PlatformInstanceDomain = (typeof PLATFORM_INSTANCE_DOMAINS)[number];

export const PLATFORM_INSTANCE_LOAD_MODES = [
  'process_cached',
  'request_scoped',
  'restart_activated',
] as const;

export type PlatformInstanceLoadMode = (typeof PLATFORM_INSTANCE_LOAD_MODES)[number];

export const PLATFORM_INSTANCE_REVISION_SOURCES = [
  'cache',
  'database',
  'environment',
  'lkg',
  'unavailable',
] as const;

export type PlatformInstanceRevisionSource = (typeof PLATFORM_INSTANCE_REVISION_SOURCES)[number];

export const PLATFORM_INSTANCE_REVISION_HEALTH = ['degraded', 'healthy', 'unavailable'] as const;

export type PlatformInstanceRevisionHealth = (typeof PLATFORM_INSTANCE_REVISION_HEALTH)[number];

export const PLATFORM_INSTANCE_REVISION_ERROR_CATEGORIES = [
  'cache_unavailable',
  'configuration_invalid',
  'database_unavailable',
  'lkg_invalid',
  'lkg_unavailable',
  'load_failed',
  'secret_unavailable',
  'startup_unavailable',
] as const;

export type PlatformInstanceRevisionErrorCategory =
  (typeof PLATFORM_INSTANCE_REVISION_ERROR_CATEGORIES)[number];

/**
 * Anonymous inventory row for one persistent server process. The identifier contains random
 * process-local entropy only; host, network, environment and connection attributes are forbidden.
 */
export const platformInstanceHeartbeats = pgTable(
  'platform_instance_heartbeats',
  {
    instanceId: varchar('instance_id', { length: 64 }).primaryKey().notNull(),
    lastHeartbeatAt: timestamptz('last_heartbeat_at')
      .default(sql`statement_timestamp()`)
      .notNull(),
    startedAt: timestamptz('started_at')
      .default(sql`statement_timestamp()`)
      .notNull(),
  },
  (t) => [
    index('platform_instance_heartbeats_freshness_idx').on(t.lastHeartbeatAt),
    check('platform_instance_heartbeats_id_check', sql`${t.instanceId} ~ '^pinst_[a-f0-9]{48}$'`),
    check('platform_instance_heartbeats_time_check', sql`${t.lastHeartbeatAt} >= ${t.startedAt}`),
  ],
);

export type PlatformInstanceHeartbeatItem = typeof platformInstanceHeartbeats.$inferSelect;
export type NewPlatformInstanceHeartbeat = typeof platformInstanceHeartbeats.$inferInsert;

/**
 * Normalized, low-cardinality revision/load state reported by a registered process. Domain
 * adapters arrive in O02b; this table does not infer state from the OIDC-only instance registry.
 */
export const platformInstanceRevisionStates = pgTable(
  'platform_instance_revision_states',
  {
    domain: varchar('domain', { length: 32 }).$type<PlatformInstanceDomain>().notNull(),
    instanceId: varchar('instance_id', { length: 64 })
      .notNull()
      .references(() => platformInstanceHeartbeats.instanceId, { onDelete: 'cascade' }),
    errorCategory: varchar('error_category', {
      length: 64,
    }).$type<PlatformInstanceRevisionErrorCategory>(),
    health: varchar('health', { length: 32 })
      .$type<PlatformInstanceRevisionHealth>()
      .default('unavailable')
      .notNull(),
    loadMode: varchar('load_mode', { length: 32 })
      .$type<PlatformInstanceLoadMode>()
      .default('request_scoped')
      .notNull(),
    loadedAt: timestamptz('loaded_at')
      .default(sql`clock_timestamp()`)
      .notNull(),
    loadedRevision: integer('loaded_revision'),
    loadedRevisionId: varchar('loaded_revision_id', { length: 128 }),
    source: varchar('source', { length: 32 })
      .$type<PlatformInstanceRevisionSource>()
      .default('unavailable')
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.instanceId, t.domain],
      name: 'platform_instance_revision_states_pkey',
    }),
    index('platform_instance_revision_states_domain_loaded_idx').on(t.domain, t.loadedAt),
    check(
      'platform_instance_revision_states_domain_check',
      sql`${t.domain} IN ('agent_catalog', 'ai_catalog', 'branding', 'connector_catalog', 'identity', 'managed_policy', 'settings', 'skill_catalog')`,
    ),
    check(
      'platform_instance_revision_states_load_mode_check',
      sql`${t.loadMode} IN ('process_cached', 'request_scoped', 'restart_activated')`,
    ),
    check(
      'platform_instance_revision_states_source_check',
      sql`${t.source} IN ('cache', 'database', 'environment', 'lkg', 'unavailable')`,
    ),
    check(
      'platform_instance_revision_states_health_check',
      sql`${t.health} IN ('degraded', 'healthy', 'unavailable')`,
    ),
    check(
      'platform_instance_revision_states_error_check',
      sql`${t.errorCategory} IS NULL OR ${t.errorCategory} IN ('cache_unavailable', 'configuration_invalid', 'database_unavailable', 'lkg_invalid', 'lkg_unavailable', 'load_failed', 'secret_unavailable', 'startup_unavailable')`,
    ),
    check(
      'platform_instance_revision_states_outcome_check',
      sql`(${t.health} = 'healthy' AND ${t.source} <> 'unavailable' AND ${t.errorCategory} IS NULL)
        OR (${t.health} = 'degraded' AND ${t.source} <> 'unavailable' AND ${t.errorCategory} IS NOT NULL)
        OR (${t.health} = 'unavailable' AND ${t.source} = 'unavailable'
          AND ${t.errorCategory} IS NOT NULL
          AND ${t.loadedRevision} IS NULL AND ${t.loadedRevisionId} IS NULL)`,
    ),
    check(
      'platform_instance_revision_states_revision_check',
      sql`(${t.loadedRevision} IS NULL OR ${t.loadedRevision} >= 0)
        AND (${t.loadedRevisionId} IS NULL OR ${t.loadedRevisionId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')`,
    ),
    check(
      'platform_instance_revision_states_loaded_identity_check',
      sql`${t.health} = 'unavailable' OR ${t.loadMode} = 'request_scoped'
        OR ${t.loadedRevision} IS NOT NULL OR ${t.loadedRevisionId} IS NOT NULL`,
    ),
  ],
);

export type PlatformInstanceRevisionStateItem = typeof platformInstanceRevisionStates.$inferSelect;
export type NewPlatformInstanceRevisionState = typeof platformInstanceRevisionStates.$inferInsert;
