import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAgentMaterializationAttributes,
  buildCacheRequestAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  buildOidcLoginAttributes,
  buildSsrfDenialAttributes,
  ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ENTERPRISE_OIDC_FAILURE_CATEGORIES,
  ENTERPRISE_OIDC_LOGIN_STAGES,
  ENTERPRISE_SSRF_DENIAL_CATEGORIES,
  recordAgentMaterializationMetric,
  recordConfigPublishMetric,
  recordHeartbeatMetric,
  recordOidcLoginMetric,
  recordSsrfDenialMetric,
} from './index';

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
  getMeter: vi.fn((name: string) => {
    mocks.meterNames.push(name);
    return {
      createCounter: mocks.createCounter,
      createHistogram: mocks.createHistogram,
    };
  }),
  histogramNames: [] as string[],
  meterNames: [] as string[],
  record: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({ metrics: { getMeter: mocks.getMeter } }));

beforeEach(() => vi.clearAllMocks());

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
    ]);
    expect(mocks.histogramNames).toEqual([
      'enterprise_platform_config_publish_duration_ms',
      'enterprise_platform_instance_heartbeat_duration_ms',
      'enterprise_platform_agent_materialization_duration_ms',
    ]);
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
    ).toEqual({ 'enterprise.outcome': 'failure' });
    expect(buildAgentMaterializationAttributes({ outcome: 'user-123' } as never)).toEqual({});
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

    expect(mocks.add).toHaveBeenCalledTimes(3);
    expect(mocks.add).toHaveBeenNthCalledWith(1, 1, {
      'enterprise.category': 'protocol_denied',
    });
    expect(mocks.add).toHaveBeenNthCalledWith(2, 1, {
      'enterprise.failure_category': 'token_invalid',
      'enterprise.outcome': 'failure',
      'enterprise.stage': 'id_token_verification',
    });
    expect(mocks.record).toHaveBeenCalledWith(0, { 'enterprise.outcome': 'failure' });
  });
});
