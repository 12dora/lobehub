/**
 * Test-only in-memory metric sink for managed-resource guard unit tests.
 * Production uses EnterpriseManagedResourceGuardMetricSink.
 */
import debug from 'debug';

import type {
  ManagedResourceGuardMetric,
  ManagedResourceGuardMetricSink,
} from '../managedResourceGuardMetrics';

const log = debug('lobe-server:managed-resource-guard');

export class InMemoryManagedResourceGuardMetricSink implements ManagedResourceGuardMetricSink {
  private readonly counters = new Map<string, number>();

  increment = (metric: ManagedResourceGuardMetric): void => {
    const key = [
      metric.resource,
      metric.procedure,
      metric.classification,
      metric.mode,
      metric.outcome,
    ].join('|');
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    log(
      'resource=%s procedure=%s classification=%s mode=%s outcome=%s',
      metric.resource,
      metric.procedure,
      metric.classification,
      metric.mode,
      metric.outcome,
    );
  };

  snapshot = (): Readonly<Record<string, number>> => Object.fromEntries(this.counters);

  reset = (): void => this.counters.clear();
}
