import { metrics } from '@opentelemetry/api';

import type {
  ConfigPublishMetricAttributes,
  EnterpriseCacheDomain,
  EnterpriseCacheEpochOutcome,
  EnterpriseCacheLoadOutcome,
  EnterpriseCacheRequestOutcome,
  GuardDecisionMetricAttributes,
  HeartbeatMetricAttributes,
  InvalidationMetricAttributes,
} from './attributes';
import {
  buildCacheEpochAttributes,
  buildCacheLoadAttributes,
  buildCacheRequestAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  buildHeartbeatAttributes,
  buildInvalidationAttributes,
} from './attributes';

export * from './attributes';

const meter = metrics.getMeter('server-enterprise-platform');

export const configPublishCounter = meter.createCounter(
  'enterprise_platform_config_publish_total',
  {
    description: 'Enterprise configuration publish and rollback outcomes.',
  },
);
export const configPublishDuration = meter.createHistogram(
  'enterprise_platform_config_publish_duration_ms',
  { description: 'Enterprise configuration publish and rollback duration.', unit: 'ms' },
);
export const invalidationCounter = meter.createCounter('enterprise_platform_invalidation_total', {
  description: 'Enterprise configuration invalidation delivery outcomes.',
});
export const cacheRequestCounter = meter.createCounter('enterprise_platform_cache_request_total', {
  description: 'Enterprise domain cache request classifications.',
});
export const cacheLoadCounter = meter.createCounter('enterprise_platform_cache_load_total', {
  description: 'Enterprise domain cache database load outcomes.',
});
export const cacheEpochCounter = meter.createCounter('enterprise_platform_cache_epoch_total', {
  description: 'Enterprise domain cache epoch probe outcomes.',
});
export const guardDecisionCounter = meter.createCounter(
  'enterprise_platform_guard_decision_total',
  { description: 'Enterprise managed-resource guard decisions.' },
);
export const instanceHeartbeatCounter = meter.createCounter(
  'enterprise_platform_instance_heartbeat_total',
  { description: 'Enterprise instance registration and heartbeat outcomes.' },
);
export const instanceHeartbeatDuration = meter.createHistogram(
  'enterprise_platform_instance_heartbeat_duration_ms',
  { description: 'Enterprise instance registration and heartbeat duration.', unit: 'ms' },
);

const boundedDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;

export const recordConfigPublishMetric = (
  input: ConfigPublishMetricAttributes & { durationMs: number },
): void => {
  const attributes = buildConfigPublishAttributes(input);
  configPublishCounter.add(1, attributes);
  configPublishDuration.record(boundedDuration(input.durationMs), attributes);
};

export const recordInvalidationMetric = (input: InvalidationMetricAttributes): void => {
  invalidationCounter.add(1, buildInvalidationAttributes(input));
};

export const recordCacheRequestMetric = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheRequestOutcome;
}): void => cacheRequestCounter.add(1, buildCacheRequestAttributes(input));

export const recordCacheLoadMetric = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheLoadOutcome;
}): void => cacheLoadCounter.add(1, buildCacheLoadAttributes(input));

export const recordCacheEpochMetric = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheEpochOutcome;
}): void => cacheEpochCounter.add(1, buildCacheEpochAttributes(input));

export const recordGuardDecisionMetric = (input: GuardDecisionMetricAttributes): void => {
  guardDecisionCounter.add(1, buildGuardDecisionAttributes(input));
};

export const recordHeartbeatMetric = (
  input: HeartbeatMetricAttributes & { durationMs: number },
): void => {
  const attributes = buildHeartbeatAttributes(input);
  instanceHeartbeatCounter.add(1, attributes);
  instanceHeartbeatDuration.record(boundedDuration(input.durationMs), attributes);
};
