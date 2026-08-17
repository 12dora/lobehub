export const PLATFORM_CONVERGENCE_DOMAINS = [
  'agent_catalog',
  'ai_catalog',
  'branding',
  'connector_catalog',
  'identity',
  'managed_policy',
  'settings',
  'skill_catalog',
] as const;

export const PLATFORM_CONVERGENCE_LOAD_MODES = [
  'process_cached',
  'request_scoped',
  'restart_activated',
] as const;

export const PLATFORM_CONVERGENCE_FALLBACK_POLICIES = [
  'none',
  'builtin',
  'lkg_then_break_glass',
] as const;

/** Single source of truth for every domain's operational contract. */
export const PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS = {
  agent_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'immutable_id',
  },
  ai_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'immutable_id',
  },
  branding: {
    fallbackPolicy: 'builtin',
    loadMode: 'process_cached',
    tokenKind: 'revision',
  },
  connector_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'immutable_id',
  },
  identity: {
    fallbackPolicy: 'lkg_then_break_glass',
    loadMode: 'restart_activated',
    tokenKind: 'immutable_id_or_null',
  },
  managed_policy: {
    fallbackPolicy: 'none',
    loadMode: 'request_scoped',
    tokenKind: 'revision',
  },
  settings: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'revision',
  },
  skill_catalog: {
    fallbackPolicy: 'none',
    loadMode: 'process_cached',
    tokenKind: 'immutable_id',
  },
} as const satisfies Record<
  (typeof PLATFORM_CONVERGENCE_DOMAINS)[number],
  {
    fallbackPolicy: (typeof PLATFORM_CONVERGENCE_FALLBACK_POLICIES)[number];
    loadMode: (typeof PLATFORM_CONVERGENCE_LOAD_MODES)[number];
    tokenKind: 'immutable_id' | 'immutable_id_or_null' | 'revision';
  }
>;
