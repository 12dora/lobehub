import { describe, expect, it } from 'vitest';

import {
  assertExactAccessNotGranted,
  assertExactManagedResourceDenied,
  assertExactPermissionDenied,
  assertSafeProjection,
  extractBatchData,
  extractTrpcErrorMessage,
  extractTrpcErrorParts,
} from './trpc';

const validStatus = {
  build: { gitSha: 'abcdef1', version: '2.0.0' },
  dependencies: {
    database: { errorCategory: null, status: 'healthy' },
    keyManagement: { errorCategory: null, status: 'healthy' },
    mail: { errorCategory: null, status: 'disabled' },
    objectStorage: { errorCategory: null, status: 'unknown' },
    redis: { errorCategory: null, status: 'healthy' },
  },
  domains: [],
  featureFlags: {
    databaseOidc: true,
    managedAgents: true,
    managedAi: true,
    managedConnectors: true,
    managedSkills: true,
    platformAdmin: true,
    runtimeBranding: true,
    settingsPolicy: true,
  },
  instanceStatus: { errorCategory: null, status: 'healthy' },
  jobs: {
    active: 0,
    completed: 0,
    errorCategory: null,
    failed: 0,
    status: 'healthy',
    total: 0,
  },
  oidc: {
    activeRevision: null,
    configured: false,
    pendingRestart: false,
    source: 'disabled',
    status: 'disabled',
  },
  recentPublishFailures: {
    count: 0,
    errorCategory: null,
    items: [],
    status: 'healthy',
  },
  snapshotAt: '2026-07-20T00:01:00.000Z',
};

describe('trpc helpers', () => {
  it('extracts batch data and fails on error envelopes', () => {
    expect(extractBatchData([{ result: { data: { json: { baseRevision: 3 } } } }])).toEqual({
      baseRevision: 3,
    });
    expect(() => extractBatchData([{ error: { json: { message: 'FORBIDDEN' } } }])).toThrow(
      /error/,
    );
  });

  it('parses enterprise error parts from batch errors', () => {
    expect(
      extractTrpcErrorMessage([
        {
          error: {
            json: {
              data: {
                code: 'FORBIDDEN',
                errorData: { code: 'PLATFORM_PERMISSION_DENIED' },
              },
              message: 'PLATFORM_PERMISSION_DENIED',
            },
          },
        },
      ]),
    ).toBe('PLATFORM_PERMISSION_DENIED');
    expect(
      extractTrpcErrorParts([
        {
          error: {
            json: {
              data: {
                code: 'FORBIDDEN',
                errorData: { code: 'PLATFORM_PERMISSION_DENIED' },
              },
              message: 'PLATFORM_PERMISSION_DENIED',
            },
          },
        },
      ]),
    ).toEqual({
      enterpriseCode: 'PLATFORM_PERMISSION_DENIED',
      message: 'PLATFORM_PERMISSION_DENIED',
      trpcCode: 'FORBIDDEN',
    });
  });

  it('requires exact 403 + FORBIDDEN + PLATFORM_PERMISSION_DENIED', () => {
    expect(() =>
      assertExactPermissionDenied({
        json: [
          {
            error: {
              json: {
                data: {
                  code: 'FORBIDDEN',
                  errorData: { code: 'PLATFORM_PERMISSION_DENIED' },
                },
                message: 'PLATFORM_PERMISSION_DENIED',
              },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'PLATFORM_PERMISSION_DENIED',
      }),
    ).not.toThrow();

    // Counterexample: HTTP 403 + FORBIDDEN tRPC but unrelated enterprise code
    expect(() =>
      assertExactPermissionDenied({
        json: [
          {
            error: {
              json: {
                data: { code: 'FORBIDDEN', errorData: { code: 'PLATFORM_FEATURE_DISABLED' } },
                message: 'PLATFORM_FEATURE_DISABLED',
              },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'PLATFORM_FEATURE_DISABLED',
      }),
    ).toThrow(/PLATFORM_PERMISSION_DENIED/);

    // Counterexample: bare FORBIDDEN message without enterprise code
    expect(() =>
      assertExactPermissionDenied({
        json: [
          {
            error: {
              json: { data: { code: 'FORBIDDEN' }, message: 'FORBIDDEN' },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'FORBIDDEN',
      }),
    ).toThrow(/PLATFORM_PERMISSION_DENIED/);

    expect(() =>
      assertExactPermissionDenied({
        json: null,
        ok: false,
        status: 500,
        text: 'INTERNAL',
      }),
    ).toThrow(/403/);
  });

  it('maps legacy access-not-granted helper to permission denial', () => {
    expect(() =>
      assertExactAccessNotGranted({
        json: [
          {
            error: {
              json: {
                data: {
                  code: 'FORBIDDEN',
                  errorData: { code: 'PLATFORM_PERMISSION_DENIED' },
                },
                message: 'PLATFORM_PERMISSION_DENIED',
              },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'PLATFORM_PERMISSION_DENIED',
      }),
    ).not.toThrow();
  });

  it('requires exact RESOURCE_MANAGED_BY_PLATFORM for managed denial', () => {
    expect(() =>
      assertExactManagedResourceDenied({
        json: [
          {
            error: {
              json: {
                data: {
                  code: 'FORBIDDEN',
                  errorData: { code: 'RESOURCE_MANAGED_BY_PLATFORM' },
                },
                message: 'RESOURCE_MANAGED_BY_PLATFORM',
              },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'RESOURCE_MANAGED_BY_PLATFORM',
      }),
    ).not.toThrow();

    // substring-only body is not enough without exact enterprise code
    expect(() =>
      assertExactManagedResourceDenied({
        json: [
          {
            error: {
              json: {
                data: { code: 'FORBIDDEN' },
                message: 'something RESOURCE_MANAGED_BY_PLATFORM extra',
              },
            },
          },
        ],
        ok: false,
        status: 403,
        text: 'something RESOURCE_MANAGED_BY_PLATFORM extra',
      }),
    ).toThrow(/RESOURCE_MANAGED_BY_PLATFORM exactly/);
  });

  it('strict hierarchical DTO rejects wrong-path keys and nested credentials', () => {
    expect(() => assertSafeProjection(validStatus)).not.toThrow();

    // Nested redis.token must fail (flat allowlist used to accept "token")
    expect(() =>
      assertSafeProjection({
        ...validStatus,
        dependencies: {
          ...validStatus.dependencies,
          redis: {
            errorCategory: null,
            status: 'healthy',
            token: 'redis://secret@host:6379',
          },
        },
      }),
    ).toThrow(/strict DTO|unrecognized|token/i);

    // Wrong-path top-level secret
    expect(() =>
      assertSafeProjection({
        ...validStatus,
        databaseUrl: 'postgres://secret',
      }),
    ).toThrow();

    // Extra dependency field
    expect(() =>
      assertSafeProjection({
        ...validStatus,
        dependencies: {
          ...validStatus.dependencies,
          redis: {
            errorCategory: null,
            password: 'x',
            status: 'healthy',
          },
        },
      }),
    ).toThrow();
  });
});
