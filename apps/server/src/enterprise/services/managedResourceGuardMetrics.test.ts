import { afterEach, describe, expect, it } from 'vitest';

import type { EnterpriseObservabilityEvent } from '../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../observability';
import {
  EnterpriseManagedResourceGuardMetricSink,
  InMemoryManagedResourceGuardMetricSink,
} from './managedResourceGuardMetrics';

afterEach(() => {
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
});

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

  it('adapts the default metric shape without emitting procedure labels', () => {
    const events: EnterpriseObservabilityEvent[] = [];
    setEnterprisePlatformObserverForTest({ record: (event) => events.push(event) });
    setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
    const sink = new EnterpriseManagedResourceGuardMetricSink();
    sink.increment({
      classification: 'input-sensitive',
      mode: 'enforced',
      outcome: 'denied',
      procedure: 'raw.procedure.identifier',
      resource: 'skills',
    });
    sink.increment({
      classification: 'deny',
      mode: 'observe',
      outcome: 'would_deny',
      procedure: 'raw.procedure.identifier',
      resource: 'aiProviders',
    });
    sink.increment({
      classification: 'deny',
      mode: 'enforced',
      outcome: 'catalog_not_ready',
      procedure: 'raw.procedure.identifier',
      resource: 'connectors',
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          classification: 'input-sensitive',
          mode: 'enforced',
          outcome: 'denied',
          resource: 'skills',
          type: 'guard_decision',
        },
        expect.objectContaining({ outcome: 'would_deny' }),
        expect.objectContaining({ outcome: 'catalog_not_ready' }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('procedure');
  });
});
