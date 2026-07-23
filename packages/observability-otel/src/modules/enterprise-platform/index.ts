import { metrics } from '@opentelemetry/api';

import type {
  AgentMaterializationMetricAttributes,
  ConfigPublishMetricAttributes,
  EnterpriseCacheDomain,
  EnterpriseCacheEpochOutcome,
  EnterpriseCacheLoadOutcome,
  EnterpriseCacheRequestOutcome,
  EnterpriseJobBacklogState,
  EnterpriseOperationalCollector,
  EnterpriseRevisionLagReason,
  GuardDecisionMetricAttributes,
  HeartbeatMetricAttributes,
  InvalidationMetricAttributes,
  OidcLoginMetricAttributes,
  OperationalCollectionMetricAttributes,
  SsrfDenialMetricAttributes,
} from './attributes';
import {
  buildAgentMaterializationAttributes,
  buildCacheEpochAttributes,
  buildCacheLoadAttributes,
  buildCacheRequestAttributes,
  buildConfigPublishAttributes,
  buildGuardDecisionAttributes,
  buildHeartbeatAttributes,
  buildInvalidationAttributes,
  buildJobBacklogAttributes,
  buildOidcLoginAttributes,
  buildOperationalCollectionAttributes,
  buildOperationalCollectorAttributes,
  buildRevisionFreshAttributes,
  buildRevisionLagAttributes,
  buildSsrfDenialAttributes,
  ENTERPRISE_JOB_BACKLOG_STATES,
  ENTERPRISE_OPERATIONAL_COLLECTORS,
  ENTERPRISE_REVISION_LAG_REASONS,
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
export const ssrfDenialCounter = meter.createCounter('enterprise_platform_ssrf_denial_total', {
  description: 'Enterprise outbound-policy SSRF denials by stable category.',
});
export const oidcLoginCounter = meter.createCounter('enterprise_platform_oidc_login_total', {
  description: 'Enterprise OIDC login stage outcomes.',
});
export const agentMaterializationCounter = meter.createCounter(
  'enterprise_platform_agent_materialization_total',
  { description: 'Enterprise agent materialization outcomes.' },
);
export const agentMaterializationDuration = meter.createHistogram(
  'enterprise_platform_agent_materialization_duration_ms',
  { description: 'Enterprise agent materialization duration.', unit: 'ms' },
);
export const operationalCollectionCounter = meter.createCounter(
  'enterprise_platform_operational_collection_total',
  { description: 'Enterprise operational snapshot collection outcomes.' },
);
export const operationalCollectionDuration = meter.createHistogram(
  'enterprise_platform_operational_collection_duration_ms',
  { description: 'Enterprise operational snapshot collection duration.', unit: 'ms' },
);
export const jobBacklogGauge = meter.createObservableGauge('enterprise_platform_job_backlog', {
  description: 'Cluster-wide platform jobs available for claim, recovery, or cleanup.',
  unit: '{job}',
});
export const jobBacklogOldestAgeGauge = meter.createObservableGauge(
  'enterprise_platform_job_backlog_oldest_age_seconds',
  { description: 'Age of the oldest cluster-wide available platform job.', unit: 's' },
);
export const revisionLagInstancesGauge = meter.createObservableGauge(
  'enterprise_platform_revision_lag_instances',
  {
    description: 'Fresh enterprise instances lagging the authoritative domain revision.',
    unit: '{instance}',
  },
);
export const revisionFreshInstancesGauge = meter.createObservableGauge(
  'enterprise_platform_revision_fresh_instances',
  {
    description: 'Fresh enterprise instances reporting a production domain revision.',
    unit: '{instance}',
  },
);
export const operationalSnapshotReadyGauge = meter.createObservableGauge(
  'enterprise_platform_operational_snapshot_ready',
  { description: 'Whether an active operational collector has produced a successful snapshot.' },
);
export const operationalSnapshotAgeGauge = meter.createObservableGauge(
  'enterprise_platform_operational_snapshot_age_seconds',
  { description: 'Age of the last successful operational collector snapshot.', unit: 's' },
);
/**
 * 0/1 expected/enabled state for each known operational collector.
 * Emitted for every closed collector once the operational metrics runtime activates,
 * including disabled collectors (value 0). Alert rules must gate ready/age/absence
 * on enabled==1 so optional collectors (e.g. revision_lag without DB OIDC) do not
 * permanently false-alert.
 */
export const operationalCollectorEnabledGauge = meter.createObservableGauge(
  'enterprise_platform_operational_collector_enabled',
  {
    description:
      'Whether an operational collector is enabled/expected on this process (1) or disabled (0).',
  },
);

export interface EnterpriseJobBacklogMetricSnapshot {
  collectedAtMs: number;
  entries: Array<{
    count: number;
    oldestAgeSeconds: number;
    state: EnterpriseJobBacklogState;
  }>;
}

export interface EnterpriseRevisionLagMetricSnapshot {
  collectedAtMs: number;
  domain: 'identity';
  freshInstances: number;
  laggingInstances: Array<{ count: number; reason: EnterpriseRevisionLagReason }>;
}

const activeOperationalCollectors = new Set<EnterpriseOperationalCollector>();
/** True after activate() has been called (including activate([]) on stop). */
let operationalCollectorsConfigured = false;
let jobBacklogSnapshot: EnterpriseJobBacklogMetricSnapshot | null = null;
let revisionLagSnapshot: EnterpriseRevisionLagMetricSnapshot | null = null;

const boundedValue = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);

const validCollectedAt = (collectedAtMs: number): boolean =>
  Number.isFinite(collectedAtMs) && collectedAtMs >= 0;

export const activateEnterpriseOperationalCollectors = (
  collectors: readonly EnterpriseOperationalCollector[],
): void => {
  operationalCollectorsConfigured = true;
  activeOperationalCollectors.clear();
  for (const collector of collectors) {
    if (ENTERPRISE_OPERATIONAL_COLLECTORS.includes(collector)) {
      activeOperationalCollectors.add(collector);
    }
  }
};

export const setEnterpriseJobBacklogMetricSnapshot = (
  snapshot: EnterpriseJobBacklogMetricSnapshot,
): void => {
  if (!validCollectedAt(snapshot.collectedAtMs)) return;
  const byState = new Map(snapshot.entries.map((entry) => [entry.state, entry]));
  jobBacklogSnapshot = {
    collectedAtMs: snapshot.collectedAtMs,
    entries: ENTERPRISE_JOB_BACKLOG_STATES.map((state) => {
      const entry = byState.get(state);
      return {
        count: boundedValue(entry?.count ?? 0),
        oldestAgeSeconds: boundedValue(entry?.oldestAgeSeconds ?? 0),
        state,
      };
    }),
  };
};

export const setEnterpriseRevisionLagMetricSnapshot = (
  snapshot: EnterpriseRevisionLagMetricSnapshot,
): void => {
  if (!validCollectedAt(snapshot.collectedAtMs) || snapshot.domain !== 'identity') return;
  const byReason = new Map(snapshot.laggingInstances.map((entry) => [entry.reason, entry]));
  revisionLagSnapshot = {
    collectedAtMs: snapshot.collectedAtMs,
    domain: snapshot.domain,
    freshInstances: boundedValue(snapshot.freshInstances),
    laggingInstances: ENTERPRISE_REVISION_LAG_REASONS.map((reason) => ({
      count: boundedValue(byReason.get(reason)?.count ?? 0),
      reason,
    })),
  };
};

type GaugeObserveResult = {
  observe: (value: number, attributes: ReturnType<typeof buildJobBacklogAttributes>) => void;
};

const withActiveCollectorSnapshot = <T>(
  collector: EnterpriseOperationalCollector,
  snapshot: T | null,
  run: (snapshot: T) => void,
): void => {
  if (!activeOperationalCollectors.has(collector) || !snapshot) return;
  run(snapshot);
};

const observeJobBacklog = (
  result: GaugeObserveResult,
  valueSelector: (entry: EnterpriseJobBacklogMetricSnapshot['entries'][number]) => number,
): void => {
  withActiveCollectorSnapshot('job_backlog', jobBacklogSnapshot, (snapshot) => {
    for (const entry of snapshot.entries) {
      const attributes = buildJobBacklogAttributes(entry);
      if (!attributes['enterprise.state']) continue;
      result.observe(valueSelector(entry), attributes);
    }
  });
};

jobBacklogGauge.addCallback((result) => {
  observeJobBacklog(result, (entry) => entry.count);
});

jobBacklogOldestAgeGauge.addCallback((result) => {
  observeJobBacklog(result, (entry) => entry.oldestAgeSeconds);
});

revisionLagInstancesGauge.addCallback((result) => {
  withActiveCollectorSnapshot('revision_lag', revisionLagSnapshot, (snapshot) => {
    for (const entry of snapshot.laggingInstances) {
      const attributes = buildRevisionLagAttributes({
        domain: snapshot.domain,
        reason: entry.reason,
      });
      if (!attributes['enterprise.domain'] || !attributes['enterprise.reason']) continue;
      result.observe(entry.count, attributes);
    }
  });
});

revisionFreshInstancesGauge.addCallback((result) => {
  withActiveCollectorSnapshot('revision_lag', revisionLagSnapshot, (snapshot) => {
    const attributes = buildRevisionFreshAttributes({ domain: snapshot.domain });
    if (!attributes['enterprise.domain']) return;
    result.observe(snapshot.freshInstances, attributes);
  });
});

const snapshotForCollector = (collector: EnterpriseOperationalCollector) =>
  collector === 'job_backlog' ? jobBacklogSnapshot : revisionLagSnapshot;

operationalSnapshotReadyGauge.addCallback((result) => {
  for (const collector of activeOperationalCollectors) {
    result.observe(
      Number(Boolean(snapshotForCollector(collector))),
      buildOperationalCollectorAttributes({ collector }),
    );
  }
});

operationalSnapshotAgeGauge.addCallback((result) => {
  const now = Date.now();
  for (const collector of activeOperationalCollectors) {
    const snapshot = snapshotForCollector(collector);
    if (!snapshot) continue;
    result.observe(
      Math.max(0, (now - snapshot.collectedAtMs) / 1000),
      buildOperationalCollectorAttributes({ collector }),
    );
  }
});

operationalCollectorEnabledGauge.addCallback((result) => {
  // Once the operational runtime has configured collectors, emit 0/1 for every known
  // collector so disabled optional collectors are explicit (not absent).
  if (!operationalCollectorsConfigured) return;
  for (const collector of ENTERPRISE_OPERATIONAL_COLLECTORS) {
    result.observe(
      Number(activeOperationalCollectors.has(collector)),
      buildOperationalCollectorAttributes({ collector }),
    );
  }
});

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

export const recordSsrfDenialMetric = (input: SsrfDenialMetricAttributes): void => {
  ssrfDenialCounter.add(1, buildSsrfDenialAttributes(input));
};

export const recordOidcLoginMetric = (input: OidcLoginMetricAttributes): void => {
  const attributes = buildOidcLoginAttributes(input);
  if (!attributes['enterprise.outcome'] || !attributes['enterprise.stage']) return;
  oidcLoginCounter.add(1, attributes);
};

export const recordAgentMaterializationMetric = (
  input: AgentMaterializationMetricAttributes & { durationMs: number },
): void => {
  const attributes = buildAgentMaterializationAttributes(input);
  agentMaterializationCounter.add(1, attributes);
  agentMaterializationDuration.record(boundedDuration(input.durationMs), attributes);
};

export const recordOperationalCollectionMetric = (
  input: OperationalCollectionMetricAttributes & { durationMs: number },
): void => {
  const attributes = buildOperationalCollectionAttributes(input);
  if (!attributes['enterprise.collector'] || !attributes['enterprise.outcome']) return;
  operationalCollectionCounter.add(1, attributes);
  operationalCollectionDuration.record(boundedDuration(input.durationMs), attributes);
};

export const resetEnterpriseOperationalMetricsForTest = (): void => {
  activeOperationalCollectors.clear();
  operationalCollectorsConfigured = false;
  jobBacklogSnapshot = null;
  revisionLagSnapshot = null;
};
