// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOOP_ENTERPRISE_PLATFORM_OBSERVER,
  observeEnterprisePlatformEvent,
  setEnterprisePlatformObserverForTest,
} from './observer';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterpriseStructuredLoggerForTest,
} from './structuredLogger';
import type { EnterpriseObservabilityEvent } from './types';

const mocks = vi.hoisted(() => ({ debugLog: vi.fn() }));

vi.mock('debug', () => ({ default: () => mocks.debugLog }));

beforeEach(() => {
  vi.clearAllMocks();
  setEnterprisePlatformObserverForTest(NOOP_ENTERPRISE_PLATFORM_OBSERVER);
  setEnterpriseStructuredLoggerForTest(null);
});

afterEach(() => {
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
});

describe('enterprise observability boundary', () => {
  it('normalizes events and drops raw identifiers and secret-bearing extras', () => {
    const events: EnterpriseObservabilityEvent[] = [];
    const logs: EnterpriseObservabilityEvent[] = [];
    setEnterprisePlatformObserverForTest({ record: (event) => events.push(event) });
    setEnterpriseStructuredLoggerForTest({ log: (event) => logs.push(event) });

    observeEnterprisePlatformEvent({
      domain: 'branding',
      durationMs: 3,
      errorClass: 'raw-secret-error',
      operation: 'publish',
      outcome: 'failure',
      requestId: 'request-raw',
      resourceId: 'resource-raw',
      secret: 'credential-raw',
      type: 'config_publish',
      userId: 'user-raw',
    } as never);

    expect(events).toEqual([
      {
        domain: 'branding',
        durationMs: 3,
        errorClass: 'UnexpectedError',
        operation: 'publish',
        outcome: 'failure',
        type: 'config_publish',
      },
    ]);
    expect(logs).toEqual(events);
    expect(JSON.stringify({ events, logs })).not.toContain('raw');
    expect(JSON.stringify({ events, logs })).not.toContain('credential');
  });

  it('keeps observer and logger failures best-effort without reflecting payloads', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer raw detail');
      },
    });
    setEnterpriseStructuredLoggerForTest({
      log: () => {
        throw new Error('logger raw detail');
      },
    });

    expect(() =>
      observeEnterprisePlatformEvent({
        backend: 'redis',
        errorClass: 'UnavailableError',
        outcome: 'error',
        type: 'invalidation',
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw detail');
    consoleError.mockRestore();
  });

  it('logs only important failures and degraded states with %O', () => {
    setEnterpriseStructuredLoggerForTest(null);
    for (const event of [
      {
        domain: 'branding',
        operation: 'request',
        outcome: 'hit',
        type: 'cache',
      },
      {
        durationMs: 1,
        operation: 'tick',
        outcome: 'success',
        type: 'instance_heartbeat',
      },
      {
        domain: 'branding',
        durationMs: 2,
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ] satisfies EnterpriseObservabilityEvent[]) {
      observeEnterprisePlatformEvent(event);
    }
    expect(mocks.debugLog).not.toHaveBeenCalled();

    observeEnterprisePlatformEvent({
      domain: 'skill_catalog',
      errorClass: 'UnavailableError',
      operation: 'load',
      outcome: 'load_failure',
      type: 'cache',
    });
    expect(mocks.debugLog).toHaveBeenCalledWith(
      'enterprise event %O',
      expect.objectContaining({ outcome: 'load_failure' }),
    );
  });

  it('exports explicit no-op seams', () => {
    setEnterprisePlatformObserverForTest(NOOP_ENTERPRISE_PLATFORM_OBSERVER);
    setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
    expect(() =>
      observeEnterprisePlatformEvent({
        classification: 'deny',
        mode: 'enforced',
        outcome: 'denied',
        resource: 'skills',
        type: 'guard_decision',
      }),
    ).not.toThrow();
  });
});
