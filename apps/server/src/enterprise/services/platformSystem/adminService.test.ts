// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { adminSystemGetStatusOutputSchema } from '@/server/enterprise/contracts/adminSystem';

import { PlatformSystemAdminService } from './adminService';
import { PlatformSystemJobConflictError, PlatformSystemJobInvalidError } from './errors';

const db: LobeChatDatabase = await getTestDB();

const rolloutInput = (revision: number) => ({
  control: { phase: 'targets' as const, revision },
  snapshot: {
    agentId: 'pagt_agent',
    assignmentId: 'paas_assignment',
    previousVersionChecksum: null,
    previousVersionId: null,
    rollbackOfJobId: null,
    targetCutoff: '2026-07-20T00:00:00.000000Z',
    targetId: 'global',
    targetType: 'global' as const,
    targetVersionChecksum: 'a'.repeat(64),
    targetVersionId: 'pav_version',
    versionPolicy: 'latest_published' as const,
  },
});

const rewrapInput = (revision: number) => ({
  control: { phase: 'failed' as const, revision },
  reason: 'rotate platform secrets',
  requestId: '550e8400-e29b-41d4-a716-446655440056',
  schemaVersion: 1 as const,
  targetKeyId: 'vault-key-1',
});

afterEach(async () => {
  await db.delete(platformJobs);
  await db.delete(platformAuditLogs);
});

describe('PlatformSystemAdminService jobs', () => {
  it('projects only allowlisted operational fields and marks unsupported jobs read-only', async () => {
    await db.insert(platformJobs).values([
      {
        id: 'pjob_0000000000000001',
        idempotencyKey: 'system-list-rollout',
        input: { ...rolloutInput(4), rawSecret: 'never-return' },
        lastError: { endpoint: 'https://private.invalid', message: 'raw failure' },
        leaseOwner: 'private-worker',
        requestedBy: 'private-user',
        resultSummary: { failed: 3, raw: 'never-return' },
        status: 'failed',
        type: 'platform.agent.rollout.v1',
      },
      {
        id: 'pjob_0000000000000002',
        idempotencyKey: 'system-list-unknown',
        input: { token: 'never-return' },
        status: 'pending',
        type: 'future.platform.job.v1',
      },
      {
        id: 'pjob_0000000000000003',
        idempotencyKey: 'system-list-ledger',
        status: 'failed',
        type: 'platform.secret.rewrap.failure.v1',
      },
    ]);

    const result = await new PlatformSystemAdminService(db).getJobs({ limit: 50 });
    expect(result.items).toHaveLength(2);
    expect(result.items.find(({ kind }) => kind === 'agent_rollout')).toMatchObject({
      canCancel: false,
      canRetry: true,
      errorCategory: 'operation_failed',
      failedCount: 3,
      revision: 4,
    });
    expect(result.items.find(({ kind }) => kind === 'unknown')).toMatchObject({
      canCancel: false,
      canRetry: false,
      revision: null,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'rawSecret',
      'never-return',
      'private.invalid',
      'private-worker',
      'private-user',
      'idempotencyKey',
      'leaseOwner',
      'requestedBy',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('allows exactly one concurrent CAS cancellation and audits both outcomes', async () => {
    await db.insert(platformJobs).values({
      id: 'pjob_0000000000000010',
      idempotencyKey: 'system-cancel-race',
      input: rolloutInput(2),
      status: 'running',
      type: 'platform.agent.rollout.v1',
    });
    const service = new PlatformSystemAdminService(db);
    const intent = {
      expectedRevision: 2,
      expectedStatus: 'running' as const,
      jobId: 'pjob_0000000000000010',
      reason: 'cancel stalled rollout',
      requestId: '550e8400-e29b-41d4-a716-446655440057',
    };
    const outcomes = await Promise.allSettled([
      service.cancelJob('admin-1', intent),
      service.cancelJob('admin-1', intent),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({ reason: expect.any(PlatformSystemJobConflictError) });
    const [job] = await db.select().from(platformJobs).where(eq(platformJobs.id, intent.jobId));
    expect(job).toMatchObject({ status: 'cancelled' });
    expect((job?.input as ReturnType<typeof rolloutInput>).control.revision).toBe(3);
    const audits = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.system.jobs.cancel'));
    expect(audits.map(({ result }) => result).sort()).toEqual(['failure', 'success']);
    expect(audits.find(({ result }) => result === 'failure')?.afterDiff).toEqual({
      error: 'revision_conflict',
    });
  });

  it('rejects completed cancellation and secret rewrap retry without its failure ledger', async () => {
    await db.insert(platformJobs).values([
      {
        id: 'pjob_0000000000000020',
        idempotencyKey: 'system-illegal-completed',
        input: rolloutInput(0),
        status: 'succeeded',
        type: 'platform.agent.rollout.v1',
      },
      {
        id: 'pjob_0000000000000021',
        idempotencyKey: 'system-rewrap-no-ledger',
        input: rewrapInput(5),
        status: 'failed',
        type: 'platform.secret.rewrap.v1',
      },
    ]);
    const service = new PlatformSystemAdminService(db);

    await expect(
      service.cancelJob('admin-1', {
        expectedRevision: 0,
        expectedStatus: 'running',
        jobId: 'pjob_0000000000000020',
        reason: 'illegal completed cancellation',
        requestId: '550e8400-e29b-41d4-a716-446655440058',
      }),
    ).rejects.toBeInstanceOf(PlatformSystemJobConflictError);
    await expect(
      service.retryJob('admin-1', {
        expectedRevision: 5,
        expectedStatus: 'failed',
        jobId: 'pjob_0000000000000021',
        reason: 'retry failed secret rewrap',
        requestId: '550e8400-e29b-41d4-a716-446655440059',
      }),
    ).rejects.toBeInstanceOf(PlatformSystemJobConflictError);
  });

  it('does not expose connector, EasyAuth, ledger, or unknown jobs as mutable', async () => {
    for (const [index, type] of [
      'connector.runtime.shared-call.v1',
      'platform.easyauth.sync_user',
      'future.platform.job.v1',
    ].entries()) {
      await db.insert(platformJobs).values({
        id: `pjob_000000000000003${index}`,
        idempotencyKey: `system-read-only-${index}`,
        status: 'pending',
        type,
      });
    }
    const service = new PlatformSystemAdminService(db);
    await expect(
      service.cancelJob('admin-1', {
        expectedRevision: 0,
        expectedStatus: 'pending',
        jobId: 'pjob_0000000000000030',
        reason: 'must remain read only',
        requestId: '550e8400-e29b-41d4-a716-446655440060',
      }),
    ).rejects.toBeInstanceOf(PlatformSystemJobInvalidError);
  });
});

describe('PlatformSystemAdminService status', () => {
  it('is fail-soft and never returns configured endpoints or credentials', async () => {
    await db.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      actorUserId: 'admin-1',
      afterDiff: { error: 'https://private.example/?token=secret' },
      result: 'failure',
      targetType: 'settings',
    });
    const service = new PlatformSystemAdminService(db, {
      env: {
        EMAIL_SERVICE_PROVIDER: 'resend',
        ENABLE_DATABASE_OIDC: '0',
        ENABLE_PLATFORM_ADMIN: '1',
        PLATFORM_KEY_PROVIDER: 'vault',
        REDIS_URL: 'redis://:password@private.example:6379',
        RESEND_API_KEY: 'secret-mail-key',
        RESEND_FROM: 'admin@example.com',
        S3_ACCESS_KEY_ID: 'secret-access-key',
        S3_BUCKET: 'private-bucket',
        S3_ENDPOINT: 'https://private.example',
        S3_SECRET_ACCESS_KEY: 'secret-storage-key',
        VAULT_ADDR: 'https://vault.private.example',
        VAULT_TOKEN: 'secret-vault-token',
        VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890',
      },
      redisProbe: async () => ({ errorCategory: 'timeout', status: 'unavailable' }),
    });

    const status = await service.getStatus();
    expect(() => adminSystemGetStatusOutputSchema.parse(status)).not.toThrow();
    expect(status).toMatchObject({
      build: { gitSha: 'abcdef1234567890' },
      dependencies: {
        keyManagement: { errorCategory: 'passive_check_only', status: 'unknown' },
        mail: { errorCategory: 'passive_check_only', status: 'unknown' },
        objectStorage: { errorCategory: 'passive_check_only', status: 'unknown' },
        redis: { errorCategory: 'timeout', status: 'unavailable' },
      },
      featureFlags: { platformAdmin: true },
      oidc: { configured: false, source: 'disabled', status: 'disabled' },
      recentPublishFailures: {
        count: 1,
        errorCategory: null,
        items: [{ category: 'unknown', domain: 'settings' }],
        status: 'healthy',
      },
    });
    const serialized = JSON.stringify(status);
    for (const forbidden of [
      'private.example',
      'private-bucket',
      'secret-access-key',
      'secret-mail-key',
      'secret-storage-key',
      'secret-vault-token',
      'password',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reports unavailable aggregates distinctly and rejects an invalid env KEK as healthy', async () => {
    const service = new PlatformSystemAdminService(db, {
      env: {
        ENABLE_PLATFORM_ADMIN: '1',
        PLATFORM_MASTER_KEY: 'not-valid-base64-key-material',
      },
      jobSummary: async () => {
        throw new Error('private database failure');
      },
      publishFailureSummary: async () => {
        throw new Error('private audit failure');
      },
      redisProbe: async () => ({ errorCategory: null, status: 'disabled' }),
    });

    const status = await service.getStatus();
    expect(() => adminSystemGetStatusOutputSchema.parse(status)).not.toThrow();
    expect(status.jobs).toEqual({
      active: 0,
      completed: 0,
      errorCategory: 'operation_unavailable',
      failed: 0,
      status: 'unavailable',
      total: 0,
    });
    expect(status.recentPublishFailures).toEqual({
      count: 0,
      errorCategory: 'operation_unavailable',
      items: [],
      status: 'unavailable',
    });
    expect(status.dependencies.keyManagement).toEqual({
      errorCategory: 'configuration_incomplete',
      status: 'degraded',
    });
  });
});
