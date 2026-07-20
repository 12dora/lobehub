import { describe, expect, it } from 'vitest';

import { ENTERPRISE_ALERT_INTENTS } from './alertIntents';

describe('enterprise alert intents', () => {
  it('defines the exact backend-neutral inactive operational intents', () => {
    expect(ENTERPRISE_ALERT_INTENTS.map(({ key }) => key)).toEqual([
      'publish_failure_ratio',
      'publish_conflict_ratio',
      'invalidation_degraded',
      'cache_failure_rate',
      'guard_denial_spike',
      'heartbeat_failure',
      'ssrf_denial_spike',
      'oidc_login_failure_ratio',
      'materialization_failure_rate',
      'job_backlog_stalled',
      'revision_lag',
      'operational_collection_stale',
    ]);
    expect(ENTERPRISE_ALERT_INTENTS.map(({ metric }) => metric)).toEqual([
      'enterprise_platform_config_publish_total',
      'enterprise_platform_config_publish_total',
      'enterprise_platform_invalidation_total',
      'enterprise_platform_cache_load_total',
      'enterprise_platform_guard_decision_total',
      'enterprise_platform_instance_heartbeat_total',
      'enterprise_platform_ssrf_denial_total',
      'enterprise_platform_oidc_login_total',
      'enterprise_platform_agent_materialization_total',
      'enterprise_platform_job_backlog_oldest_age_seconds',
      'enterprise_platform_revision_lag_instances',
      'enterprise_platform_operational_snapshot_age_seconds',
    ]);
    expect(ENTERPRISE_ALERT_INTENTS.every(({ status }) => status === 'intent-only')).toBe(true);
  });
});
