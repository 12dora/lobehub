// @vitest-environment node
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
  platformInstanceHeartbeats,
  platformInstanceRevisionStates,
  platformJobs,
  platformResourceRevisions,
  platformSettingsBundle,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { isRedisEnabled } from '@/libs/redis/manager';
import {
  adminSystemGetInstanceRevisionsOutputSchema,
  adminSystemGetStatusOutputSchema,
} from '@/server/enterprise/contracts/adminSystem';

import {
  getIdentityProviderProcessInstance,
  stopIdentityProviderHeartbeatForTest,
} from '../identityProvider/instanceRegistry';
import {
  commitIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupArtifactForTest,
} from '../identityProvider/startupArtifact';
import { loadPublishedIdentityTarget } from '../identityProvider/systemService';
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
  vi.unstubAllEnvs();
  resetIdentityProviderStartupArtifactForTest();
  stopIdentityProviderHeartbeatForTest();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.delete(platformIdentityProviderRestartRequests);
    await tx.delete(platformIdentityProviderInstances);
    await tx.delete(platformIdentityProviders);
    await tx.delete(platformResourceRevisions);
    await tx.delete(platformInstanceRevisionStates);
    await tx.delete(platformInstanceHeartbeats);
    await tx.delete(platformJobs);
    await tx.delete(platformSettingsBundle);
    await tx.delete(platformAuditLogs);
  });
  // Audit logs are append-only (row triggers); TRUNCATE is the test cleanup path.
  await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
});

describe('PlatformSystemAdminService instance revisions', () => {
  it('paginates the complete mixed inventory without omissions at diagnostic caps', async () => {
    const freshHeartbeat = new Date(Date.now() - 1_000);
    const staleHeartbeat = new Date(Date.now() - 120_000);
    const startedAt = new Date(Date.now() - 300_000);
    const platformFreshIds = Array.from(
      { length: 103 },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    const identityFreshIds = Array.from(
      { length: 3 },
      (_, index) => `oidci_${index.toString(16).padStart(48, '0')}`,
    );
    const platformStaleIds = Array.from(
      { length: 12 },
      (_, index) => `pinst_${(1000 + index).toString(16).padStart(48, '0')}`,
    );
    const identityStaleIds = Array.from(
      { length: 2 },
      (_, index) => `oidci_${(1000 + index).toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values([
      ...platformFreshIds.map((instanceId) => ({
        instanceId,
        lastHeartbeatAt: freshHeartbeat,
        startedAt,
      })),
      ...platformStaleIds.map((instanceId) => ({
        instanceId,
        lastHeartbeatAt: staleHeartbeat,
        startedAt,
      })),
    ]);
    await db.insert(platformIdentityProviderInstances).values(
      [...identityFreshIds, ...identityStaleIds].map((instanceId, index) => ({
        activeIdentityRevision: null,
        health: 'healthy' as const,
        hostnameHash: index.toString(16).padStart(64, '0'),
        instanceId,
        lastHeartbeat: index < identityFreshIds.length ? freshHeartbeat : staleHeartbeat,
        loadedAt: startedAt,
        startedAt,
        startupSource: 'database' as const,
      })),
    );

    const service = new PlatformSystemAdminService(db, { env: {} });
    const collected: Awaited<ReturnType<typeof service.getInstanceRevisions>>['items'] = [];
    let cursor: string | undefined;
    do {
      const page = await service.getInstanceRevisions({ cursor, limit: 17 });
      expect(() => adminSystemGetInstanceRevisionsOutputSchema.parse(page)).not.toThrow();
      collected.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const expectedIds = [
      ...identityFreshIds.sort(),
      ...platformFreshIds.sort(),
      ...identityStaleIds.sort(),
      ...platformStaleIds.sort(),
    ];
    expect(collected.map(({ instanceId }) => instanceId)).toEqual(expectedIds);
    expect(new Set(collected.map(({ instanceId }) => instanceId)).size).toBe(expectedIds.length);
    expect(collected.filter(({ fresh }) => fresh)).toHaveLength(106);
    expect(collected.filter(({ fresh }) => !fresh)).toHaveLength(14);
    expect(collected.at(0)?.instanceId).toBe(identityFreshIds[0]);
    expect(collected.at(-1)?.instanceId).toBe(platformStaleIds.at(-1));
  });

  it('returnsOneConsistentInstanceSnapshotAcrossPublishRace', async () => {
    const freshHeartbeat = new Date(Date.now() - 1_000);
    const startedAt = new Date(Date.now() - 300_000);
    const ids = Array.from(
      { length: 3 },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((instanceId) => ({
        instanceId,
        lastHeartbeatAt: freshHeartbeat,
        startedAt,
      })),
    );
    await db.insert(platformSettingsBundle).values({
      draft: {},
      id: 'global',
      revision: 1,
      status: 'published',
    });

    const service = new PlatformSystemAdminService(db, {
      env: { ENABLE_PLATFORM_SETTINGS_POLICY: '1' },
    });
    const first = await service.getInstanceRevisions({ limit: 1 });
    expect(() => adminSystemGetInstanceRevisionsOutputSchema.parse(first)).not.toThrow();
    expect(first.targetRevision).toMatch(/^[a-f0-9]{32}$/);
    expect(first.domains.some((domain) => domain.domain === 'settings')).toBe(true);
    const settingsDomain = first.domains.find((domain) => domain.domain === 'settings');
    expect(settingsDomain?.targetToken).toEqual({ kind: 'revision', value: 1 });
    expect(first.nextCursor).toBeTruthy();

    // Publish a new settings revision between pages — cursor is bound to the old fingerprint.
    await db
      .update(platformSettingsBundle)
      .set({ revision: 2 })
      .where(eq(platformSettingsBundle.id, 'global'));

    await expect(
      service.getInstanceRevisions({ cursor: first.nextCursor!, limit: 1 }),
    ).rejects.toBeInstanceOf(PlatformSystemJobInvalidError);

    const restarted = await service.getInstanceRevisions({ limit: 1 });
    expect(restarted.targetRevision).not.toBe(first.targetRevision);
    expect(restarted.domains.find((domain) => domain.domain === 'settings')?.targetToken).toEqual({
      kind: 'revision',
      value: 2,
    });
  });
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

  it('does not expose connector, ledger, or unknown jobs as mutable', async () => {
    for (const [index, type] of [
      'connector.runtime.shared-call.v1',
      'future.platform.job.v1',
      'legacy.unknown.job.v1',
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
  it('honors the production DISABLE_REDIS switch without creating a client', async () => {
    vi.stubEnv('DISABLE_REDIS', '1');
    const createRedisWithPrefix = vi.fn();
    const status = await new PlatformSystemAdminService(db, {
      env: {},
      redisDependencies: {
        createRedisWithPrefix,
        getRedisConfig: () => ({
          enabled: true,
          prefix: 'lobechat',
          tls: false,
          url: 'redis://private.example:6379',
        }),
        isRedisEnabled,
      },
    }).getStatus();

    expect(status.dependencies.redis).toEqual({ errorCategory: null, status: 'disabled' });
    expect(createRedisWithPrefix).not.toHaveBeenCalled();
  });

  it('passes credentials, TLS, and database through the production Redis config path', async () => {
    const config = {
      database: 7,
      enabled: true,
      password: 'sensitive-password',
      prefix: 'lobechat',
      tls: true,
      url: 'redis://private.example:6379',
      username: 'sensitive-user',
    };
    const disconnect = vi.fn(async () => undefined);
    const createRedisWithPrefix = vi.fn(async () => ({ disconnect }) as never);
    const status = await new PlatformSystemAdminService(db, {
      env: {},
      redisDependencies: {
        createRedisWithPrefix,
        getRedisConfig: () => config,
        isRedisEnabled,
      },
    }).getStatus();

    expect(status.dependencies.redis).toEqual({ errorCategory: null, status: 'healthy' });
    expect(createRedisWithPrefix).toHaveBeenCalledWith(config, 'platformSystemHealth');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(status)).not.toContain('sensitive-password');
    expect(JSON.stringify(status)).not.toContain('sensitive-user');
    expect(JSON.stringify(status)).not.toContain('private.example');
  });

  it('reports unavailable without leaking config when Redis cleanup fails', async () => {
    const config = {
      database: 7,
      enabled: true,
      password: 'sensitive-password',
      prefix: 'lobechat',
      tls: true,
      url: 'redis://private.example:6379',
      username: 'sensitive-user',
    };
    const disconnect = vi.fn(async () => {
      throw new Error('failed to close redis://sensitive-user@private.example');
    });
    const status = await new PlatformSystemAdminService(db, {
      env: {},
      redisDependencies: {
        createRedisWithPrefix: vi.fn(async () => ({ disconnect }) as never),
        getRedisConfig: () => config,
        isRedisEnabled,
      },
    }).getStatus();

    expect(status.dependencies.redis).toEqual({
      errorCategory: 'operation_unavailable',
      status: 'unavailable',
    });
    expect(disconnect).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('sensitive-password');
    expect(serialized).not.toContain('sensitive-user');
    expect(serialized).not.toContain('private.example');
  });

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

  it('counts only 24-hour publication failures and includes managed policy failures', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    await db.insert(platformAuditLogs).values([
      {
        action: 'admin.managedResources.publish',
        actorUserId: 'admin-1',
        afterDiff: { error: 'operation failed' },
        createdAt: new Date(now.getTime() - 60_000),
        result: 'failure',
        targetType: 'managed_policy',
      },
      {
        action: 'admin.settings.publish',
        actorUserId: 'admin-1',
        afterDiff: { error: 'historical failure' },
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1),
        result: 'failure',
        targetType: 'settings',
      },
    ]);

    const status = await new PlatformSystemAdminService(db, {
      env: { ENABLE_DATABASE_OIDC: '0' },
      now: () => now,
    }).getStatus();
    expect(status.recentPublishFailures).toMatchObject({
      count: 1,
      items: [{ category: 'operation_unavailable', domain: 'managed_policy' }],
      status: 'healthy',
    });
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

  it('reportsEnvironmentShadowedPendingRestartFromCanonicalStatus', async () => {
    const now = new Date();
    const payload = {
      autoProvision: true,
      buttonLabel: 'Work account',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      displayName: 'Work',
      domainAllowlist: [],
      enabled: true,
      groupRoleMapping: {},
      icon: null,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
      secretFingerprint: 'b'.repeat(64),
      secretUpdatedAt: now.toISOString(),
      type: 'generic_oidc' as const,
      usePkce: true as const,
    };
    await db.insert(platformIdentityProviders).values({
      activationRevision: 1,
      buttonLabel: 'Work account',
      displayName: 'Work',
      enabled: true,
      id: 'provider-work',
      providerKey: 'work',
      revision: 1,
      status: 'pending_restart',
    });
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      id: 'revision-work-1',
      payload,
      publishedAt: now,
      resourceId: 'provider-work',
      resourceType: 'oidc',
      revision: 1,
      secretFingerprint: 'b'.repeat(64),
      status: 'published',
    });
    const local = getIdentityProviderProcessInstance();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: null,
      health: 'healthy',
      identityRevision: null,
      lastError: null,
      loadedAt: now,
      providerIds: ['work'],
      source: 'environment',
    });
    await db.insert(platformIdentityProviderInstances).values({
      activeIdentityRevision: null,
      health: 'healthy',
      hostnameHash: local.hostnameHash,
      instanceId: local.instanceId,
      lastHeartbeat: now,
      loadedAt: now,
      startedAt: local.startedAt,
      startupGeneration: null,
      startupSource: 'environment',
    });

    const status = await new PlatformSystemAdminService(db, {
      env: {
        AUTH_SSO_PROVIDERS: 'work',
        ENABLE_DATABASE_OIDC: '1',
        ENABLE_PLATFORM_ADMIN: '1',
      },
      now: () => now,
      redisProbe: async () => ({ errorCategory: null, status: 'disabled' }),
    }).getStatus();

    expect(() => adminSystemGetStatusOutputSchema.parse(status)).not.toThrow();
    // Canonical ledger reports pendingRestart even when environment shadows DB providers.
    expect(status.oidc.pendingRestart).toBe(true);
    expect(status.oidc.configured).toBe(true);
  });

  it('clearsPendingRestartAfterCanonicalReconciliation', async () => {
    const now = new Date();
    const payload = {
      autoProvision: true,
      buttonLabel: 'Work account',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client-id',
      displayName: 'Work',
      domainAllowlist: [],
      enabled: true,
      groupRoleMapping: {},
      icon: null,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
      secretFingerprint: 'b'.repeat(64),
      secretUpdatedAt: now.toISOString(),
      type: 'generic_oidc' as const,
      usePkce: true as const,
    };
    await db.insert(platformIdentityProviders).values({
      activationRevision: 1,
      buttonLabel: 'Work account',
      displayName: 'Work',
      enabled: true,
      id: 'provider-work',
      providerKey: 'work',
      revision: 1,
      status: 'pending_restart',
    });
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      id: 'revision-work-1',
      payload,
      publishedAt: now,
      resourceId: 'provider-work',
      resourceType: 'oidc',
      revision: 1,
      secretFingerprint: 'b'.repeat(64),
      status: 'published',
    });
    // identityRevision is the checksum of published selection (same as systemService tests).
    const target = (await loadPublishedIdentityTarget(db)).identityRevision!;
    const local = getIdentityProviderProcessInstance();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: 'generation',
      health: 'healthy',
      identityRevision: target,
      lastError: null,
      loadedAt: now,
      providerIds: ['work'],
      source: 'database',
    });
    await db.insert(platformIdentityProviderInstances).values({
      activeIdentityRevision: target,
      health: 'healthy',
      hostnameHash: local.hostnameHash,
      instanceId: local.instanceId,
      lastHeartbeat: now,
      loadedAt: now,
      startedAt: local.startedAt,
      startupGeneration: 'generation',
      startupSource: 'database',
    });

    const status = await new PlatformSystemAdminService(db, {
      env: {
        ENABLE_DATABASE_OIDC: '1',
        ENABLE_PLATFORM_ADMIN: '1',
      },
      now: () => now,
      redisProbe: async () => ({ errorCategory: null, status: 'disabled' }),
    }).getStatus();

    expect(() => adminSystemGetStatusOutputSchema.parse(status)).not.toThrow();
    // All fresh instances active → canonical reconciliation clears pending rows.
    expect(status.oidc.pendingRestart).toBe(false);
    expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe('active');
  });
});
