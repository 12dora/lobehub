// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeEvent } from './normalizeEvent';
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
    observeEnterprisePlatformEvent({
      collector: 'revision_lag',
      durationMs: Number.NaN,
      errorClass: 'tenant-error',
      outcome: 'failure',
      type: 'operational_collection',
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
      {
        collector: 'revision_lag',
        durationMs: 0,
        errorClass: 'UnexpectedError',
        outcome: 'failure',
        type: 'operational_collection',
      },
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
        collector: 'job-id',
        durationMs: 1,
        outcome: 'failure',
        type: 'operational_collection',
      },
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
      {
        collector: 'job_backlog',
        durationMs: 1,
        outcome: 'success',
        type: 'operational_collection',
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
    observeEnterprisePlatformEvent({
      collector: 'job_backlog',
      durationMs: 2,
      errorClass: 'UnavailableError',
      outcome: 'failure',
      type: 'operational_collection',
    });
    expect(mocks.debugLog).toHaveBeenCalledTimes(5);
  });

  it('classifies only fixed error codes without exposing the raw code', () => {
    const timeout = Object.assign(new Error('secret message'), { code: 'ETIMEDOUT' });
    const unknown = Object.assign(new Error('secret message'), { code: 'TENANT_ERROR_123' });
    const inherited = new Error('secret message');
    Object.setPrototypeOf(
      inherited,
      Object.create(Error.prototype, { code: { value: 'ETIMEDOUT' } }),
    );

    expect(classifyEnterpriseError(timeout)).toBe('TimeoutError');
    expect(classifyEnterpriseError(unknown)).toBe('UnexpectedError');
    expect(classifyEnterpriseError(inherited)).toBe('UnexpectedError');
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(classifyEnterpriseError(Object.assign(new Error('secret message'), { code }))).toBe(
        'UnexpectedError',
      );
    }
    expect(
      JSON.stringify([
        classifyEnterpriseError(timeout),
        classifyEnterpriseError(unknown),
        classifyEnterpriseError(inherited),
      ]),
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

  it('normalizes each event type for a valid payload and drops an out-of-allowlist field', () => {
    const cases: Array<{
      expected: EnterpriseObservabilityEvent | null;
      input: Record<string, unknown>;
      name: string;
    }> = [
      {
        expected: {
          domain: 'branding',
          durationMs: 3,
          operation: 'publish',
          outcome: 'success',
          type: 'config_publish',
        },
        input: {
          domain: 'branding',
          durationMs: 3,
          operation: 'publish',
          outcome: 'success',
          type: 'config_publish',
        },
        name: 'config_publish valid',
      },
      {
        expected: null,
        input: {
          domain: 'tenant-id',
          durationMs: 1,
          operation: 'publish',
          outcome: 'success',
          type: 'config_publish',
        },
        name: 'config_publish out-of-allowlist domain',
      },
      {
        expected: { backend: 'memory', outcome: 'success', type: 'invalidation' },
        input: { backend: 'memory', outcome: 'success', type: 'invalidation' },
        name: 'invalidation valid',
      },
      {
        expected: null,
        input: { backend: 's3', outcome: 'success', type: 'invalidation' },
        name: 'invalidation out-of-allowlist backend',
      },
      {
        expected: {
          domain: 'branding',
          operation: 'load',
          outcome: 'loaded',
          type: 'cache',
        },
        input: { domain: 'branding', operation: 'load', outcome: 'loaded', type: 'cache' },
        name: 'cache load valid',
      },
      {
        expected: {
          domain: 'branding',
          operation: 'epoch',
          outcome: 'success',
          type: 'cache',
        },
        input: { domain: 'branding', operation: 'epoch', outcome: 'success', type: 'cache' },
        name: 'cache epoch valid',
      },
      {
        expected: {
          domain: 'branding',
          operation: 'request',
          outcome: 'hit',
          type: 'cache',
        },
        input: { domain: 'branding', operation: 'request', outcome: 'hit', type: 'cache' },
        name: 'cache request valid',
      },
      {
        expected: null,
        input: { domain: 'tenant-id', operation: 'request', outcome: 'hit', type: 'cache' },
        name: 'cache out-of-allowlist domain',
      },
      {
        expected: {
          classification: 'deny',
          mode: 'enforced',
          outcome: 'denied',
          resource: 'skills',
          type: 'guard_decision',
        },
        input: {
          classification: 'deny',
          mode: 'enforced',
          outcome: 'denied',
          resource: 'skills',
          type: 'guard_decision',
        },
        name: 'guard_decision valid',
      },
      {
        expected: null,
        input: {
          classification: 'allow',
          mode: 'enforced',
          outcome: 'denied',
          resource: 'skills',
          type: 'guard_decision',
        },
        name: 'guard_decision out-of-allowlist classification',
      },
      {
        expected: {
          durationMs: 1,
          operation: 'tick',
          outcome: 'success',
          type: 'instance_heartbeat',
        },
        input: {
          durationMs: 1,
          operation: 'tick',
          outcome: 'success',
          type: 'instance_heartbeat',
        },
        name: 'instance_heartbeat valid',
      },
      {
        expected: null,
        input: {
          durationMs: 1,
          operation: 'probe',
          outcome: 'success',
          type: 'instance_heartbeat',
        },
        name: 'instance_heartbeat out-of-allowlist operation',
      },
      {
        expected: { category: 'metadata_endpoint', type: 'ssrf_denial' },
        input: { category: 'metadata_endpoint', type: 'ssrf_denial' },
        name: 'ssrf_denial valid',
      },
      {
        expected: null,
        input: { category: 'http://metadata.local', type: 'ssrf_denial' },
        name: 'ssrf_denial out-of-allowlist category',
      },
      {
        expected: { outcome: 'success', stage: 'authenticated', type: 'oidc_login' },
        input: { outcome: 'success', stage: 'authenticated', type: 'oidc_login' },
        name: 'oidc_login success valid',
      },
      {
        expected: {
          failureCategory: 'subject_mismatch',
          outcome: 'failure',
          stage: 'userinfo',
          type: 'oidc_login',
        },
        input: {
          failureCategory: 'subject_mismatch',
          outcome: 'failure',
          stage: 'userinfo',
          type: 'oidc_login',
        },
        name: 'oidc_login failure valid',
      },
      {
        expected: null,
        input: { outcome: 'success', stage: 'provider-id', type: 'oidc_login' },
        name: 'oidc_login out-of-allowlist stage',
      },
      {
        expected: { durationMs: 1, outcome: 'created', type: 'agent_materialization' },
        input: { durationMs: 1, outcome: 'created', type: 'agent_materialization' },
        name: 'agent_materialization valid',
      },
      {
        expected: null,
        input: { durationMs: 1, outcome: 'agent-id', type: 'agent_materialization' },
        name: 'agent_materialization out-of-allowlist outcome',
      },
      {
        expected: {
          collector: 'job_backlog',
          durationMs: 1,
          outcome: 'success',
          type: 'operational_collection',
        },
        input: {
          collector: 'job_backlog',
          durationMs: 1,
          outcome: 'success',
          type: 'operational_collection',
        },
        name: 'operational_collection valid',
      },
      {
        expected: null,
        input: {
          collector: 'job-id',
          durationMs: 1,
          outcome: 'success',
          type: 'operational_collection',
        },
        name: 'operational_collection out-of-allowlist collector',
      },
    ];

    for (const row of cases) {
      expect(normalizeEvent(row.input as EnterpriseObservabilityEvent), row.name).toEqual(
        row.expected,
      );
    }
  });
});
