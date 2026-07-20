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
import { classifyEnterpriseError } from './types';

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

  it('normalizes security and identity events without high-cardinality fields', () => {
    const events: EnterpriseObservabilityEvent[] = [];
    setEnterprisePlatformObserverForTest({ record: (event) => events.push(event) });
    const extras = {
      checksum: 'checksum-raw',
      host: 'host-raw',
      ip: 'ip-raw',
      provider: 'provider-raw',
      resource: 'resource-raw',
      subject: 'subject-raw',
      url: 'url-raw',
      user: 'user-raw',
    };

    observeEnterprisePlatformEvent({
      category: 'metadata_endpoint',
      type: 'ssrf_denial',
      ...extras,
    } as never);
    observeEnterprisePlatformEvent({
      failureCategory: 'subject_mismatch',
      outcome: 'success',
      stage: 'authenticated',
      type: 'oidc_login',
      ...extras,
    } as never);
    observeEnterprisePlatformEvent({
      failureCategory: 'subject_mismatch',
      outcome: 'failure',
      stage: 'userinfo',
      type: 'oidc_login',
      ...extras,
    } as never);
    observeEnterprisePlatformEvent({
      durationMs: -3,
      outcome: 'race_reused',
      type: 'agent_materialization',
      ...extras,
    } as never);

    expect(events).toEqual([
      { category: 'metadata_endpoint', type: 'ssrf_denial' },
      { outcome: 'success', stage: 'authenticated', type: 'oidc_login' },
      {
        failureCategory: 'subject_mismatch',
        outcome: 'failure',
        stage: 'userinfo',
        type: 'oidc_login',
      },
      { durationMs: 0, outcome: 'race_reused', type: 'agent_materialization' },
    ]);
    expect(JSON.stringify(events)).not.toContain('raw');
  });

  it('rejects events containing values outside the runtime allowlists', () => {
    const record = vi.fn();
    const log = vi.fn();
    setEnterprisePlatformObserverForTest({ record });
    setEnterpriseStructuredLoggerForTest({ log });

    for (const event of [
      { category: 'http://metadata.local', type: 'ssrf_denial' },
      { outcome: 'failure', stage: 'provider-id', type: 'oidc_login' },
      {
        failureCategory: 'subject-id',
        outcome: 'failure',
        stage: 'userinfo',
        type: 'oidc_login',
      },
      { durationMs: 1, outcome: 'agent-id', type: 'agent_materialization' },
      {
        domain: 'tenant-id',
        durationMs: 1,
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ]) {
      observeEnterprisePlatformEvent(event as never);
    }

    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
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
        category: 'secret_redirect',
        type: 'ssrf_denial',
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
      {
        outcome: 'success',
        stage: 'authenticated',
        type: 'oidc_login',
      },
      {
        durationMs: 1,
        outcome: 'created',
        type: 'agent_materialization',
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

    observeEnterprisePlatformEvent({
      failureCategory: 'network_failure',
      outcome: 'failure',
      stage: 'token_exchange',
      type: 'oidc_login',
    });
    observeEnterprisePlatformEvent({
      durationMs: 2,
      outcome: 'failure',
      type: 'agent_materialization',
    });
    observeEnterprisePlatformEvent({ category: 'allowlist_denied', type: 'ssrf_denial' });
    expect(mocks.debugLog).toHaveBeenCalledTimes(4);
  });

  it('classifies only fixed error codes without exposing the raw code', () => {
    const timeout = Object.assign(new Error('secret message'), { code: 'ETIMEDOUT' });
    const unknown = Object.assign(new Error('secret message'), { code: 'TENANT_ERROR_123' });

    expect(classifyEnterpriseError(timeout)).toBe('TimeoutError');
    expect(classifyEnterpriseError(unknown)).toBe('UnexpectedError');
    expect(
      JSON.stringify([classifyEnterpriseError(timeout), classifyEnterpriseError(unknown)]),
    ).not.toContain('TENANT_ERROR_123');
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
