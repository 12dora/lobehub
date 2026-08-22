/**
 * Platform modules — the deployment-level on/off switches of LobeHub Enhanced.
 *
 * A *module* is a coarse feature area that an operator may leave out of a deployment to
 * save memory / CPU / external dependencies (design: docs/enterprise/modules.md).
 * This file is the single contract shared by:
 *   - env parsing (`LOBE_MODULE_PRESET`, `LOBE_MODULES_DISABLED`) and the DB row
 *     (`platform_module_settings`, id='global');
 *   - the server gates (worker bootstrap registry, tRPC module guard / lazy routers,
 *     webapi gate, feature-flag derivation);
 *   - the client (`__SERVER_CONFIG__.enterprise.modules`, `platform.getCapabilities`,
 *     admin nav filtering, the `/admin/system/modules` page).
 *
 * Semantics (fixed 2026-08-17):
 *   - Every module defaults **ON**. An unconfigured deployment behaves exactly like before.
 *   - env can only *disable* (`effective = envDisabled ? false : (db ?? true)`); a module
 *     disabled by env shows as "controlled by environment" in the admin page.
 *   - A missing DB row means "everything enabled" — never fail closed.
 *   - Routers are always mounted; a disabled module answers `PLATFORM_MODULE_DISABLED`
 *     (FORBIDDEN), never NOT_FOUND.
 *   - `kind: 'restart'` modules own boot-time facilities (workers / subprocess / gateway /
 *     eager import graph); toggling them takes effect for the API immediately but only
 *     releases resources after a process restart. `kind: 'hot'` modules take effect on the
 *     next page load.
 *
 * Display names / descriptions live in i18n (`admin:modules.items.<id>.*`).
 */
import type { EnterpriseFeatureFlagKey } from './featureFlags';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const PLATFORM_MODULE_IDS = [
  // upstream feature areas
  'knowledgeBase',
  'imageGen',
  'speech',
  'webSearch',
  'market',
  'memory',
  'bots',
  'agentSignal',
  'workflows',
  'sandbox',
  'documentRender',
  'deviceGateway',
  // enterprise (fork) feature areas
  'managedAi',
  'managedSkills',
  'managedConnectors',
  'managedAgents',
  'settingsPolicy',
  'branding',
  'databaseIdp',
  'audit',
  'moderation',
  'networkProxy',
  'platformStats',
  'taskTemplates',
] as const;

export type PlatformModuleId = (typeof PLATFORM_MODULE_IDS)[number];

export const isPlatformModuleId = (value: unknown): value is PlatformModuleId =>
  typeof value === 'string' && (PLATFORM_MODULE_IDS as readonly string[]).includes(value);

/** Presets. `full` = everything on (the default and today's behaviour). */
export const PLATFORM_MODULE_PRESETS = ['minimal', 'standard', 'full'] as const;
export type PlatformModulePreset = (typeof PLATFORM_MODULE_PRESETS)[number];
export const DEFAULT_PLATFORM_MODULE_PRESET: PlatformModulePreset = 'full';

export const isPlatformModulePreset = (value: unknown): value is PlatformModulePreset =>
  typeof value === 'string' && (PLATFORM_MODULE_PRESETS as readonly string[]).includes(value);

/** Env keys (container parameters). */
export const PLATFORM_MODULE_PRESET_ENV = 'LOBE_MODULE_PRESET';
export const PLATFORM_MODULES_DISABLED_ENV = 'LOBE_MODULES_DISABLED';

/** `PlatformConfigInvalidationEvent.scopes` entry used to fan out the hot snapshot. */
export const MODULE_SETTINGS_INVALIDATION_SCOPE = 'modules';

/** DomainConfigCache TTL for the hot (request-time) module snapshot. */
export const MODULE_SETTINGS_SNAPSHOT_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export type PlatformModuleOrigin = 'upstream' | 'fork';
/** hot = API/UI effect on next page load; restart = also owns boot-time facilities. */
export type PlatformModuleKind = 'hot' | 'restart';
export type PlatformModuleExternalDep = 's3' | 'redis' | 'searxng' | 'externalService';
/** What the module costs while the system is *busy* (shown in the admin page). */
export type PlatformModuleLoadKind =
  | 'none' // no per-request work
  | 'onUse' // only when the feature itself is used (e.g. parsing an uploaded file)
  | 'perRequest' // adds work to every HTTP / tRPC request
  | 'perMessage' // adds work to every chat message / LLM step
  | 'perFetch'; // adds work to every outbound fetch

export interface PlatformModuleCost {
  /** Number of background workers / pollers the module owns (idle CPU + DB traffic). */
  backgroundJobs: number;
  externalDeps: PlatformModuleExternalDep[];
  /**
   * Resident memory the module adds to the server process at rest (MB, measured on the
   * reference build 2026-08-17 with all routers lazy + preloadEntriesOnStart:false, so most
   * request-time modules correctly cost ≈0 until used; null = not measured). Subprocess memory
   * (e.g. mihomo ≈43 MB once installed) is NOT included — see `subprocess`.
   */
  idleRssMb: number | null;
  loadKind: PlatformModuleLoadKind;
  /** May add an extra model round-trip or heavy CPU per message when configured (flag red in UI). */
  loadSensitive: boolean;
  /** Owns an OS subprocess (e.g. mihomo). */
  subprocess: boolean;
}

export interface PlatformModuleDefinition {
  /** Keys under `admin.*` whose procedures are guarded by this module (fork routers). */
  adminRouterKeys: readonly string[];
  /** Keys on the async root router gated by this module. */
  asyncRouterKeys: readonly string[];
  cost: PlatformModuleCost;
  /** Modules that must be enabled for this one to make sense (soft dependency, UI hint). */
  dependsOn: readonly PlatformModuleId[];
  /**
   * Existing enterprise flag that also disables this module when explicitly turned off
   * (backwards compatibility: `ENABLE_PLATFORM_MANAGED_AGENTS=0` ⇒ managedAgents off).
   */
  enterpriseFlag?: EnterpriseFeatureFlagKey;
  /**
   * Upstream `FEATURE_FLAGS` keys forced to `false` when the module is disabled, so the
   * ~54 existing client consumers hide the UI without any new client code.
   */
  featureFlagKeys: readonly string[];
  id: PlatformModuleId;
  kind: PlatformModuleKind;
  /** Keys on the lambda root router gated by this module (upstream routers → lazy/stub). */
  lambdaRouterKeys: readonly string[];
  origin: PlatformModuleOrigin;
  /** Lowest preset in which the module is ON. */
  tier: PlatformModulePreset;
  /** Keys on the tools root router gated by this module. */
  toolsRouterKeys: readonly string[];
  /** Background worker names (must match `WorkerSpec.name` in the workers bootstrap registry). */
  workers: readonly string[];
}

const def = (d: PlatformModuleDefinition): PlatformModuleDefinition => Object.freeze(d);

/**
 * NOTE for implementers: ids, tiers, kinds and cost shape are the contract and must not
 * change without the commander. Router-key lists are the *initial* mapping from the
 * exploration reports — verify against the real routers and adjust in place.
 */
export const PLATFORM_MODULES: Readonly<Record<PlatformModuleId, PlatformModuleDefinition>> = {
  agentSignal: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['redis'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'agentSignal',
    kind: 'restart',
    lambdaRouterKeys: ['agentSignal'],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  audit: def({
    adminRouterKeys: ['audit'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 2,
      externalDeps: ['s3'],
      idleRssMb: 0,
      loadKind: 'perRequest',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_ADMIN',
    featureFlagKeys: [],
    id: 'audit',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: ['auditExport', 'auditRetention'],
  }),
  bots: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 1,
      externalDeps: [],
      idleRssMb: 22,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'bots',
    kind: 'restart',
    lambdaRouterKeys: ['agentBotProvider', 'botMessage', 'messenger'],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: ['gatewayService'],
  }),
  branding: def({
    adminRouterKeys: ['branding'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 1,
      externalDeps: ['s3'],
      idleRssMb: 6,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_RUNTIME_BRANDING',
    featureFlagKeys: [],
    id: 'branding',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: ['brandingAssetCleanup'],
  }),
  databaseIdp: def({
    adminRouterKeys: ['identityProviders'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 2,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_DATABASE_OIDC',
    featureFlagKeys: [],
    id: 'databaseIdp',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: ['identityProviderTestAttemptCleanup', 'platformInstanceRegistryCleanup'],
  }),
  deviceGateway: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['externalService'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'deviceGateway',
    kind: 'hot',
    // `lambda.device` is the shared desktop/workspace enrollment router (core).
    // Remote-gateway calls are mixed with local enrollment (register / update /
    // remove / mintWorkspaceConnectToken / …) — not a small identifiable subset
    // to hang `withModule('deviceGateway')` on. Gating is UI + tool-runtime
    // (G3b) only. Do NOT add `device` here.
    lambdaRouterKeys: [],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  documentRender: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 1,
      externalDeps: ['externalService'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'documentRender',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'full',
    toolsRouterKeys: [],
    workers: ['documentRender', 'documentRenderGc'],
  }),
  imageGen: def({
    adminRouterKeys: [],
    asyncRouterKeys: ['image', 'video'],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['s3'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: ['ai_image'],
    id: 'imageGen',
    kind: 'hot',
    lambdaRouterKeys: [
      'image',
      'generation',
      'generationBatch',
      'generationTopic',
      'video',
      'comfyui',
    ],
    origin: 'upstream',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: [],
  }),
  knowledgeBase: def({
    adminRouterKeys: [],
    asyncRouterKeys: ['ragEval'],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['s3'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: ['knowledge_base', 'rag_eval'],
    id: 'knowledgeBase',
    kind: 'hot',
    lambdaRouterKeys: ['knowledgeBase', 'chunk', 'ragEval'],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  managedAgents: def({
    adminRouterKeys: ['agents'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 1,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_MANAGED_AGENTS',
    featureFlagKeys: [],
    id: 'managedAgents',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: ['agentRollout'],
  }),
  managedAi: def({
    adminRouterKeys: ['aiProviders', 'aiModels', 'aiProviderOAuth', 'managedResources'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 6,
      loadKind: 'perMessage',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_MANAGED_AI',
    featureFlagKeys: [],
    id: 'managedAi',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: [],
  }),
  managedConnectors: def({
    adminRouterKeys: ['connectors', 'creds'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 3,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_MANAGED_CONNECTORS',
    featureFlagKeys: [],
    id: 'managedConnectors',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: ['connectorRuntimeAudit', 'connectorSecretCleanup', 'sharedOAuthKeepalive'],
  }),
  managedSkills: def({
    adminRouterKeys: ['skills'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_MANAGED_SKILLS',
    featureFlagKeys: [],
    id: 'managedSkills',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: [],
  }),
  market: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: ['market'],
    id: 'market',
    kind: 'hot',
    lambdaRouterKeys: ['market'],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: ['market'],
    workers: [],
  }),
  memory: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'perMessage',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'memory',
    kind: 'hot',
    lambdaRouterKeys: ['userMemories', 'userMemory'],
    origin: 'upstream',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: [],
  }),
  moderation: def({
    adminRouterKeys: ['contentModeration'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['redis'],
      idleRssMb: 0,
      loadKind: 'perMessage',
      loadSensitive: true,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'moderation',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: [],
  }),
  networkProxy: def({
    adminRouterKeys: ['networkProxy'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 3,
      externalDeps: [],
      idleRssMb: 8,
      loadKind: 'perFetch',
      loadSensitive: false,
      subprocess: true,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'networkProxy',
    kind: 'restart',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'standard',
    toolsRouterKeys: [],
    workers: ['networkProxyEngineSupervisor'],
  }),
  platformStats: def({
    adminRouterKeys: ['stats'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_ADMIN',
    featureFlagKeys: [],
    id: 'platformStats',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: [],
  }),
  sandbox: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['externalService'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'sandbox',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  settingsPolicy: def({
    adminRouterKeys: ['settings'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'perRequest',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    enterpriseFlag: 'ENABLE_PLATFORM_SETTINGS_POLICY',
    featureFlagKeys: [],
    id: 'settingsPolicy',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'fork',
    tier: 'minimal',
    toolsRouterKeys: [],
    workers: [],
  }),
  speech: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: ['speech_to_text'],
    id: 'speech',
    kind: 'hot',
    lambdaRouterKeys: ['asr'],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  taskTemplates: def({
    adminRouterKeys: ['taskTemplates', 'agentTemplates'],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      loadKind: 'none',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'taskTemplates',
    kind: 'hot',
    lambdaRouterKeys: ['taskTemplate'],
    origin: 'fork',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
  webSearch: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['searxng'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'webSearch',
    kind: 'hot',
    // `search` on the lambda root is the command-palette aggregator (agents /
    // files / topics / marketplace), not web search. Web search lives on the
    // tools root (`toolsRouterKeys: ['search']`) plus `webBrowsing` below.
    lambdaRouterKeys: ['webBrowsing'],
    origin: 'upstream',
    tier: 'standard',
    toolsRouterKeys: ['search'],
    workers: [],
  }),
  workflows: def({
    adminRouterKeys: [],
    asyncRouterKeys: [],
    cost: {
      backgroundJobs: 0,
      externalDeps: ['externalService'],
      idleRssMb: 0,
      loadKind: 'onUse',
      loadSensitive: false,
      subprocess: false,
    },
    dependsOn: [],
    featureFlagKeys: [],
    id: 'workflows',
    kind: 'hot',
    lambdaRouterKeys: [],
    origin: 'upstream',
    tier: 'full',
    toolsRouterKeys: [],
    workers: [],
  }),
};

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

const TIER_RANK: Record<PlatformModulePreset, number> = { full: 2, minimal: 0, standard: 1 };

/** Modules that are ON in the given preset. */
export const modulesForPreset = (preset: PlatformModulePreset): ReadonlySet<PlatformModuleId> =>
  new Set(
    PLATFORM_MODULE_IDS.filter((id) => TIER_RANK[PLATFORM_MODULES[id].tier] <= TIER_RANK[preset]),
  );

/** `admin.<key>` → module (only keys owned by an optional module appear here). */
export const MODULE_BY_ADMIN_ROUTER_KEY: Readonly<Record<string, PlatformModuleId>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].adminRouterKeys.map((k) => [k, id])),
  ),
);

export const MODULE_BY_LAMBDA_ROUTER_KEY: Readonly<Record<string, PlatformModuleId>> =
  Object.freeze(
    Object.fromEntries(
      PLATFORM_MODULE_IDS.flatMap((id) =>
        PLATFORM_MODULES[id].lambdaRouterKeys.map((k) => [k, id]),
      ),
    ),
  );

export const MODULE_BY_ASYNC_ROUTER_KEY: Readonly<Record<string, PlatformModuleId>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].asyncRouterKeys.map((k) => [k, id])),
  ),
);

export const MODULE_BY_TOOLS_ROUTER_KEY: Readonly<Record<string, PlatformModuleId>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].toolsRouterKeys.map((k) => [k, id])),
  ),
);

/** worker name → module (workers not listed here are core and always run). */
export const MODULE_BY_WORKER_NAME: Readonly<Record<string, PlatformModuleId>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].workers.map((w) => [w, id])),
  ),
);

// ---------------------------------------------------------------------------
// Resolution (pure; no IO)
// ---------------------------------------------------------------------------

export type PlatformModuleStateMap = Readonly<Record<PlatformModuleId, boolean>>;

export const ALL_MODULES_ENABLED: PlatformModuleStateMap = Object.freeze(
  Object.fromEntries(PLATFORM_MODULE_IDS.map((id) => [id, true])),
) as PlatformModuleStateMap;

/** Parse `LOBE_MODULES_DISABLED="a, b,c"`. Unknown ids are reported, not thrown. */
export const parseDisabledModulesList = (
  raw: string | undefined | null,
): { disabled: PlatformModuleId[]; unknown: string[] } => {
  const disabled: PlatformModuleId[] = [];
  const unknown: string[] = [];
  if (!raw) return { disabled, unknown };
  for (const token of raw.split(/[,\s]+/)) {
    const value = token.trim();
    if (!value) continue;
    if (isPlatformModuleId(value)) {
      if (!disabled.includes(value)) disabled.push(value);
    } else {
      unknown.push(value);
    }
  }
  return { disabled, unknown };
};

export interface EnvModuleResolution {
  /** Modules hard-disabled by env (preset + explicit list + legacy enterprise flags). */
  envDisabled: ReadonlySet<PlatformModuleId>;
  /** Which env source disabled the module (for the "controlled by environment" badge). */
  envDisabledBy: Readonly<Partial<Record<PlatformModuleId, string>>>;
  preset: PlatformModulePreset;
  unknownIds: string[];
  /** Raw preset value was not one of the known presets (fell back to `full`). */
  unknownPreset: string | null;
}

/**
 * Resolve the env layer. `enterpriseFlags` is the already-parsed enterprise flag map
 * (a flag explicitly OFF also disables the module that depends on it).
 */
export const resolveModulesFromEnv = (
  env: Record<string, string | undefined> = process.env,
  enterpriseFlags?: Partial<Record<EnterpriseFeatureFlagKey, boolean>>,
): EnvModuleResolution => {
  const rawPreset = env[PLATFORM_MODULE_PRESET_ENV]?.trim().toLowerCase();
  const unknownPreset = rawPreset && !isPlatformModulePreset(rawPreset) ? rawPreset : null;
  const preset: PlatformModulePreset =
    rawPreset && isPlatformModulePreset(rawPreset) ? rawPreset : DEFAULT_PLATFORM_MODULE_PRESET;

  const envDisabled = new Set<PlatformModuleId>();
  const envDisabledBy: Partial<Record<PlatformModuleId, string>> = {};

  const presetEnabled = modulesForPreset(preset);
  for (const id of PLATFORM_MODULE_IDS) {
    if (!presetEnabled.has(id)) {
      envDisabled.add(id);
      envDisabledBy[id] = `${PLATFORM_MODULE_PRESET_ENV}=${preset}`;
    }
  }

  const { disabled, unknown } = parseDisabledModulesList(env[PLATFORM_MODULES_DISABLED_ENV]);
  for (const id of disabled) {
    envDisabled.add(id);
    envDisabledBy[id] = PLATFORM_MODULES_DISABLED_ENV;
  }

  if (enterpriseFlags) {
    for (const id of PLATFORM_MODULE_IDS) {
      const flag = PLATFORM_MODULES[id].enterpriseFlag;
      if (flag && enterpriseFlags[flag] === false) {
        envDisabled.add(id);
        envDisabledBy[id] ??= flag;
      }
    }
  }

  return { envDisabled, envDisabledBy, preset, unknownIds: unknown, unknownPreset };
};

/**
 * effective = envDisabled ? false : (db ?? true).  A missing / partial DB map never
 * disables anything by itself.
 */
export const computeEffectiveModules = (
  envDisabled: ReadonlySet<PlatformModuleId>,
  dbModules?: Partial<Record<PlatformModuleId, boolean>> | null,
): PlatformModuleStateMap =>
  Object.freeze(
    Object.fromEntries(
      PLATFORM_MODULE_IDS.map((id) => [
        id,
        envDisabled.has(id) ? false : (dbModules?.[id] ?? true),
      ]),
    ),
  ) as PlatformModuleStateMap;

/** Which preset (if any) exactly matches the given effective state; null = custom. */
export const matchPreset = (state: PlatformModuleStateMap): PlatformModulePreset | null => {
  for (const preset of PLATFORM_MODULE_PRESETS) {
    const enabled = modulesForPreset(preset);
    if (PLATFORM_MODULE_IDS.every((id) => state[id] === enabled.has(id))) return preset;
  }
  return null;
};

/** Modules whose toggling only fully applies after a process restart. */
export const RESTART_MODULE_IDS: ReadonlySet<PlatformModuleId> = new Set(
  PLATFORM_MODULE_IDS.filter((id) => PLATFORM_MODULES[id].kind === 'restart'),
);
