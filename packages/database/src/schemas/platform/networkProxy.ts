import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import type {
  ArtifactState,
  DesiredArtifacts,
  EngineIssue,
  InstanceHealing,
  NetworkProxyConfig,
  NetworkProxyEngineState,
  NetworkProxySubscriptionKind,
} from '@/types/platform/networkProxy';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { platformInstanceHeartbeats } from './instances';

export const PLATFORM_NETWORK_PROXY_SETTINGS_ID = 'default';

/**
 * Singleton platform network-proxy settings. `id` is always `'default'`.
 * `revision` is a monotonic CAS token — writers must supply expectedRevision.
 * `engine_generation` is a desired-state broadcast: each instance's supervisor
 * restarts when it observes a generation greater than the one it last applied.
 */
export const platformNetworkProxySettings = pgTable(
  'platform_network_proxy_settings',
  {
    id: text('id').primaryKey().notNull(),

    config: jsonb('config').$type<NetworkProxyConfig>().notNull(),
    revision: integer('revision').notNull().default(0),
    /** Bumped by "restart engine"; every instance restarts when it lags this value. */
    engineGeneration: integer('engine_generation').notNull().default(0),
    /**
     * Desired artifact versions. "Install (download)" writes it; every instance
     * downloads what is desired and not yet installed.
     */
    desiredArtifacts: jsonb('desired_artifacts')
      .$type<DesiredArtifacts>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedBy: text('updated_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_network_proxy_settings_id_singleton', sql`${t.id} = 'default'`),
    check('platform_network_proxy_settings_revision_check', sql`${t.revision} >= 0`),
  ],
);

export type PlatformNetworkProxySettingsItem = typeof platformNetworkProxySettings.$inferSelect;
export type NewPlatformNetworkProxySettings = typeof platformNetworkProxySettings.$inferInsert;

/**
 * Admin-managed subscription (URL or pasted share-link / YAML payload).
 * Ciphertext columns are PlatformSecretService envelopes; `url_host` is the
 * hostname only and is safe to list / audit.
 */
export const platformNetworkProxySubscriptions = pgTable(
  'platform_network_proxy_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .notNull()
      .$defaultFn(() => idGenerator('networkProxySubscriptions')),

    name: text('name').notNull(),
    kind: text('kind').$type<NetworkProxySubscriptionKind>().notNull(),

    /** `kind=url`: sealed subscription URL (often carries a token). */
    urlCiphertext: text('url_ciphertext'),
    /** Plain hostname extracted from the URL — list / audit only. */
    urlHost: text('url_host'),
    /** `kind=manual`: sealed share-link list or Clash YAML snippet. */
    payloadCiphertext: text('payload_ciphertext'),

    enabled: boolean('enabled').notNull().default(true),
    updateIntervalSec: integer('update_interval_sec'),
    userAgent: text('user_agent'),
    filter: text('filter'),
    excludeFilter: text('exclude_filter'),
    sortOrder: integer('sort_order').notNull().default(0),

    /**
     * Set by refreshSubscription. Instances re-fetch when
     * `last_update_at` is null or older than this timestamp.
     */
    refreshRequestedAt: timestamptz('refresh_requested_at'),
    lastUpdateAt: timestamptz('last_update_at'),
    lastError: text('last_error'),
    nodeCount: integer('node_count'),

    trafficUpload: bigint('traffic_upload', { mode: 'number' }),
    trafficDownload: bigint('traffic_download', { mode: 'number' }),
    trafficTotal: bigint('traffic_total', { mode: 'number' }),
    trafficExpireAt: timestamptz('traffic_expire_at'),

    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('platform_network_proxy_subscriptions_enabled_sort_idx').on(t.enabled, t.sortOrder),
  ],
);

export type PlatformNetworkProxySubscriptionItem =
  typeof platformNetworkProxySubscriptions.$inferSelect;
export type NewPlatformNetworkProxySubscription =
  typeof platformNetworkProxySubscriptions.$inferInsert;

/**
 * Per-instance engine / artifact / counter status. PK is the heartbeat id;
 * rows cascade away when the instance reaper deletes a heartbeat.
 */
export const platformNetworkProxyInstanceStatus = pgTable(
  'platform_network_proxy_instance_status',
  {
    instanceId: text('instance_id')
      .primaryKey()
      .notNull()
      .references(() => platformInstanceHeartbeats.instanceId, { onDelete: 'cascade' }),

    engineState: text('engine_state').$type<NetworkProxyEngineState>().notNull(),
    engineVersion: text('engine_version'),
    platform: text('platform').notNull(),
    arch: text('arch').notNull(),
    artifactState: jsonb('artifact_state')
      .$type<ArtifactState[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    appliedRevision: integer('applied_revision'),
    appliedEngineGeneration: integer('applied_engine_generation'),
    activeNode: text('active_node'),
    aliveNodeCount: integer('alive_node_count'),
    proxiedCount: integer('proxied_count').notNull().default(0),
    fallbackCount: integer('fallback_count').notNull().default(0),
    lastIssue: jsonb('last_issue').$type<EngineIssue | null>(),
    healing: jsonb('healing').$type<InstanceHealing | null>(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
);

export type PlatformNetworkProxyInstanceStatusItem =
  typeof platformNetworkProxyInstanceStatus.$inferSelect;
export type NewPlatformNetworkProxyInstanceStatus =
  typeof platformNetworkProxyInstanceStatus.$inferInsert;
