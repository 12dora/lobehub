import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateEnterpriseOperationalCollectors,
  buildAgentMaterializationAttributes,
  buildCacheRequestAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  buildJobBacklogAttributes,
  buildOidcLoginAttributes,
  buildOperationalCollectionAttributes,
  buildRevisionLagAttributes,
  buildSsrfDenialAttributes,
  ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ENTERPRISE_OIDC_FAILURE_CATEGORIES,
  ENTERPRISE_OIDC_LOGIN_STAGES,
  ENTERPRISE_SSRF_DENIAL_CATEGORIES,
  recordAgentMaterializationMetric,
  recordConfigPublishMetric,
  recordHeartbeatMetric,
  recordOidcLoginMetric,
  recordOperationalCollectionMetric,
  recordSsrfDenialMetric,
  resetEnterpriseOperationalMetricsForTest,
  setEnterpriseJobBacklogMetricSnapshot,
  setEnterpriseRevisionLagMetricSnapshot,
} from './index';

type ObservableCallback = (result: {
  observe: (value: number, attributes: unknown) => void;
}) => void;

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  counterNames: [] as string[],
  createCounter: vi.fn((name: string) => {
    mocks.counterNames.push(name);
    return { add: mocks.add };
  }),
  createHistogram: vi.fn((name: string) => {
    mocks.histogramNames.push(name);
    return { record: mocks.record };
  }),
  createObservableGauge: vi.fn((name: string) => {
    mocks.observableGaugeNames.push(name);
    return {
      addCallback: (callback: ObservableCallback) => mocks.observableCallbacks.set(name, callback),
    };
  }),
  getMeter: vi.fn((name: string) => {
    mocks.meterNames.push(name);
    return {
      createCounter: mocks.createCounter,
      createHistogram: mocks.createHistogram,
      createObservableGauge: mocks.createObservableGauge,
    };
  }),
  histogramNames: [] as string[],
  meterNames: [] as string[],
  observableCallbacks: new Map<string, ObservableCallback>(),
  observableGaugeNames: [] as string[],
  record: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({ metrics: { getMeter: mocks.getMeter } }));

beforeEach(() => {
  vi.clearAllMocks();
  resetEnterpriseOperationalMetricsForTest();
});
afterEach(() => vi.restoreAllMocks());

describe('enterprise platform OpenTelemetry instruments', () => {
  it('declares only the fixed enterprise instrument set', () => {
    expect(mocks.meterNames).toEqual(['server-enterprise-platform']);
    expect(mocks.counterNames).toEqual([
      'enterprise_platform_config_publish_total',
      'enterprise_platform_invalidation_total',
      'enterprise_platform_cache_request_total',
      'enterprise_platform_cache_load_total',
      'enterprise_platform_cache_epoch_total',
      'enterprise_platform_guard_decision_total',
      'enterprise_platform_instance_heartbeat_total',
      'enterprise_platform_ssrf_denial_total',
      'enterprise_platform_oidc_login_total',
      'enterprise_platform_agent_materialization_total',
      'enterprise_platform_operational_collection_total',
    ]);
    expect(mocks.histogramNames).toEqual([
      'enterprise_platform_config_publish_duration_ms',
      'enterprise_platform_instance_heartbeat_duration_ms',
      'enterprise_platform_agent_materialization_duration_ms',
      'enterprise_platform_operational_collection_duration_ms',
    ]);
    expect(mocks.observableGaugeNames).toEqual([
      'enterprise_platform_job_backlog',
      'enterprise_platform_job_backlog_oldest_age_seconds',
      'enterprise_platform_revision_lag_instances',
      'enterprise_platform_revision_fresh_instances',
      'enterprise_platform_operational_snapshot_ready',
      'enterprise_platform_operational_snapshot_age_seconds',
    ]);
  });

  it('builds only fixed cluster operational dimensions', () => {
    expect(buildJobBacklogAttributes({ state: 'pending' })).toEqual({
      'enterprise.scope': 'cluster',
      'enterprise.state': 'pending',
    });
    expect(
      buildRevisionLagAttributes({ domain: 'identity', reason: 'diverged', token: 'raw' } as never),
    ).toEqual({
      'enterprise.domain': 'identity',
      'enterprise.reason': 'diverged',
      'enterprise.scope': 'cluster',
    });
    expect(
      buildOperationalCollectionAttributes({
        collector: 'job-id',
        instanceId: 'pinst_raw',
        outcome: 'tenant-id',
      } as never),
    ).toEqual({ 'enterprise.scope': 'cluster' });
  });

  it('exposes snapshots through synchronous callbacks without doing callback-time work', () => {
    activateEnterpriseOperationalCollectors(['job_backlog', 'revision_lag']);
    setEnterpriseJobBacklogMetricSnapshot({
      collectedAtMs: 10_000,
      entries: [
        { count: 2, oldestAgeSeconds: 7, state: 'pending' },
        { count: 1, oldestAgeSeconds: 3, state: 'reserved_expired' },
        { count: 0, oldestAgeSeconds: 0, state: 'running_lease_expired' },
      ],
    });
    setEnterpriseRevisionLagMetricSnapshot({
      collectedAtMs: 12_000,
      domain: 'identity',
      freshInstances: 4,
      laggingInstances: [
        { count: 1, reason: 'degraded' },
        { count: 2, reason: 'diverged' },
      ],
    });
    vi.spyOn(Date, 'now').mockReturnValue(15_000);

    const collect = (name: string) => {
      const observe = vi.fn();
      const callback = mocks.observableCallbacks.get(name);
      expect(callback).toBeTypeOf('function');
      expect(callback?.({ observe })).toBeUndefined();
      return observe.mock.calls;
    };

    expect(collect('enterprise_platform_job_backlog')).toEqual([
      [2, { 'enterprise.scope': 'cluster', 'enterprise.state': 'pending' }],
      [1, { 'enterprise.scope': 'cluster', 'enterprise.state': 'reserved_expired' }],
      [0, { 'enterprise.scope': 'cluster', 'enterprise.state': 'running_lease_expired' }],
    ]);
    expect(collect('enterprise_platform_job_backlog_oldest_age_seconds')[0]).toEqual([
      7,
      { 'enterprise.scope': 'cluster', 'enterprise.state': 'pending' },
    ]);
    expect(collect('enterprise_platform_revision_lag_instances')).toEqual([
      [
        1,
        {
          'enterprise.domain': 'identity',
          'enterprise.reason': 'degraded',
          'enterprise.scope': 'cluster',
        },
      ],
      [
        2,
        {
          'enterprise.domain': 'identity',
          'enterprise.reason': 'diverged',
          'enterprise.scope': 'cluster',
        },
      ],
    ]);
    expect(collect('enterprise_platform_revision_fresh_instances')).toEqual([
      [4, { 'enterprise.domain': 'identity', 'enterprise.scope': 'cluster' }],
    ]);
    expect(collect('enterprise_platform_operational_snapshot_ready')).toEqual([
      [1, { 'enterprise.collector': 'job_backlog', 'enterprise.scope': 'cluster' }],
      [1, { 'enterprise.collector': 'revision_lag', 'enterprise.scope': 'cluster' }],
    ]);
    expect(collect('enterprise_platform_operational_snapshot_age_seconds')).toEqual([
      [5, { 'enterprise.collector': 'job_backlog', 'enterprise.scope': 'cluster' }],
      [3, { 'enterprise.collector': 'revision_lag', 'enterprise.scope': 'cluster' }],
    ]);
  });

  it('reports active collectors as not ready before a first successful snapshot', () => {
    activateEnterpriseOperationalCollectors(['job_backlog']);
    const observe = vi.fn();
    mocks.observableCallbacks.get('enterprise_platform_operational_snapshot_ready')?.({ observe });

    expect(observe).toHaveBeenCalledWith(0, {
      'enterprise.collector': 'job_backlog',
      'enterprise.scope': 'cluster',
    });
  });

  it('builds closed low-cardinality labels and drops arbitrary identifiers', () => {
    const attributes = buildConfigPublishAttributes({
      domain: 'branding',
      operation: 'publish',
      outcome: 'success',
      resourceId: 'raw-resource-id',
      userId: 'raw-user-id',
    } as never);
    expect(attributes).toEqual({
      'enterprise.domain': 'branding',
      'enterprise.operation': 'publish',
      'enterprise.outcome': 'success',
    });
    expect(JSON.stringify(attributes)).not.toContain('raw-');
  });

  it('drops runtime values outside the closed unions', () => {
    expect(
      buildCacheRequestAttributes({ domain: 'tenant-123', outcome: 'request-123' } as never),
    ).toEqual({});
    expect(
      buildGuardDecisionAttributes({
        classification: 'raw-procedure',
        mode: 'tenant-mode',
        outcome: 'request-id',
        resource: 'resource-id',
      } as never),
    ).toEqual({});
  });

  it('exports the exact closed security and identity dimensions', () => {
    expect(ENTERPRISE_SSRF_DENIAL_CATEGORIES).toEqual([
      'invalid_url',
      'protocol_denied',
      'credential_url',
      'metadata_endpoint',
      'allowlist_denied',
      'invalid_address',
      'non_public_address',
      'dns_unavailable',
      'policy_changed',
      'policy_unavailable',
      'secret_redirect',
      'redirect_limit',
      'deadline_exceeded',
    ]);
    expect(ENTERPRISE_OIDC_LOGIN_STAGES).toEqual([
      'token_exchange',
      'state_validation',
      'id_token_verification',
      'userinfo',
      'authenticated',
    ]);
    expect(ENTERPRISE_OIDC_FAILURE_CATEGORIES).toEqual([
      'state_invalid',
      'token_invalid',
      'nonce_invalid',
      'id_token_invalid',
      'userinfo_invalid',
      'subject_mismatch',
      'claim_invalid',
      'network_failure',
      'unexpected',
    ]);
    expect(ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES).toEqual([
      'created',
      'reused',
      'race_reused',
      'archived',
      'failure',
    ]);
  });

  it('drops high-cardinality security and identity fields', () => {
    const extras = {
      checksum: 'checksum-raw',
      host: 'host-raw',
      ip: 'ip-raw',
      provider: 'provider-raw',
      resource: 'resource-raw',
      subject: 'subject-raw',
      url: 'url-raw',
      user: 'user-raw',
    };

    expect(
      buildSsrfDenialAttributes({ category: 'metadata_endpoint', ...extras } as never),
    ).toEqual({ 'enterprise.category': 'metadata_endpoint' });
    expect(
      buildOidcLoginAttributes({
        failureCategory: 'subject_mismatch',
        outcome: 'success',
        stage: 'authenticated',
        ...extras,
      } as never),
    ).toEqual({ 'enterprise.outcome': 'success', 'enterprise.stage': 'authenticated' });
    expect(buildAgentMaterializationAttributes({ outcome: 'created', ...extras } as never)).toEqual(
      {
        'enterprise.outcome': 'created',
      },
    );
    expect(JSON.stringify({ extras })).toContain('raw');
  });

  it('drops invalid runtime security and identity dimensions', () => {
    expect(buildSsrfDenialAttributes({ category: 'https://private.example' } as never)).toEqual({});
    expect(
      buildOidcLoginAttributes({
        failureCategory: 'subject-123',
        outcome: 'failure',
        stage: 'provider-123',
      } as never),
    ).toEqual({});
    expect(
      buildOidcLoginAttributes({ outcome: 'provider-123', stage: 'userinfo' } as never),
    ).toEqual({});
    expect(
      buildOidcLoginAttributes({
        failureCategory: 'subject-123',
        outcome: 'failure',
        stage: 'userinfo',
      } as never),
    ).toEqual({
      'enterprise.failure_category': 'unexpected',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'userinfo',
    });
    expect(buildAgentMaterializationAttributes({ outcome: 'user-123' } as never)).toEqual({});
  });

  it('records OIDC events only when the runtime relationship is valid', () => {
    recordOidcLoginMetric({ outcome: 'success', stage: 'provider-123' } as never);
    recordOidcLoginMetric({ outcome: 'provider-123', stage: 'authenticated' } as never);
    recordOidcLoginMetric({ outcome: 'failure', stage: 'userinfo' } as never);
    recordOidcLoginMetric({
      failureCategory: 'subject-123',
      outcome: 'failure',
      stage: 'userinfo',
    } as never);
    recordOidcLoginMetric({
      failureCategory: 'subject_mismatch',
      outcome: 'success',
      stage: 'authenticated',
    } as never);
    recordOidcLoginMetric({
      failureCategory: 'id_token_invalid',
      outcome: 'failure',
      stage: 'id_token_verification',
    });

    expect(mocks.add).toHaveBeenCalledTimes(4);
    expect(mocks.add).toHaveBeenNthCalledWith(1, 1, {
      'enterprise.failure_category': 'unexpected',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'userinfo',
    });
    expect(mocks.add).toHaveBeenNthCalledWith(2, 1, {
      'enterprise.failure_category': 'unexpected',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'userinfo',
    });
    expect(mocks.add).toHaveBeenNthCalledWith(3, 1, {
      'enterprise.outcome': 'success',
      'enterprise.stage': 'authenticated',
    });
    expect(mocks.add).toHaveBeenNthCalledWith(4, 1, {
      'enterprise.failure_category': 'id_token_invalid',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'id_token_verification',
    });
  });

  it('records bounded durations with only closed attributes', () => {
    recordConfigPublishMetric({
      domain: 'skill_catalog',
      durationMs: Number.NaN,
      operation: 'rollback',
      outcome: 'conflict',
    });
    recordHeartbeatMetric({ durationMs: -5, operation: 'tick', outcome: 'failure' });

    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenNthCalledWith(1, 0, {
      'enterprise.domain': 'skill_catalog',
      'enterprise.operation': 'rollback',
      'enterprise.outcome': 'conflict',
    });
    expect(mocks.record).toHaveBeenNthCalledWith(2, 0, {
      'enterprise.operation': 'tick',
      'enterprise.outcome': 'failure',
    });
  });

  it('records the new instruments with exact low-cardinality attributes', () => {
    recordSsrfDenialMetric({ category: 'protocol_denied' });
    recordOidcLoginMetric({
      failureCategory: 'token_invalid',
      outcome: 'failure',
      stage: 'id_token_verification',
    });
    recordAgentMaterializationMetric({ durationMs: Number.POSITIVE_INFINITY, outcome: 'failure' });
    recordOperationalCollectionMetric({
      collector: 'revision_lag',
      durationMs: 8,
      outcome: 'failure',
    });

    expect(mocks.add).toHaveBeenCalledTimes(4);
    expect(mocks.add).toHaveBeenNthCalledWith(1, 1, {
      'enterprise.category': 'protocol_denied',
    });
    expect(mocks.add).toHaveBeenNthCalledWith(2, 1, {
      'enterprise.failure_category': 'token_invalid',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'id_token_verification',
    });
    expect(mocks.record).toHaveBeenCalledWith(0, { 'enterprise.outcome': 'failure' });
    expect(mocks.add).toHaveBeenNthCalledWith(4, 1, {
      'enterprise.collector': 'revision_lag',
      'enterprise.outcome': 'failure',
      'enterprise.scope': 'cluster',
    });
  });
});
