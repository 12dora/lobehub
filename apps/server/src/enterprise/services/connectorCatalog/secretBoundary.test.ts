import { describe, expect, it } from 'vitest';

import {
  assertConnectorPersistentTextSafe,
  collectConnectorSecretLeaves,
  fixedConnectorOperationResult,
} from './secretBoundary';

describe('connector secret boundary', () => {
  it('collects current and replacement shared/OAuth secret leaves without exposing them', () => {
    const leaves = collectConnectorSecretLeaves(
      { apiKey: 'old-arbitrary-value', headers: { 'X-Service-Key': 'old-header-value' } },
      { clientSecret: 'new-client-value' },
      { accessToken: 'user-access-value', refreshToken: 'user-refresh-value' },
    );
    expect(leaves).toEqual(
      new Set([
        'old-arbitrary-value',
        'old-header-value',
        'new-client-value',
        'user-access-value',
        'user-refresh-value',
      ]),
    );
    for (const secret of leaves) {
      expect(() =>
        assertConnectorPersistentTextSafe(`reason contains ${secret}`, leaves),
      ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
  });

  it('uses fixed safe operation messages and never reflects an upstream error/body', () => {
    const upstream = 'Authorization: Bearer arbitrary-upstream-secret';
    const result = fixedConnectorOperationResult('failure', 'auth');
    expect(result).toEqual({
      errorCategory: 'auth',
      sanitizedMessage: 'connector.operation_failed',
      status: 'failure',
    });
    expect(JSON.stringify(result)).not.toContain(upstream);
    expect(() => assertConnectorPersistentTextSafe(upstream, new Set())).toThrow();
    expect(() =>
      assertConnectorPersistentTextSafe(
        'upstream failed at https://user:password@example.test/private',
        new Set(),
      ),
    ).toThrowError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  });
});
