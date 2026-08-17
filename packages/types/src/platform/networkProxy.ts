import { z } from 'zod';

import type {
  EgressScopeId,
  NetworkProxyArtifactKind,
  NetworkProxyArtifactSource,
  NetworkProxyDirectReason,
  NetworkProxyEngineIssueCode,
  NetworkProxyEngineLogLevel,
  NetworkProxyEngineState,
  NetworkProxyFeatureKey,
  NetworkProxyOnUnavailable,
  NetworkProxyOutletKind,
  NetworkProxyOutletMode,
  NetworkProxyRuleMode,
  NetworkProxyStaticProxyType,
  NetworkProxySubscriptionKind,
} from '@/const/platform/networkProxy';

// Value imports must be relative: packages/types vitest does not resolve `@/const/*`.
import {
  NETWORK_PROXY_ARTIFACT_KINDS,
  NETWORK_PROXY_ARTIFACT_SOURCES,
  NETWORK_PROXY_DEFAULTS,
  NETWORK_PROXY_DIRECT_REASONS,
  NETWORK_PROXY_ENGINE_ISSUE_CODES,
  NETWORK_PROXY_ENGINE_LOG_LEVELS,
  NETWORK_PROXY_ENGINE_STATES,
  NETWORK_PROXY_FEATURE_KEYS,
  NETWORK_PROXY_LIMITS,
  NETWORK_PROXY_ON_UNAVAILABLE,
  NETWORK_PROXY_OUTLET_KINDS,
  NETWORK_PROXY_OUTLET_MODES,
  NETWORK_PROXY_RULE_MODES,
  NETWORK_PROXY_STATIC_PROXY_TYPES,
  NETWORK_PROXY_SUBSCRIPTION_KINDS,
} from '../../../const/src/platform/networkProxy';

export type {
  EgressScopeId,
  NetworkProxyArtifactKind,
  NetworkProxyArtifactSource,
  NetworkProxyDirectReason,
  NetworkProxyEngineIssueCode,
  NetworkProxyEngineLogLevel,
  NetworkProxyEngineState,
  NetworkProxyFeatureKey,
  NetworkProxyOnUnavailable,
  NetworkProxyOutletKind,
  NetworkProxyOutletMode,
  NetworkProxyRuleMode,
  NetworkProxyStaticProxyType,
  NetworkProxySubscriptionKind,
};

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

export const networkProxyFeatureKeySchema = z.enum(NETWORK_PROXY_FEATURE_KEYS);
export const networkProxyOnUnavailableSchema = z.enum(NETWORK_PROXY_ON_UNAVAILABLE);
export const networkProxyOutletKindSchema = z.enum(NETWORK_PROXY_OUTLET_KINDS);
export const networkProxyOutletModeSchema = z.enum(NETWORK_PROXY_OUTLET_MODES);
export const networkProxyRuleModeSchema = z.enum(NETWORK_PROXY_RULE_MODES);
export const networkProxyStaticProxyTypeSchema = z.enum(NETWORK_PROXY_STATIC_PROXY_TYPES);
export const networkProxyEngineStateSchema = z.enum(NETWORK_PROXY_ENGINE_STATES);
export const networkProxyArtifactKindSchema = z.enum(NETWORK_PROXY_ARTIFACT_KINDS);
export const networkProxyArtifactSourceSchema = z.enum(NETWORK_PROXY_ARTIFACT_SOURCES);
export const networkProxySubscriptionKindSchema = z.enum(NETWORK_PROXY_SUBSCRIPTION_KINDS);
export const networkProxyEngineLogLevelSchema = z.enum(NETWORK_PROXY_ENGINE_LOG_LEVELS);
export const networkProxyDirectReasonSchema = z.enum(NETWORK_PROXY_DIRECT_REASONS);
export const networkProxyEngineIssueCodeSchema = z.enum(NETWORK_PROXY_ENGINE_ISSUE_CODES);

/** `provider:<id>` | `feature:<key>` */
export const egressScopeIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      /^provider:[\w.-]+$/.test(value) ||
      (value.startsWith('feature:') &&
        (NETWORK_PROXY_FEATURE_KEYS as readonly string[]).includes(value.slice(8))),
    'invalid egress scope id',
  ) as unknown as z.ZodType<EgressScopeId>;

// ---------------------------------------------------------------------------
// Persisted settings config (platform_network_proxy_settings.config)
// ---------------------------------------------------------------------------

export const egressScopeStateSchema = z
  .object({
    enabled: z.boolean(),
    onUnavailable: networkProxyOnUnavailableSchema,
  })
  .strict();
export type EgressScopeState = z.infer<typeof egressScopeStateSchema>;

const httpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), 'must be http(s)');

/** A bypass entry: hostname, `.suffix` / `*.suffix`, IPv4/IPv6 literal or CIDR. */
export const bypassHostEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(NETWORK_PROXY_LIMITS.BYPASS_HOST_MAX_CHARS)
  .regex(/^[\w*.:/-]+$/u, 'invalid bypass entry');

export const outletConfigSchema = z
  .object({
    kind: networkProxyOutletKindSchema,
    latencyIntervalSec: z
      .number()
      .int()
      .min(NETWORK_PROXY_LIMITS.LATENCY_INTERVAL_MIN_SEC)
      .max(NETWORK_PROXY_LIMITS.LATENCY_INTERVAL_MAX_SEC),
    latencyTestUrl: httpUrlSchema,
    manualNodeName: z.string().min(1).max(200).optional(),
    mode: networkProxyOutletModeSchema,
    toleranceMs: z.number().int().min(0).max(5000),
  })
  .strict();
export type OutletConfig = z.infer<typeof outletConfigSchema>;

/** Persisted shape — password stored as platform-secret ciphertext. */
export const staticProxyPersistedSchema = z
  .object({
    passwordCiphertext: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535),
    server: z.string().trim().min(1).max(253),
    type: networkProxyStaticProxyTypeSchema,
    username: z.string().max(200).optional(),
  })
  .strict();
export type StaticProxyPersisted = z.infer<typeof staticProxyPersistedSchema>;

/** Admin-facing view — never leaks the password. */
export const staticProxyViewSchema = z
  .object({
    hasPassword: z.boolean(),
    port: z.number().int(),
    server: z.string(),
    type: networkProxyStaticProxyTypeSchema,
    username: z.string().optional(),
  })
  .strict();
export type StaticProxyView = z.infer<typeof staticProxyViewSchema>;

/** Admin-facing update — explicit keep / replace / clear (design §5). */
export const staticProxyUpdateSchema = z
  .object({
    password: z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('keep') }).strict(),
        z.object({ action: z.literal('clear') }).strict(),
        z.object({ action: z.literal('replace'), value: z.string().min(1).max(500) }).strict(),
      ])
      .default({ action: 'keep' }),
    port: z.number().int().min(1).max(65_535),
    server: z.string().trim().min(1).max(253),
    type: networkProxyStaticProxyTypeSchema,
    username: z.string().max(200).optional(),
  })
  .strict();
export type StaticProxyUpdate = z.infer<typeof staticProxyUpdateSchema>;

const scopesSchema = z
  .object({
    /** key = feature key; every feature key must be present (createDefault fills them). */
    features: z
      .object(
        Object.fromEntries(
          NETWORK_PROXY_FEATURE_KEYS.map((key) => [key, egressScopeStateSchema]),
        ) as Record<NetworkProxyFeatureKey, typeof egressScopeStateSchema>,
      )
      .strict(),
    /** key = runtime provider id; absent = off. */
    providers: z.record(z.string().min(1).max(100), egressScopeStateSchema),
  })
  .strict();
export type EgressScopesConfig = z.infer<typeof scopesSchema>;

export const networkProxyConfigSchema = z
  .object({
    bypassHosts: z.array(bypassHostEntrySchema).max(NETWORK_PROXY_LIMITS.BYPASS_HOSTS_MAX),
    /** Auto-download of engine / geodata goes through `staticProxy` when true (design §3.2). */
    downloadViaStaticProxy: z.boolean(),
    engineLogLevel: networkProxyEngineLogLevelSchema,
    masterEnabled: z.boolean(),
    outlet: outletConfigSchema,
    ruleMode: networkProxyRuleModeSchema,
    scopes: scopesSchema,
    staticProxy: staticProxyPersistedSchema.optional(),
    /** Subscription refresh goes through the current outlet when true (default false). */
    subscriptionUpdateViaOutlet: z.boolean(),
  })
  .strict();
export type NetworkProxyConfig = z.infer<typeof networkProxyConfigSchema>;

export const createDefaultEgressScopeState = (): EgressScopeState => ({
  enabled: false,
  onUnavailable: 'direct',
});

export const createDefaultNetworkProxyConfig = (): NetworkProxyConfig => ({
  bypassHosts: [],
  downloadViaStaticProxy: false,
  engineLogLevel: NETWORK_PROXY_DEFAULTS.ENGINE_LOG_LEVEL,
  masterEnabled: false,
  outlet: {
    kind: NETWORK_PROXY_DEFAULTS.OUTLET_KIND,
    latencyIntervalSec: NETWORK_PROXY_DEFAULTS.LATENCY_INTERVAL_SEC,
    latencyTestUrl: NETWORK_PROXY_DEFAULTS.LATENCY_TEST_URL,
    mode: NETWORK_PROXY_DEFAULTS.OUTLET_MODE,
    toleranceMs: NETWORK_PROXY_DEFAULTS.TOLERANCE_MS,
  },
  ruleMode: NETWORK_PROXY_DEFAULTS.RULE_MODE,
  scopes: {
    features: Object.fromEntries(
      NETWORK_PROXY_FEATURE_KEYS.map((key) => [key, createDefaultEgressScopeState()]),
    ) as Record<NetworkProxyFeatureKey, EgressScopeState>,
    providers: {},
  },
  subscriptionUpdateViaOutlet: false,
});

/** Persisted JSON → validated config; unknown / missing keys fall back to defaults (forward-compatible reads). */
export const normalizeNetworkProxyConfig = (raw: unknown): NetworkProxyConfig => {
  const defaults = createDefaultNetworkProxyConfig();
  if (!raw || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const merged: NetworkProxyConfig = {
    ...defaults,
    ...(r as Partial<NetworkProxyConfig>),
    outlet: { ...defaults.outlet, ...(r.outlet as Partial<OutletConfig>) },
    scopes: {
      features: {
        ...defaults.scopes.features,
        ...(((r.scopes as EgressScopesConfig | undefined)?.features ?? {}) as Record<
          NetworkProxyFeatureKey,
          EgressScopeState
        >),
      },
      providers: (r.scopes as EgressScopesConfig | undefined)?.providers ?? {},
    },
  };
  return networkProxyConfigSchema.parse(merged);
};

// ---------------------------------------------------------------------------
// Admin-facing settings view / update
// ---------------------------------------------------------------------------

export const networkProxyConfigViewSchema = networkProxyConfigSchema
  .omit({ staticProxy: true })
  .extend({ staticProxy: staticProxyViewSchema.optional() })
  .strict();
export type NetworkProxyConfigView = z.infer<typeof networkProxyConfigViewSchema>;

/** Full-config update (scopes are edited through `updateScopes`, so they are not part of this). */
export const networkProxyConfigUpdateSchema = networkProxyConfigSchema
  .omit({ scopes: true, staticProxy: true })
  .extend({ staticProxy: staticProxyUpdateSchema.nullable() })
  .strict();
export type NetworkProxyConfigUpdate = z.infer<typeof networkProxyConfigUpdateSchema>;

/** Bulk scope update — every op is applied in order in one CAS write. */
export const egressScopeOpSchema = z.discriminatedUnion('target', [
  z
    .object({
      enabled: z.boolean().optional(),
      onUnavailable: networkProxyOnUnavailableSchema.optional(),
      scope: egressScopeIdSchema,
      target: z.literal('one'),
    })
    .strict(),
  z
    .object({
      enabled: z.boolean().optional(),
      onUnavailable: networkProxyOnUnavailableSchema.optional(),
      /** ids to write when enabling "all providers" (admin UI passes the visible provider list). */
      providerIds: z.array(z.string().min(1).max(100)).max(500),
      target: z.literal('all_providers'),
    })
    .strict(),
  z
    .object({
      enabled: z.boolean().optional(),
      onUnavailable: networkProxyOnUnavailableSchema.optional(),
      target: z.literal('all_features'),
    })
    .strict(),
]);
export type EgressScopeOp = z.infer<typeof egressScopeOpSchema>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const subscriptionTrafficSchema = z
  .object({
    download: z.number().nonnegative().nullable(),
    expireAt: z.string().datetime().nullable(),
    total: z.number().nonnegative().nullable(),
    upload: z.number().nonnegative().nullable(),
  })
  .strict();
export type SubscriptionTraffic = z.infer<typeof subscriptionTrafficSchema>;

const subscriptionCommonSchema = z.object({
  enabled: z.boolean(),
  excludeFilter: z.string().max(500).optional(),
  filter: z.string().max(500).optional(),
  name: z.string().trim().min(1).max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_NAME_MAX_CHARS),
  sortOrder: z.number().int().min(0).max(10_000),
});

export const subscriptionViewSchema = subscriptionCommonSchema
  .extend({
    createdAt: z.string().datetime(),
    id: z.string(),
    kind: networkProxySubscriptionKindSchema,
    lastError: z.string().nullable(),
    lastUpdateAt: z.string().datetime().nullable(),
    nodeCount: z.number().int().nonnegative().nullable(),
    traffic: subscriptionTrafficSchema.nullable(),
    updateIntervalSec: z.number().int().nullable(),
    updatedAt: z.string().datetime(),
    /** hostname only — the full URL (may carry a token) is never returned. */
    urlHost: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .strict();
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

export const subscriptionCreateSchema = z.discriminatedUnion('kind', [
  subscriptionCommonSchema
    .extend({
      kind: z.literal('url'),
      updateIntervalSec: z
        .number()
        .int()
        .min(NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MIN_SEC)
        .max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MAX_SEC)
        .default(NETWORK_PROXY_DEFAULTS.SUBSCRIPTION_UPDATE_INTERVAL_SEC),
      url: httpUrlSchema.pipe(z.string().max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_URL_MAX_CHARS)),
      userAgent: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  subscriptionCommonSchema
    .extend({
      kind: z.literal('manual'),
      /** Share links (one per line) or Clash YAML `proxies:` snippet — mihomo parses both. */
      payload: z.string().min(1).max(NETWORK_PROXY_LIMITS.MANUAL_PAYLOAD_MAX_CHARS),
    })
    .strict(),
]);
export type SubscriptionCreate = z.infer<typeof subscriptionCreateSchema>;

/** Partial update; `url` / `payload` omitted = keep. */
export const subscriptionUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    excludeFilter: z.string().max(500).nullable().optional(),
    filter: z.string().max(500).nullable().optional(),
    id: z.string().min(1),
    name: z.string().trim().min(1).max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_NAME_MAX_CHARS).optional(),
    payload: z.string().min(1).max(NETWORK_PROXY_LIMITS.MANUAL_PAYLOAD_MAX_CHARS).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    updateIntervalSec: z
      .number()
      .int()
      .min(NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MIN_SEC)
      .max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MAX_SEC)
      .optional(),
    url: httpUrlSchema
      .pipe(z.string().max(NETWORK_PROXY_LIMITS.SUBSCRIPTION_URL_MAX_CHARS))
      .optional(),
    userAgent: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
export type SubscriptionUpdate = z.infer<typeof subscriptionUpdateSchema>;

// ---------------------------------------------------------------------------
// Runtime status DTOs (engine / outlet / instances / nodes)
// ---------------------------------------------------------------------------

export const artifactStateSchema = z
  .object({
    installed: z.boolean(),
    kind: networkProxyArtifactKindSchema,
    /**
     * false when the installed file's digest differs from the pinned manifest digest and an
     * administrator accepted it at upload time. Absent on rows written before this field existed
     * and on uninstalled kinds.
     */
    pinnedDigestMatch: z.boolean().optional(),
    source: networkProxyArtifactSourceSchema.nullable(),
    version: z.string().nullable(),
  })
  .strict();
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const engineIssueSchema = z
  .object({
    at: z.string().datetime(),
    code: networkProxyEngineIssueCodeSchema,
    /** already redacted, ≤200 chars — UI shows it only behind a technical-detail toggle */
    detail: z.string().max(200).nullable(),
  })
  .strict();
export type EngineIssue = z.infer<typeof engineIssueSchema>;

export const instanceHealingSchema = z
  .object({
    attempt: z.number().int().positive(),
    nextAttemptAt: z.string().datetime(),
  })
  .strict();
export type InstanceHealing = z.infer<typeof instanceHealingSchema>;

export const instanceStatusViewSchema = z
  .object({
    activeNode: z.string().nullable(),
    aliveNodeCount: z.number().int().nonnegative().nullable(),
    appliedRevision: z.number().int().nonnegative().nullable(),
    arch: z.string(),
    artifacts: z.array(artifactStateSchema),
    engineState: networkProxyEngineStateSchema,
    engineVersion: z.string().nullable(),
    fallbackCount: z.number().int().nonnegative(),
    /** non-null only while the supervisor is in automatic recovery (`error` + scheduled retry) */
    healing: instanceHealingSchema.nullable(),
    instanceId: z.string(),
    /** true when this row is the instance answering the current request. */
    isCurrent: z.boolean(),
    lastHeartbeatAt: z.string().datetime(),
    lastIssue: engineIssueSchema.nullable(),
    platform: z.string(),
    proxiedCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type InstanceStatusView = z.infer<typeof instanceStatusViewSchema>;

export const outletStatusViewSchema = z
  .object({
    activeNode: z.string().nullable(),
    activeNodeDelayMs: z.number().int().nullable(),
    available: z.boolean(),
    circuitOpen: z.boolean(),
    kind: networkProxyOutletKindSchema,
    unavailableReason: z.string().nullable(),
  })
  .strict();
export type OutletStatusView = z.infer<typeof outletStatusViewSchema>;

export const networkProxyStatusViewSchema = z
  .object({
    /** scopes currently falling back to direct on this instance */
    fallbackScopes: z.array(egressScopeIdSchema),
    /** `PROXY_URL` (legacy proxychains) is set → module refuses to enable */
    globalProxyActive: z.boolean(),
    instances: z.array(instanceStatusViewSchema),
    outlet: outletStatusViewSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NetworkProxyStatusView = z.infer<typeof networkProxyStatusViewSchema>;

export const proxyNodeViewSchema = z
  .object({
    alive: z.boolean(),
    delayMs: z.number().int().nullable(),
    name: z.string(),
    /** subscription id (`sub_<id>` provider) or null for unknown */
    subscriptionId: z.string().nullable(),
    type: z.string(),
  })
  .strict();
export type ProxyNodeView = z.infer<typeof proxyNodeViewSchema>;

export const artifactStatusViewSchema = z
  .object({
    engine: z
      .object({
        binSha256: z.string().nullable(),
        expectedAsset: z.string().nullable(),
        platformKey: z.string().nullable(),
        supported: z.boolean(),
        version: z.string(),
      })
      .strict(),
    geodata: z.object({ commit: z.string(), files: z.array(z.string()) }).strict(),
    instances: z.array(
      z
        .object({
          artifacts: z.array(artifactStateSchema),
          instanceId: z.string(),
          isCurrent: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type ArtifactStatusView = z.infer<typeof artifactStatusViewSchema>;

// ---------------------------------------------------------------------------
// Desired-state broadcast (settings row column `desired_artifacts`, design §3.3 / B0_INTERFACE §1)
// ---------------------------------------------------------------------------

const desiredEngineSchema = z
  .object({ requestedAt: z.string().datetime(), version: z.string().min(1) })
  .strict();
const desiredGeodataSchema = z
  .object({ commit: z.string().min(1), requestedAt: z.string().datetime() })
  .strict();

export const desiredArtifactsSchema = z
  .object({
    engine: desiredEngineSchema.optional(),
    geoip: desiredGeodataSchema.optional(),
    geosite: desiredGeodataSchema.optional(),
  })
  .strict();
export type DesiredArtifacts = z.infer<typeof desiredArtifactsSchema>;
