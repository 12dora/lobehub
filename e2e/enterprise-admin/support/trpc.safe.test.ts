import { describe, expect, it } from 'vitest';

import {
  ADMIN_SYSTEM_STATUS_ALLOWED_KEYS,
  assertExactManagedResourceDenied,
  assertExactPermissionDenied,
  assertSafeProjection,
  extractBatchData,
  extractTrpcErrorMessage,
} from './trpc';

describe('trpc helpers', () => {
  it('extracts batch data and fails on error envelopes', () => {
    expect(extractBatchData([{ result: { data: { json: { baseRevision: 3 } } } }])).toEqual({
      baseRevision: 3,
    });
    expect(() => extractBatchData([{ error: { json: { message: 'FORBIDDEN' } } }])).toThrow(
      /error/,
    );
  });

  it('parses enterprise error messages from batch errors', () => {
    expect(
      extractTrpcErrorMessage([
        { error: { json: { data: { code: 'FORBIDDEN' }, message: 'PLATFORM_PERMISSION_DENIED' } } },
      ]),
    ).toBe('PLATFORM_PERMISSION_DENIED');
  });

  it('requires exact 403 permission denial', () => {
    expect(() =>
      assertExactPermissionDenied({
        json: [
          {
            error: { json: { data: { code: 'FORBIDDEN' }, message: 'PLATFORM_PERMISSION_DENIED' } },
          },
        ],
        ok: false,
        status: 403,
        text: 'PLATFORM_PERMISSION_DENIED',
      }),
    ).not.toThrow();
    expect(() =>
      assertExactPermissionDenied({
        json: null,
        ok: false,
        status: 500,
        text: 'INTERNAL',
      }),
    ).toThrow(/403/);
  });

  it('requires RESOURCE_MANAGED_BY_PLATFORM for managed denial', () => {
    expect(() =>
      assertExactManagedResourceDenied({
        json: [{ error: { json: { message: 'RESOURCE_MANAGED_BY_PLATFORM' } } }],
        ok: false,
        status: 403,
        text: 'RESOURCE_MANAGED_BY_PLATFORM',
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys and secret substrings in safe projections', () => {
    expect(() =>
      assertSafeProjection(
        { build: { version: '1.0.0' }, featureFlags: { platformAdmin: true } },
        { allowedKeys: ADMIN_SYSTEM_STATUS_ALLOWED_KEYS },
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeProjection({ secretToken: 'x' }, { allowedKeys: ADMIN_SYSTEM_STATUS_ALLOWED_KEYS }),
    ).toThrow(/unknown key/);
    expect(() =>
      assertSafeProjection(
        { build: { version: 'postgres:postgres@host' } },
        { allowedKeys: ADMIN_SYSTEM_STATUS_ALLOWED_KEYS },
      ),
    ).toThrow(/forbidden substring/);
  });
});
