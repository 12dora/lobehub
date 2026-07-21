/**
 * Proven Prometheus metric/label names after OTLP → collector prometheusremotewrite
 * → Prometheus remote-write on the pinned stack (v2.55.1 + collector-contrib 0.120.0).
 *
 * OTel attribute keys use dots (`enterprise.outcome`); Prometheus labels use
 * underscores (`enterprise_outcome`) for counters and gauges alike.
 */

/** OTel attribute key → Prometheus label key after remote-write translation. */
export const OTEL_TO_PROMETHEUS_LABEL: Readonly<Record<string, string>> = {
  'enterprise.category': 'enterprise_category',
  'enterprise.classification': 'enterprise_classification',
  'enterprise.collector': 'enterprise_collector',
  'enterprise.domain': 'enterprise_domain',
  'enterprise.failure_category': 'enterprise_failure_category',
  'enterprise.mode': 'enterprise_mode',
  'enterprise.operation': 'enterprise_operation',
  'enterprise.outcome': 'enterprise_outcome',
  'enterprise.reason': 'enterprise_reason',
  'enterprise.resource': 'enterprise_resource',
  'enterprise.scope': 'enterprise_scope',
  'enterprise.stage': 'enterprise_stage',
  'enterprise.state': 'enterprise_state',
};

/** Selector families used by the 12 reference rules (exact PromQL label matchers). */
export const ENTERPRISE_ALERT_SELECTOR_FAMILIES = [
  {
    family: 'config_publish_outcome',
    metric: 'enterprise_platform_config_publish_total',
    prometheusLabels: {
      enterprise_outcome: 'failure',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'failure',
    } as const,
  },
  {
    family: 'invalidation_degraded_outcomes',
    metric: 'enterprise_platform_invalidation_total',
    prometheusLabels: {
      enterprise_outcome: 'error',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'error',
    } as const,
  },
  {
    family: 'cache_load_failure',
    metric: 'enterprise_platform_cache_load_total',
    prometheusLabels: {
      enterprise_outcome: 'load_failure',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'load_failure',
    } as const,
  },
  {
    family: 'guard_denied',
    metric: 'enterprise_platform_guard_decision_total',
    prometheusLabels: {
      enterprise_outcome: 'denied',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'denied',
    } as const,
  },
  {
    family: 'heartbeat_failure',
    metric: 'enterprise_platform_instance_heartbeat_total',
    prometheusLabels: {
      enterprise_outcome: 'failure',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'failure',
    } as const,
  },
  {
    family: 'ssrf_denial',
    metric: 'enterprise_platform_ssrf_denial_total',
    prometheusLabels: {
      enterprise_category: 'allowlist_denied',
    } as const,
    otelAttributes: {
      'enterprise.category': 'allowlist_denied',
    } as const,
  },
  {
    family: 'oidc_login_failure',
    metric: 'enterprise_platform_oidc_login_total',
    prometheusLabels: {
      enterprise_outcome: 'failure',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'failure',
    } as const,
  },
  {
    family: 'agent_materialization_failure',
    metric: 'enterprise_platform_agent_materialization_total',
    prometheusLabels: {
      enterprise_outcome: 'failure',
    } as const,
    otelAttributes: {
      'enterprise.outcome': 'failure',
    } as const,
  },
  {
    family: 'job_backlog_age_gauge',
    metric: 'enterprise_platform_job_backlog_oldest_age_seconds',
    prometheusLabels: {
      enterprise_scope: 'cluster',
      enterprise_state: 'pending',
    } as const,
    otelAttributes: {
      'enterprise.scope': 'cluster',
      'enterprise.state': 'pending',
    } as const,
  },
  {
    family: 'revision_lag_gauge',
    metric: 'enterprise_platform_revision_lag_instances',
    prometheusLabels: {
      enterprise_domain: 'identity',
      enterprise_reason: 'diverged',
      enterprise_scope: 'cluster',
    } as const,
    otelAttributes: {
      'enterprise.domain': 'identity',
      'enterprise.reason': 'diverged',
      'enterprise.scope': 'cluster',
    } as const,
  },
  {
    family: 'operational_snapshot_age_gauge',
    metric: 'enterprise_platform_operational_snapshot_age_seconds',
    prometheusLabels: {
      enterprise_collector: 'job_backlog',
      enterprise_scope: 'cluster',
    } as const,
    otelAttributes: {
      'enterprise.collector': 'job_backlog',
      'enterprise.scope': 'cluster',
    } as const,
  },
  {
    family: 'operational_snapshot_ready_gauge',
    metric: 'enterprise_platform_operational_snapshot_ready',
    prometheusLabels: {
      enterprise_collector: 'job_backlog',
      enterprise_scope: 'cluster',
    } as const,
    otelAttributes: {
      'enterprise.collector': 'job_backlog',
      'enterprise.scope': 'cluster',
    } as const,
  },
] as const;

export type EnterpriseAlertSelectorFamily = (typeof ENTERPRISE_ALERT_SELECTOR_FAMILIES)[number];

/** Build a PromQL instant selector for a proven label set. */
export const promqlInstantSelector = (metric: string, labels: Record<string, string>): string => {
  const matchers = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  return matchers.length > 0 ? `${metric}{${matchers}}` : metric;
};

/** Assert rule expressions use proven Prometheus label keys (underscores), not OTel dots. */
export const assertRuleExprUsesPrometheusLabels = (expr: string): void => {
  if (expr.includes('enterprise.')) {
    throw new Error(
      `Rule expr still uses dotted OTel attribute keys; Prometheus labels are underscored: ${expr.slice(0, 120)}`,
    );
  }
  for (const [otelKey, promKey] of Object.entries(OTEL_TO_PROMETHEUS_LABEL)) {
    if (expr.includes(otelKey)) {
      throw new Error(`Rule expr contains OTel key ${otelKey}; expected ${promKey}`);
    }
  }
};
