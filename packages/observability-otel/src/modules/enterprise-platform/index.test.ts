import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCacheRequestAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  recordConfigPublishMetric,
  recordHeartbeatMetric,
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
    ]);
    expect(mocks.histogramNames).toEqual([
      'enterprise_platform_config_publish_duration_ms',
      'enterprise_platform_instance_heartbeat_duration_ms',
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
});
