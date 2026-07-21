/**
 * Enterprise alert intent metadata linked 1:1 to checked Prometheus reference rules.
 *
 * Rules live at:
 *   docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml
 *
 * status `reference-rule` means a real, promtool-checked PromQL rule exists in-repo.
 * It does **not** mean notifications are configured or that the rule was deployed to
 * production. Receivers and routing remain deployment-owned.
 */
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

/** Lifecycle of an intent relative to the in-repo Prometheus reference rules. */
export type EnterpriseAlertIntentStatus = 'reference-rule';

export interface EnterpriseAlertIntent {
  description: string;
  key: EnterpriseAlertIntentKey;
  metric: string;
  /** Stable Prometheus `alert:` name in the reference rule file. */
  ruleName: string;
  status: EnterpriseAlertIntentStatus;
}

/**
 * Backend-neutral design intents with exact 1:1 linkage to checked reference rules.
 * Thresholds/windows in the YAML are customizable defaults — not production policy.
 */
export const ENTERPRISE_ALERT_INTENTS = [
  {
    description: 'Configuration publish failures exceed the deployment-defined ratio.',
    key: 'publish_failure_ratio',
    metric: 'enterprise_platform_config_publish_total',
    ruleName: 'EnterpriseConfigPublishFailureRatio',
    status: 'reference-rule',
  },
  {
    description: 'Configuration publish conflicts exceed the deployment-defined ratio.',
    key: 'publish_conflict_ratio',
    metric: 'enterprise_platform_config_publish_total',
    ruleName: 'EnterpriseConfigPublishConflictRatio',
    status: 'reference-rule',
  },
  {
    description: 'Redis invalidation reports disabled, unavailable, partial, or error outcomes.',
    key: 'invalidation_degraded',
    metric: 'enterprise_platform_invalidation_total',
    ruleName: 'EnterpriseInvalidationDegraded',
    status: 'reference-rule',
  },
  {
    description: 'Authoritative domain cache loads or epoch probes fail repeatedly.',
    key: 'cache_failure_rate',
    metric: 'enterprise_platform_cache_load_total',
    ruleName: 'EnterpriseCacheFailureRate',
    status: 'reference-rule',
  },
  {
    description: 'Managed-resource denials spike above a deployment-defined baseline.',
    key: 'guard_denial_spike',
    metric: 'enterprise_platform_guard_decision_total',
    ruleName: 'EnterpriseGuardDenialSpike',
    status: 'reference-rule',
  },
  {
    description: 'Persistent instance registration or heartbeat ticks fail.',
    key: 'heartbeat_failure',
    metric: 'enterprise_platform_instance_heartbeat_total',
    ruleName: 'EnterpriseHeartbeatFailure',
    status: 'reference-rule',
  },
  {
    description: 'Outbound-policy SSRF denials spike above a deployment-defined baseline.',
    key: 'ssrf_denial_spike',
    metric: 'enterprise_platform_ssrf_denial_total',
    ruleName: 'EnterpriseSsrfDenialSpike',
    status: 'reference-rule',
  },
  {
    description: 'OIDC login failures exceed the deployment-defined ratio.',
    key: 'oidc_login_failure_ratio',
    metric: 'enterprise_platform_oidc_login_total',
    ruleName: 'EnterpriseOidcLoginFailureRatio',
    status: 'reference-rule',
  },
  {
    description: 'Agent materialization failures exceed the deployment-defined rate.',
    key: 'materialization_failure_rate',
    metric: 'enterprise_platform_agent_materialization_total',
    ruleName: 'EnterpriseAgentMaterializationFailureRate',
    status: 'reference-rule',
  },
  {
    description:
      'The max cluster job backlog age remains above a deployment-defined service window.',
    key: 'job_backlog_stalled',
    metric: 'enterprise_platform_job_backlog_oldest_age_seconds',
    ruleName: 'EnterpriseJobBacklogStalled',
    status: 'reference-rule',
  },
  {
    description:
      'The max cluster identity revision-lag instance count remains above zero after rollout.',
    key: 'revision_lag',
    metric: 'enterprise_platform_revision_lag_instances',
    ruleName: 'EnterpriseRevisionLag',
    status: 'reference-rule',
  },
  {
    description:
      'The required operational collector-enabled signal is not reaching Prometheus (no-data), or an enabled collector is uninitialized/stale after the deployment-defined window.',
    key: 'operational_collection_stale',
    metric: 'enterprise_platform_operational_snapshot_age_seconds',
    ruleName: 'EnterpriseOperationalCollectionStale',
    status: 'reference-rule',
  },
] as const satisfies readonly EnterpriseAlertIntent[];

/** Relative path from repo root to the checked Prometheus reference rule file. */
export const ENTERPRISE_ALERT_REFERENCE_RULES_RELATIVE_PATH =
  'docker-compose/production/grafana/prometheus/rules/enterprise-platform-alerts.yml' as const;
