import debug from 'debug';

import type { ManagedResourceKind } from '@/const/platform/managedResources';

import type { ManagedMutationClassification } from '../guards/managedResourceMutationRegistry';
import { observeEnterprisePlatformEvent } from '../observability';

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

export class EnterpriseManagedResourceGuardMetricSink implements ManagedResourceGuardMetricSink {
  increment = (metric: ManagedResourceGuardMetric): void => {
    if (metric.classification !== 'deny' && metric.classification !== 'input-sensitive') return;
    observeEnterprisePlatformEvent({
      classification: metric.classification,
      mode: metric.mode,
      outcome: metric.outcome,
      resource: metric.resource,
      type: 'guard_decision',
    });
  };
}

let metricSink: ManagedResourceGuardMetricSink = new EnterpriseManagedResourceGuardMetricSink();

export const getManagedResourceGuardMetricSink = (): ManagedResourceGuardMetricSink => metricSink;

export const setManagedResourceGuardMetricSink = (
  sink: ManagedResourceGuardMetricSink | null,
): void => {
  metricSink = sink ?? new EnterpriseManagedResourceGuardMetricSink();
};
