import debug from 'debug';

import type { ManagedResourceKind } from '@/const/platform/managedResources';

import type { ManagedMutationClassification } from '../guards/managedResourceMutationRegistry';

const log = debug('lobe-server:managed-resource-guard');

export type ManagedResourceGuardMetricOutcome = 'would_deny' | 'denied' | 'catalog_not_ready';

export interface ManagedResourceGuardMetric {
  classification: ManagedMutationClassification;
  mode: 'observe' | 'ui-only' | 'enforced';
  outcome: ManagedResourceGuardMetricOutcome;
  procedure: string;
  resource: ManagedResourceKind;
}

export interface ManagedResourceGuardMetricSink {
  increment: (metric: ManagedResourceGuardMetric) => void;
}

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

let metricSink: ManagedResourceGuardMetricSink = new InMemoryManagedResourceGuardMetricSink();

export const getManagedResourceGuardMetricSink = (): ManagedResourceGuardMetricSink => metricSink;

export const setManagedResourceGuardMetricSink = (
  sink: ManagedResourceGuardMetricSink | null,
): void => {
  metricSink = sink ?? new InMemoryManagedResourceGuardMetricSink();
};
