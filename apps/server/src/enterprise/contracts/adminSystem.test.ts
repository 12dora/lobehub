import { describe, expect, it } from 'vitest';

import {
  adminSystemCancelJobInputSchema,
  adminSystemGetJobsOutputSchema,
  adminSystemGetStatusOutputSchema,
  adminSystemRequestRestartOutputSchema,
} from './adminSystem';

describe('admin system restart acceptance output', () => {
  it('requires durable acceptance time and exact target revision evidence', () => {
    const accepted = {
      accepted: true,
      acceptedAt: new Date('2026-07-19T00:00:00Z'),
      convergenceDeadlineAt: new Date('2026-07-19T00:02:00Z'),
      duplicate: false,
      expectedIdentityRevision: 'a'.repeat(64),
      remainingMs: 120_000,
      requestId: '550e8400-e29b-41d4-a716-446655440056',
      serverNow: new Date('2026-07-19T00:00:00Z'),
      status: 'accepted',
    };
    expect(adminSystemRequestRestartOutputSchema.parse(accepted)).toEqual(accepted);
    const { acceptedAt: _acceptedAt, ...withoutAcceptedAt } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutAcceptedAt)).toThrow();
    const { expectedIdentityRevision: _revision, ...withoutRevision } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutRevision)).toThrow();
  });
});

describe('admin system operational contracts', () => {
  it('accepts only the fixed status inventory and rejects extra deployment details', () => {
    const status = {
      build: { gitSha: 'abcdef1', version: '2.0.0' },
      dependencies: Object.fromEntries(
        ['database', 'keyManagement', 'mail', 'objectStorage', 'redis'].map((key) => [
          key,
          { errorCategory: null, status: 'healthy' },
        ]),
      ),
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
      jobs: { active: 2, completed: 3, failed: 1, total: 6 },
      oidc: {
        activeRevision: 'a'.repeat(64),
        configured: true,
        pendingRestart: false,
        source: 'database',
        status: 'healthy',
      },
      recentPublishFailures: {
        count: 1,
        items: [
          {
            category: 'validation',
            domain: 'settings',
            occurredAt: new Date('2026-07-20T00:00:00Z'),
          },
        ],
      },
      snapshotAt: new Date('2026-07-20T00:01:00Z'),
    };

    expect(adminSystemGetStatusOutputSchema.parse(status)).toEqual(status);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({ ...status, databaseUrl: 'postgres://secret' })
        .success,
    ).toBe(false);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({
        ...status,
        build: { gitSha: 'not-a-sha', version: '2.0.0' },
      }).success,
    ).toBe(false);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({
        ...status,
        featureFlags: { ...status.featureFlags, arbitraryFlag: true },
      }).success,
    ).toBe(false);
  });

  it('keeps the job DTO strict and free of raw job payload fields', () => {
    const job = {
      attempt: 1,
      canCancel: false,
      canRetry: true,
      createdAt: new Date('2026-07-20T00:00:00Z'),
      errorCategory: 'operation_failed',
      failedCount: 2,
      finishedAt: new Date('2026-07-20T00:02:00Z'),
      jobId: 'pjob_1234567890abcdef',
      kind: 'agent_rollout',
      maxAttempts: 3,
      progress: { done: 8, total: 10 },
      revision: 2,
      startedAt: new Date('2026-07-20T00:01:00Z'),
      status: 'failed',
      updatedAt: new Date('2026-07-20T00:02:00Z'),
    };

    expect(adminSystemGetJobsOutputSchema.parse({ items: [job], nextCursor: null })).toEqual({
      items: [job],
      nextCursor: null,
    });
    for (const field of [
      'cursor',
      'idempotencyKey',
      'input',
      'lastError',
      'leaseOwner',
      'requestedBy',
      'resultSummary',
      'type',
    ]) {
      expect(
        adminSystemGetJobsOutputSchema.safeParse({
          items: [{ ...job, [field]: 'sensitive' }],
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
  });

  it('requires bounded intent evidence for job mutation inputs', () => {
    const input = {
      expectedRevision: 3,
      expectedStatus: 'running',
      jobId: 'pjob_1234567890abcdef',
      reason: 'operator cancelled stalled rollout',
      requestId: '550e8400-e29b-41d4-a716-446655440056',
    };
    expect(adminSystemCancelJobInputSchema.parse(input)).toEqual(input);
    expect(
      adminSystemCancelJobInputSchema.safeParse({ ...input, reason: 'Bearer secret-token' })
        .success,
    ).toBe(false);
    expect(
      adminSystemCancelJobInputSchema.safeParse({ ...input, expectedStatus: 'succeeded' }).success,
    ).toBe(false);
  });
});
