// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PLATFORM_SECRET_REWRAP_RESULT,
  platformSecretRewrapCursorSchema,
  platformSecretRewrapFailureInputSchema,
  platformSecretRewrapIdempotencyKey,
  platformSecretRewrapJobInputSchema,
  platformSecretRewrapResultSchema,
  platformSecretRewrapTargetKeyIdFromIdempotencyKey,
} from './contracts';

const requestId = '11111111-1111-4111-8111-111111111111';

describe('secret rewrap contracts', () => {
  it('accepts only the versioned parent control contract', () => {
    const input = {
      control: { phase: 'scan', revision: 0 },
      reason: 'rotate the active Vault key',
      requestId,
      schemaVersion: 1,
      targetKeyId: 'vault:2026-07',
    };
    expect(platformSecretRewrapJobInputSchema.parse(input)).toEqual(input);
    expect(
      platformSecretRewrapJobInputSchema.safeParse({ ...input, ciphertext: 'secret' }).success,
    ).toBe(false);
    expect(
      platformSecretRewrapJobInputSchema.safeParse({
        ...input,
        reason: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      }).success,
    ).toBe(false);
  });

  it('keeps cursor and failure ledger strict and bounded', () => {
    expect(
      platformSecretRewrapCursorSchema.parse({ domain: 'connector', lastId: 'secret-row_1' }),
    ).toEqual({ domain: 'connector', lastId: 'secret-row_1' });
    expect(
      platformSecretRewrapFailureInputSchema.safeParse({
        category: 'concurrent_change',
        domain: 'connector',
        parentJobId: 'parent-job',
        parentRevision: 2,
        requestId,
        rowId: 'secret-row_1',
        schemaVersion: 1,
        targetKeyId: 'vault:2026-07',
        upstreamError: 'must never persist',
      }).success,
    ).toBe(false);
    expect(
      platformSecretRewrapCursorSchema.safeParse({ domain: 'unknown', lastId: 'row' }).success,
    ).toBe(false);
  });

  it('exposes fixed aggregate-only result fields', () => {
    const parsed = platformSecretRewrapResultSchema.parse(EMPTY_PLATFORM_SECRET_REWRAP_RESULT);
    expect(parsed).toEqual({
      categories: {
        ciphertext_not_readable: 0,
        concurrent_change: 0,
        historical_key_unavailable: 0,
        invalid_ciphertext: 0,
      },
      examined: 0,
      externalArtifactGate: 'identity_lkg_instance_convergence_required',
      failed: 0,
      historicalKeyRemovalReady: false,
      noOp: 0,
      rotated: 0,
      schemaVersion: 1,
    });
    expect(
      platformSecretRewrapResultSchema.safeParse({ ...parsed, rowId: 'must-not-leak' }).success,
    ).toBe(false);
  });

  it('recovers targetKeyId from versioned and legacy rewrap idempotency keys', () => {
    expect(
      platformSecretRewrapTargetKeyIdFromIdempotencyKey(
        platformSecretRewrapIdempotencyKey('vault:2026-07'),
      ),
    ).toBe('vault:2026-07');
    expect(platformSecretRewrapTargetKeyIdFromIdempotencyKey('rewrap:vault:legacy-key')).toBe(
      'vault:legacy-key',
    );
    expect(platformSecretRewrapTargetKeyIdFromIdempotencyKey('other:not-a-rewrap')).toBeNull();
  });
});
