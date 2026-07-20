export type EnterpriseAlertIntentKey =
  | 'cache_failure_rate'
  | 'guard_denial_spike'
  | 'heartbeat_failure'
  | 'invalidation_degraded'
  | 'publish_conflict_ratio'
  | 'publish_failure_ratio';

export interface EnterpriseAlertIntent {
  description: string;
  key: EnterpriseAlertIntentKey;
  metric: string;
  status: 'intent-only';
}

/** Backend-neutral design intents. No alerting backend is configured by this module. */
export const ENTERPRISE_ALERT_INTENTS = [
  {
    description: 'Configuration publish failures exceed the deployment-defined ratio.',
    key: 'publish_failure_ratio',
    metric: 'enterprise_platform_config_publish_total',
    status: 'intent-only',
  },
  {
    description: 'Configuration publish conflicts exceed the deployment-defined ratio.',
    key: 'publish_conflict_ratio',
    metric: 'enterprise_platform_config_publish_total',
    status: 'intent-only',
  },
  {
    description: 'Redis invalidation reports disabled, unavailable, partial, or error outcomes.',
    key: 'invalidation_degraded',
    metric: 'enterprise_platform_invalidation_total',
    status: 'intent-only',
  },
  {
    description: 'Authoritative domain cache loads or epoch probes fail repeatedly.',
    key: 'cache_failure_rate',
    metric: 'enterprise_platform_cache_load_total',
    status: 'intent-only',
  },
  {
    description: 'Managed-resource denials spike above a deployment-defined baseline.',
    key: 'guard_denial_spike',
    metric: 'enterprise_platform_guard_decision_total',
    status: 'intent-only',
  },
  {
    description: 'Persistent instance registration or heartbeat ticks fail.',
    key: 'heartbeat_failure',
    metric: 'enterprise_platform_instance_heartbeat_total',
    status: 'intent-only',
  },
] as const satisfies readonly EnterpriseAlertIntent[];
