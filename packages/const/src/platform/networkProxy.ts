/**
 * 网络代理 (network proxy) — shared vocabulary between the server runtime (egress router,
 * engine supervisor), the admin panel and the persisted settings JSON.
 * Design: docs/enterprise/network-proxy.md.
 *
 * Keys are stable identifiers (persisted in DB rows / settings JSON); display names live in
 * i18n (`admin:networkProxy.*`).
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** Site features that get their own on/off switch (design §2). Provider scopes are keyed by provider id. */
export const NETWORK_PROXY_FEATURE_KEYS = [
  'market',
  'web_search',
  'mcp',
  'import_fetch',
  'content_moderation',
] as const;
export type NetworkProxyFeatureKey = (typeof NETWORK_PROXY_FEATURE_KEYS)[number];

export const NETWORK_PROXY_SCOPE_KINDS = ['provider', 'feature'] as const;
export type NetworkProxyScopeKind = (typeof NETWORK_PROXY_SCOPE_KINDS)[number];

/** `provider:<providerId>` | `feature:<featureKey>` */
export type EgressScopeId = `provider:${string}` | `feature:${NetworkProxyFeatureKey}`;

export const providerEgressScope = (providerId: string): EgressScopeId => `provider:${providerId}`;
export const featureEgressScope = (key: NetworkProxyFeatureKey): EgressScopeId => `feature:${key}`;

export const parseEgressScopeId = (
  scope: string,
): { kind: 'provider'; id: string } | { kind: 'feature'; id: NetworkProxyFeatureKey } | null => {
  if (scope.startsWith('provider:')) {
    const id = scope.slice('provider:'.length);
    return id ? { id, kind: 'provider' } : null;
  }
  if (scope.startsWith('feature:')) {
    const id = scope.slice('feature:'.length) as NetworkProxyFeatureKey;
    return (NETWORK_PROXY_FEATURE_KEYS as readonly string[]).includes(id)
      ? { id, kind: 'feature' }
      : null;
  }
  return null;
};

/** What to do with a scope's request when the outlet is unavailable. */
export const NETWORK_PROXY_ON_UNAVAILABLE = ['direct', 'fail'] as const;
export type NetworkProxyOnUnavailable = (typeof NETWORK_PROXY_ON_UNAVAILABLE)[number];

// ---------------------------------------------------------------------------
// Outlet / engine / subscription enums
// ---------------------------------------------------------------------------

export const NETWORK_PROXY_OUTLET_KINDS = ['engine', 'static'] as const;
export type NetworkProxyOutletKind = (typeof NETWORK_PROXY_OUTLET_KINDS)[number];

/** url-test / select / fallback (mihomo group types). */
export const NETWORK_PROXY_OUTLET_MODES = ['auto', 'manual', 'fallback'] as const;
export type NetworkProxyOutletMode = (typeof NETWORK_PROXY_OUTLET_MODES)[number];

export const NETWORK_PROXY_RULE_MODES = ['simple', 'smart'] as const;
export type NetworkProxyRuleMode = (typeof NETWORK_PROXY_RULE_MODES)[number];

export const NETWORK_PROXY_STATIC_PROXY_TYPES = ['http', 'https', 'socks5'] as const;
export type NetworkProxyStaticProxyType = (typeof NETWORK_PROXY_STATIC_PROXY_TYPES)[number];

export const NETWORK_PROXY_ENGINE_STATES = [
  'unsupported',
  'not_installed',
  'installing',
  'stopped',
  'starting',
  'running',
  'degraded',
  'error',
] as const;
export type NetworkProxyEngineState = (typeof NETWORK_PROXY_ENGINE_STATES)[number];

export const NETWORK_PROXY_ARTIFACT_KINDS = ['engine', 'geoip', 'geosite'] as const;
export type NetworkProxyArtifactKind = (typeof NETWORK_PROXY_ARTIFACT_KINDS)[number];

/** `operator_override` = `NETWORK_PROXY_ENGINE_BIN` pointed at an unverified binary. */
export const NETWORK_PROXY_ARTIFACT_SOURCES = ['download', 'upload', 'operator_override'] as const;
export type NetworkProxyArtifactSource = (typeof NETWORK_PROXY_ARTIFACT_SOURCES)[number];

export const NETWORK_PROXY_SUBSCRIPTION_KINDS = ['url', 'manual'] as const;
export type NetworkProxySubscriptionKind = (typeof NETWORK_PROXY_SUBSCRIPTION_KINDS)[number];

export const NETWORK_PROXY_ENGINE_LOG_LEVELS = ['silent', 'error', 'warning', 'info'] as const;
export type NetworkProxyEngineLogLevel = (typeof NETWORK_PROXY_ENGINE_LOG_LEVELS)[number];

/** Why a request went direct (design §2 `EgressDecision`). */
export const NETWORK_PROXY_DIRECT_REASONS = [
  'master_off',
  'global_proxy_active',
  'scope_off',
  'bypass',
  'fallback',
] as const;
export type NetworkProxyDirectReason = (typeof NETWORK_PROXY_DIRECT_REASONS)[number];

// ---------------------------------------------------------------------------
// Defaults / limits / names
// ---------------------------------------------------------------------------

/** Name of the single mihomo proxy group all scoped traffic exits through. */
export const NETWORK_PROXY_ENGINE_GROUP_NAME = 'AIHUB-OUT';

/** `PlatformConfigInvalidationEvent.scopes` entry used to fan out settings / engine commands. */
export const NETWORK_PROXY_INVALIDATION_SCOPE = 'network_proxy';

/** Basic-auth username the engine's mixed listener is started with (password random per boot). */
export const NETWORK_PROXY_ENGINE_LISTENER_USER = 'aihub';

export const NETWORK_PROXY_DEFAULTS = {
  ENGINE_LOG_LEVEL: 'warning' as NetworkProxyEngineLogLevel,
  LATENCY_INTERVAL_SEC: 300,
  LATENCY_TEST_URL: 'https://www.gstatic.com/generate_204',
  OUTLET_KIND: 'engine' as NetworkProxyOutletKind,
  OUTLET_MODE: 'auto' as NetworkProxyOutletMode,
  RULE_MODE: 'simple' as NetworkProxyRuleMode,
  SUBSCRIPTION_UPDATE_INTERVAL_SEC: 86_400,
  SUBSCRIPTION_USER_AGENT: 'clash.meta',
  TOLERANCE_MS: 150,
} as const;

export const NETWORK_PROXY_LIMITS = {
  BYPASS_HOSTS_MAX: 200,
  BYPASS_HOST_MAX_CHARS: 253,
  /** Outlet circuit breaker: N connect-phase failures within WINDOW open the breaker for OPEN_MS. */
  CIRCUIT_FAILURE_THRESHOLD: 3,
  CIRCUIT_OPEN_MS: 30_000,
  CIRCUIT_WINDOW_MS: 60_000,
  ENGINE_CRASH_LIMIT: 5,
  ENGINE_CRASH_WINDOW_MS: 10 * 60_000,
  ENGINE_HEALTH_FAILURES_BEFORE_RESTART: 3,
  ENGINE_HEALTH_INTERVAL_MS: 15_000,
  ENGINE_LOG_LINES: 200,
  ENGINE_RESTART_BACKOFF_MAX_MS: 30_000,
  /** Instances whose heartbeat is older than this are hidden from status / counts. */
  INSTANCE_FRESH_MS: 90_000,
  LATENCY_INTERVAL_MAX_SEC: 3600,
  LATENCY_INTERVAL_MIN_SEC: 30,
  LATENCY_TEST_TIMEOUT_MS: 5000,
  MANUAL_PAYLOAD_MAX_CHARS: 512 * 1024,
  SETTINGS_SNAPSHOT_TTL_MS: 60_000,
  SUBSCRIPTIONS_MAX: 50,
  SUBSCRIPTION_FETCH_TIMEOUT_MS: 10_000,
  SUBSCRIPTION_MAX_BYTES: 8 * 1024 * 1024,
  SUBSCRIPTION_MAX_REDIRECTS: 3,
  SUBSCRIPTION_NAME_MAX_CHARS: 80,
  SUBSCRIPTION_UPDATE_INTERVAL_MAX_SEC: 30 * 86_400,
  SUBSCRIPTION_UPDATE_INTERVAL_MIN_SEC: 600,
  SUBSCRIPTION_URL_MAX_CHARS: 2048,
  /** Uploaded / downloaded compressed artifact hard cap (design §3.2). */
  UPLOAD_MAX_COMPRESSED_BYTES: 64 * 1024 * 1024,
} as const;

/** Environment variables (design §3.2 / §3.5). All prefixed NETWORK_PROXY_ — never `PROXY_URL`. */
export const NETWORK_PROXY_ENV = {
  /** Explicit path to an operator-provided engine binary (skips install + digest check). */
  ENGINE_BIN: 'NETWORK_PROXY_ENGINE_BIN',
  /** Mirror prefix replacing the manifest baseUrl (e.g. `https://ghfast.top/https://github.com/...`). */
  ENGINE_DOWNLOAD_BASE: 'NETWORK_PROXY_ENGINE_DOWNLOAD_BASE',
  /** Force the supervisor on outside the persistent worker runtime (dev / tests). */
  ENGINE_AUTOSTART: 'NETWORK_PROXY_ENGINE_AUTOSTART',
  /** Data dir root: `<dir>/engine`, `<dir>/geodata`, `<dir>/runtime`. */
  DATA_DIR: 'NETWORK_PROXY_DATA_DIR',
  /** Set by the legacy proxychains launcher; when non-empty the module refuses to enable. */
  LEGACY_GLOBAL_PROXY: 'PROXY_URL',
} as const;

export const NETWORK_PROXY_DEFAULT_DATA_DIR_DOCKER = '/app/.lobe/network-proxy';
export const NETWORK_PROXY_DEFAULT_DATA_DIR_DEV = '.cache/network-proxy';

// ---------------------------------------------------------------------------
// Pinned engine / geodata manifest (design §3.2). ONE version; digests computed by the lead
// from the exact release assets on 2026-08-17. `binSha256` is the digest of the DECOMPRESSED
// binary and is what gets re-verified before every spawn; `binSize` is the decompression cap.
// ---------------------------------------------------------------------------

/** `${process.platform}:${process.arch}` */
export const NETWORK_PROXY_ENGINE_PLATFORM_KEYS = [
  'linux:x64',
  'linux:arm64',
  'darwin:arm64',
] as const;
export type NetworkProxyEnginePlatformKey = (typeof NETWORK_PROXY_ENGINE_PLATFORM_KEYS)[number];

export interface NetworkProxyEngineAsset {
  asset: string;
  binSha256: string;
  binSize: number;
  gzSha256: string;
}

export interface NetworkProxyGeodataFile {
  file: string;
  sha256: string;
  size: number;
}

export const NETWORK_PROXY_ENGINE_MANIFEST = {
  assets: {
    'darwin:arm64': {
      asset: 'mihomo-darwin-arm64-v1.19.30.gz',
      binSha256: 'e80c6334b4e3aae53dfbc86cddd4434cec1565a61d4483931fac2ae12fec6d30',
      binSize: 45_643_538,
      gzSha256: '2c7f3a7904fa1cee291e124123e630e7b1ebd13765dd9bf26c0a28432004d9f4',
    },
    'linux:arm64': {
      asset: 'mihomo-linux-arm64-v1.19.30.gz',
      binSha256: 'b9456718a8955364b9a77c80f74dca49ded10f071c1c6b4513a0ea68a3d87a50',
      binSize: 46_596_222,
      gzSha256: '58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069',
    },
    // GOAMD64=v1 build ("compatible"): runs on every x86-64 CPU incl. ones without AVX2.
    'linux:x64': {
      asset: 'mihomo-linux-amd64-compatible-v1.19.30.gz',
      binSha256: '8ad44e28fe72be4640254b96741b677f4074991b99186cc4486a1c28ded02b1a',
      binSize: 50_999_422,
      gzSha256: 'db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9',
    },
  } satisfies Record<NetworkProxyEnginePlatformKey, NetworkProxyEngineAsset>,
  /** `${baseUrl}/${version}/${asset}` */
  baseUrl: 'https://github.com/MetaCubeX/mihomo/releases/download',
  binaryName: 'mihomo',
  cnMirrorBaseUrl: 'https://ghfast.top/https://github.com/MetaCubeX/mihomo/releases/download',
  /**
   * geodata: meta-rules-dat only publishes a rolling `latest` release, so we pin the `release`
   * branch commit instead. `${baseUrl}/${commit}/${file}`.
   */
  geodata: {
    baseUrl: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat',
    cnMirrorBaseUrl:
      'https://ghfast.top/https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat',
    commit: '666c0d1bc6ddd9c8eaa424404edb45e90b55f02d',
    files: {
      geoip: {
        file: 'geoip.metadb',
        sha256: '7c5526e2318838435c9507a3c4e44e6bc4919039a5d94b74943e92cce494431f',
        size: 8_632_071,
      },
      geosite: {
        file: 'geosite.dat',
        sha256: '5f963ff8baeff373b4ae77cdd03c0344138af84b6a763654bc0989fd283662bb',
        size: 4_247_589,
      },
    } satisfies Record<'geoip' | 'geosite', NetworkProxyGeodataFile>,
  },
  version: 'v1.19.30',
} as const;

export const resolveEnginePlatformKey = (
  platform: string,
  arch: string,
): NetworkProxyEnginePlatformKey | null => {
  const key = `${platform}:${arch}`;
  return (NETWORK_PROXY_ENGINE_PLATFORM_KEYS as readonly string[]).includes(key)
    ? (key as NetworkProxyEnginePlatformKey)
    : null;
};
