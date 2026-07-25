import type { ManagedResourceKind } from '@/const/platform/managedResources';

import type { ManagedMutationClassification } from '../guards/managedResourceMutationRegistry';
import { observeEnterprisePlatformEvent } from '../observability';

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

const metricSink: ManagedResourceGuardMetricSink = new EnterpriseManagedResourceGuardMetricSink();

export const getManagedResourceGuardMetricSink = (): ManagedResourceGuardMetricSink => metricSink;
