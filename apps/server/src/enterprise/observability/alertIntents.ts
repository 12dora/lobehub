export type EnterpriseAlertIntentKey =
  | 'materialization_failure_rate'
  | 'oidc_login_failure_ratio'
  | 'cache_failure_rate'
  | 'guard_denial_spike'
  | 'heartbeat_failure'
  | 'invalidation_degraded'
  | 'job_backlog_stalled'
  | 'operational_collection_stale'
  | 'publish_conflict_ratio'
  | 'publish_failure_ratio'
  | 'revision_lag'
  | 'ssrf_denial_spike';

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
  {
    description: 'Outbound-policy SSRF denials spike above a deployment-defined baseline.',
    key: 'ssrf_denial_spike',
    metric: 'enterprise_platform_ssrf_denial_total',
    status: 'intent-only',
  },
  {
    description: 'OIDC login failures exceed the deployment-defined ratio.',
    key: 'oidc_login_failure_ratio',
    metric: 'enterprise_platform_oidc_login_total',
    status: 'intent-only',
  },
  {
    description: 'Agent materialization failures exceed the deployment-defined rate.',
    key: 'materialization_failure_rate',
    metric: 'enterprise_platform_agent_materialization_total',
    status: 'intent-only',
  },
  {
    description:
      'The max cluster job backlog age remains above a deployment-defined service window.',
    key: 'job_backlog_stalled',
    metric: 'enterprise_platform_job_backlog_oldest_age_seconds',
    status: 'intent-only',
  },
  {
    description:
      'The max cluster identity revision-lag instance count remains above zero after rollout.',
    key: 'revision_lag',
    metric: 'enterprise_platform_revision_lag_instances',
    status: 'intent-only',
  },
  {
    description:
      'The max cluster operational snapshot age exceeds a deployment-defined collection window.',
    key: 'operational_collection_stale',
    metric: 'enterprise_platform_operational_snapshot_age_seconds',
    status: 'intent-only',
  },
] as const satisfies readonly EnterpriseAlertIntent[];
