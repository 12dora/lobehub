// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  adminSecretRotationCancelInputSchema,
  adminSecretRotationJobSchema,
  adminSecretRotationStartInputSchema,
} from './adminSecretRotation';

describe('admin secret rotation contracts', () => {
  it('keeps the external artifact gate and historical-key removal denial explicit', () => {
    const parsed = adminSecretRotationJobSchema.parse({
      counts: {
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
      },
      jobId: 'job-safe',
      revision: 0,
      status: 'pending',
      targetKeyId: 'vault:next',
      updatedAt: new Date(),
    });
    expect(parsed.counts.historicalKeyRemovalReady).toBe(false);
    expect(parsed.counts.externalArtifactGate).toBe('identity_lkg_instance_convergence_required');
  });

  it('rejects secret-like reasons, invalid request ids, and terminal cancel statuses', () => {
    expect(() =>
      adminSecretRotationStartInputSchema.parse({
        reason: 'Authorization: Bearer leaked-value',
        requestId: 'not-a-uuid',
        targetKeyId: 'vault:next',
      }),
    ).toThrow();
    expect(() =>
      adminSecretRotationCancelInputSchema.parse({
        expectedRevision: 0,
        expectedStatus: 'succeeded',
        jobId: 'job-safe',
        reason: 'cancel safely',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow();
  });
});
