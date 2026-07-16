import { describe, expect, it } from 'vitest';

import { InMemoryManagedResourceGuardMetricSink } from './managedResourceGuardMetrics';

describe('InMemoryManagedResourceGuardMetricSink', () => {
  it('counts only bounded, non-PII guard dimensions', () => {
    const sink = new InMemoryManagedResourceGuardMetricSink();
    sink.increment({
      classification: 'deny',
      mode: 'observe',
      outcome: 'would_deny',
      procedure: 'aiProvider.createAiProvider',
      resource: 'aiProviders',
    });
    sink.increment({
      classification: 'deny',
      mode: 'observe',
      outcome: 'would_deny',
      procedure: 'aiProvider.createAiProvider',
      resource: 'aiProviders',
    });

    const snapshot = sink.snapshot();
    expect(snapshot).toEqual({
      'aiProviders|aiProvider.createAiProvider|deny|observe|would_deny': 2,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/user|token|credential|payload|secret/i);
    sink.reset();
    expect(sink.snapshot()).toEqual({});
  });
});
