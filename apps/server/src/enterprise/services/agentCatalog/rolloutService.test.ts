// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformJobModel } from '@/database/models/platform/job';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { runPlatformAgentRolloutBatches } from '../../jobs/agentRollout';
import {
  PlatformAgentDependencyValidationError,
  PlatformAgentInvalidInputError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { platformAgentDraftToken, PlatformAgentPublicationService } from './publication';
import {
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  PlatformAgentRolloutService,
} from './rolloutService';
import { processNextPlatformAgentRolloutBatch } from './rolloutWorker';

const db: LobeChatDatabase = await getTestDB();
const checksum = 'a'.repeat(64);
const dependencies = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: checksum,
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};
const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Support',
  tags: [],
});

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformJobs},
      ${platformAgentAssignments},
      ${platformUserAgentMaterializations},
      ${platformAgentVersions},
      ${platformAgents},
      ${userRoles},
      ${roles},
      ${users}
    CASCADE
  `);

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values([{ id: 'admin' }, { id: 'user-a' }, { id: 'user-b' }]);
  await db.insert(platformAgents).values({
    agentKey: 'support',
    currentVersionId: null,
    id: 'agent-support',
    migrationRequired: false,
    revision: 2,
    status: 'draft',
    title: 'Support',
  });
  await db.insert(platformAgentVersions).values([
    {
      agentId: 'agent-support',
      checksum: checksumPayload({ config: config('Support v1'), dependencySnapshot: dependencies }),
      config: config('Support v1'),
      dependencySnapshot: dependencies,
      id: 'version-1',
      version: '1.0.0',
    },
    {
      agentId: 'agent-support',
      checksum: checksumPayload({ config: config('Support v2'), dependencySnapshot: dependencies }),
      config: config('Support v2'),
      dependencySnapshot: dependencies,
      id: 'version-2',
      version: '2.0.0',
    },
  ]);
  await db
    .update(platformAgents)
    .set({ currentVersionId: 'version-2', publishedAt: new Date(), status: 'published' })
    .where(sql`${platformAgents.id} = 'agent-support'`);
  await db.insert(platformAgentAssignments).values({
    agentId: 'agent-support',
    enabled: true,
    id: 'assignment-global',
    mode: 'mandatory',
    pinnedVersionId: null,
    status: 'active',
    targetId: '__global__',
    targetType: 'global',
    versionPolicy: 'latest_published',
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

const startInput = async () => {
  const [identity] = await db.select().from(platformAgents);
  return {
    agentId: identity.id,
    assignmentId: 'assignment-global',
    expectedDraftToken: platformAgentDraftToken(identity),
    expectedRevision: identity.revision,
    reason: 'approved rollout',
  };
};

const exactChecksum = (name: string) =>
  checksumPayload({ config: config(name), dependencySnapshot: dependencies });

const seedMaterializations = async (
  versions: Record<string, { checksum: string; versionId: string }> = Object.fromEntries(
    ['admin', 'user-a', 'user-b'].map((userId) => [
      userId,
      { checksum: exactChecksum('Support v1'), versionId: 'version-1' },
    ]),
  ),
) =>
  db.insert(platformUserAgentMaterializations).values(
    Object.entries(versions).map(([userId, version]) => ({
      lastSyncedAt: new Date(),
      platformAgentId: 'agent-support',
      platformAgentVersionChecksum: version.checksum,
      platformAgentVersionId: version.versionId,
      status: 'pending' as const,
      userId,
    })),
  );

const publishV3 = async () => {
  await db.insert(platformAgentVersions).values({
    agentId: 'agent-support',
    checksum: exactChecksum('Support v3'),
    config: config('Support v3'),
    dependencySnapshot: dependencies,
    id: 'version-3',
    version: '3.0.0',
  });
  await db
    .update(platformAgents)
    .set({ currentVersionId: 'version-3', revision: 3 })
    .where(sql`${platformAgents.id} = 'agent-support'`);
};

describe('PlatformAgentRolloutService control plane', () => {
  it('collapses concurrent starts onto one immutable snapshot and paginates the projection', async () => {
    const service = new PlatformAgentRolloutService(db);
    const input = await startInput();
    const [first, duplicate] = await Promise.all([
      service.start('admin', input),
      service.start('admin', input),
    ]);

    expect(duplicate.jobId).toBe(first.jobId);
    expect(first).toMatchObject({
      assignmentId: 'assignment-global',
      previousVersionId: null,
      revision: 0,
      status: 'pending',
      targetVersionId: 'version-2',
      total: 3,
    });
    const [job] = await db.select().from(platformJobs);
    expect(job.input).toEqual({
      control: { phase: 'targets', revision: 0 },
      snapshot: expect.objectContaining({
        agentId: 'agent-support',
        previousVersionChecksum: null,
        previousVersionId: null,
        targetVersionChecksum: checksumPayload({
          config: config('Support v2'),
          dependencySnapshot: dependencies,
        }),
        targetVersionId: 'version-2',
        versionPolicy: 'latest_published',
      }),
    });
    expect(parsePlatformAgentRolloutInput(job).snapshot.targetCutoff).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    await expect(service.list({ agentId: 'agent-support', limit: 50 })).resolves.toMatchObject({
      items: [expect.objectContaining({ jobId: first.jobId })],
      nextCursor: null,
    });
  });

  it('uses status + JSON revision CAS for cancel/retry and rejects stale transitions', async () => {
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const cancelled = await service.cancel('admin', {
      agentId: 'agent-support',
      expectedJobRevision: started.revision,
      expectedStatus: started.status,
      jobId: started.jobId,
      reason: 'stop safely',
    });
    expect(cancelled).toMatchObject({ revision: 1, status: 'cancelled' });
    await expect(
      service.cancel('admin', {
        agentId: 'agent-support',
        expectedJobRevision: started.revision,
        expectedStatus: started.status,
        jobId: started.jobId,
        reason: 'stale cancel',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);

    const retried = await service.retry('admin', {
      agentId: 'agent-support',
      expectedJobRevision: cancelled.revision,
      expectedStatus: cancelled.status,
      jobId: cancelled.jobId,
      reason: 'resume checkpoint',
    });
    expect(retried).toMatchObject({ revision: 2, status: 'pending' });
    await expect(
      service.retry('admin', {
        agentId: 'agent-support',
        expectedJobRevision: cancelled.revision,
        expectedStatus: cancelled.status,
        jobId: cancelled.jobId,
        reason: 'stale retry',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(
      await db
        .select()
        .from(platformAuditLogs)
        .where(
          sql`${platformAuditLogs.result} = 'failure' AND ${platformAuditLogs.action} IN ('admin.agents.rollouts.cancel', 'admin.agents.rollouts.retry')`,
        ),
    ).toEqual([
      expect.objectContaining({ afterDiff: { error: 'revision_conflict' } }),
      expect.objectContaining({ afterDiff: { error: 'revision_conflict' } }),
    ]);
  });

  it('performs zero DB operations when the worker feature flag is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    const query = vi.fn(() => {
      throw new Error('must not query');
    });
    await expect(runPlatformAgentRolloutBatches({ query } as never)).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('runs bounded cursor batches and materializes each assignment target exactly once', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    await expect(runPlatformAgentRolloutBatches(db, 10)).resolves.toBeGreaterThan(0);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed', total: 3 });

    const rows = await db.select().from(platformUserAgentMaterializations);
    expect(rows).toHaveLength(3);
    expect(rows.every(({ platformAgentVersionId }) => platformAgentVersionId === 'version-2')).toBe(
      true,
    );
    await expect(runPlatformAgentRolloutBatches(db, 10)).resolves.toBe(0);
    expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(3);
  });

  it('preserves a six-digit cutoff across global/user/role pagination and worker JSON', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const cutoff = '2000-01-01T00:00:00.123456Z';
    const includedAt = '2000-01-01T00:00:00.123400Z';
    const excludedAt = '2000-01-01T00:00:00.123457Z';
    await db.insert(users).values(
      Array.from({ length: 105 }, (_, index) => ({
        createdAt: sql`${includedAt}::timestamptz`,
        id: `micro-${String(index).padStart(3, '0')}`,
      })),
    );
    await db.insert(users).values({
      createdAt: sql`${excludedAt}::timestamptz`,
      id: 'micro-after',
    });
    await db.insert(roles).values({
      displayName: 'Microsecond role',
      id: 'micro-role',
      isActive: true,
      name: 'micro_role',
      workspaceId: null,
    });
    await db.insert(userRoles).values([
      {
        createdAt: sql`${includedAt}::timestamptz`,
        roleId: 'micro-role',
        userId: 'micro-000',
        workspaceId: null,
      },
      {
        createdAt: sql`${excludedAt}::timestamptz`,
        roleId: 'micro-role',
        userId: 'micro-001',
        workspaceId: null,
      },
      {
        createdAt: sql`${includedAt}::timestamptz`,
        roleId: 'micro-role',
        userId: 'micro-after',
        workspaceId: null,
      },
    ]);
    const repository = new PlatformAgentCatalogRepository(db);
    await expect(
      repository.countAssignmentTargets({
        cutoff,
        targetId: '__global__',
        targetType: 'global',
      }),
    ).resolves.toBe(105);
    await expect(
      repository.countAssignmentTargets({
        cutoff,
        targetId: 'micro-000',
        targetType: 'user',
      }),
    ).resolves.toBe(1);
    await expect(
      repository.countAssignmentTargets({
        cutoff,
        targetId: 'micro-after',
        targetType: 'user',
      }),
    ).resolves.toBe(0);
    await expect(
      repository.countAssignmentTargets({
        cutoff,
        targetId: 'micro-role',
        targetType: 'global_role',
      }),
    ).resolves.toBe(1);
    const firstPage = await repository.listAssignmentTargetUserIds({
      cutoff,
      limit: 100,
      targetId: '__global__',
      targetType: 'global',
    });
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    await expect(
      repository.listAssignmentTargetUserIds({
        cutoff,
        cursor: firstPage.nextCursor!,
        limit: 100,
        targetId: '__global__',
        targetType: 'global',
      }),
    ).resolves.toMatchObject({ items: expect.arrayContaining(['micro-104']), nextCursor: null });
    await expect(
      repository.listAssignmentTargetUserIds({
        cutoff,
        targetId: 'micro-role',
        targetType: 'global_role',
      }),
    ).resolves.toEqual({ items: ['micro-000'], nextCursor: null });

    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const [job] = await db
      .select()
      .from(platformJobs)
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    const input = parsePlatformAgentRolloutInput(job);
    await db
      .update(platformJobs)
      .set({ input: { ...input, snapshot: { ...input.snapshot, targetCutoff: cutoff } } })
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    const [roundTripped] = await db
      .select()
      .from(platformJobs)
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    expect(parsePlatformAgentRolloutInput(roundTripped).snapshot.targetCutoff).toBe(cutoff);
    expect(() =>
      parsePlatformAgentRolloutInput({
        ...roundTripped,
        input: {
          ...input,
          snapshot: { ...input.snapshot, targetCutoff: '2000-01-01T00:00:00.123Z' },
        },
      }),
    ).toThrow(PlatformAgentInvalidInputError);

    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 105, failed: 0, status: 'completed', total: 105 });
    expect(
      await db
        .select()
        .from(platformUserAgentMaterializations)
        .where(sql`${platformUserAgentMaterializations.userId} = 'micro-after'`),
    ).toHaveLength(0);
  });

  it('reconciles a deleted target to an actual terminal total of 2/2', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    await db.delete(users).where(sql`${users.id} = 'user-b'`);

    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 2, failed: 0, status: 'completed', total: 2 });
  });

  it('uses the same cutoff for role users and memberships while honoring later removals', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(roles).values({
      displayName: 'Rollout role',
      id: 'rollout-role',
      isActive: true,
      name: 'rollout_role',
      workspaceId: null,
    });
    await db.insert(userRoles).values([
      { roleId: 'rollout-role', userId: 'admin', workspaceId: null },
      { roleId: 'rollout-role', userId: 'user-a', workspaceId: null },
    ]);
    await db
      .update(platformAgentAssignments)
      .set({ targetId: 'rollout-role', targetType: 'global_role' });
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const [job] = await db
      .select()
      .from(platformJobs)
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    const cutoff = (job.input as { snapshot: { targetCutoff: string } }).snapshot.targetCutoff;
    await db
      .delete(userRoles)
      .where(sql`${userRoles.roleId} = 'rollout-role' AND ${userRoles.userId} = 'user-a'`);
    await db.insert(userRoles).values({
      createdAt: sql`${cutoff}::timestamptz + interval '1 microsecond'`,
      roleId: 'rollout-role',
      userId: 'user-b',
      workspaceId: null,
    });

    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 1, failed: 0, status: 'completed', total: 1 });
    expect(
      (await db.select().from(platformUserAgentMaterializations)).map(({ userId }) => userId),
    ).toEqual(['admin']);
  });

  it('coordinates concurrent workers across multiple bounded pages without duplicates', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(users).values(
      Array.from({ length: 202 }, (_, index) => ({
        id: `bulk-${String(index).padStart(4, '0')}`,
      })),
    );
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    await db
      .update(platformJobs)
      .set({ progressTotal: 1 })
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    await Promise.all([
      runPlatformAgentRolloutBatches(db, 10),
      runPlatformAgentRolloutBatches(db, 10),
    ]);

    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 205, failed: 0, status: 'completed', total: 205 });
    expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(205);
  });

  it('keeps a full 100-target page query-bounded and retries an interleaved failure only', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(users).values(
      Array.from({ length: 97 }, (_, index) => ({
        id: `page-${String(index).padStart(4, '0')}`,
      })),
    );
    const beforeBulkWrite = vi.fn(async (_context: { userIds: string[] }) => new Set(['user-a']));
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const query = vi.spyOn(
      (db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client,
      'query',
    );
    try {
      await processNextPlatformAgentRolloutBatch(db, 'mixed-worker', {
        lifecycle: {
          beforeBulkWrite,
        },
      });
      expect(query.mock.calls.length).toBeLessThan(25);
    } finally {
      query.mockRestore();
    }

    expect(beforeBulkWrite).toHaveBeenCalledTimes(1);
    expect(beforeBulkWrite.mock.calls[0]![0].userIds).toHaveLength(100);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 99, failed: 1, status: 'failed' });
    const untouched = await db
      .select()
      .from(platformUserAgentMaterializations)
      .where(sql`${platformUserAgentMaterializations.userId} = 'user-a'`);
    expect(untouched).toHaveLength(0);

    const failed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    await service.retry('admin', {
      agentId: 'agent-support',
      expectedJobRevision: failed.revision,
      expectedStatus: failed.status,
      jobId: failed.jobId,
      reason: 'retry only user-a',
    });
    await runPlatformAgentRolloutBatches(db, 10);
    expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(100);
  });

  it('rolls back an expired writer before cancel → retry can safely resume', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (entered = resolve));
    const wait = new Promise<void>((resolve) => (release = resolve));
    const expiredWriter = processNextPlatformAgentRolloutBatch(db, 'expired-worker', {
      leaseMs: 20,
      lifecycle: {
        beforeBulkWrite: async () => {
          entered();
          await wait;
        },
      },
    });
    await held;
    const cancelling = service.cancel('admin', {
      agentId: 'agent-support',
      expectedJobRevision: 0,
      expectedStatus: 'running',
      jobId: started.jobId,
      reason: 'cancel expired writer',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await expect(expiredWriter).resolves.toMatchObject({ terminal: false });
    const cancelled = await cancelling;
    expect(cancelled.status).toBe('cancelled');
    expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(0);

    await service.retry('admin', {
      agentId: 'agent-support',
      expectedJobRevision: cancelled.revision,
      expectedStatus: cancelled.status,
      jobId: cancelled.jobId,
      reason: 'resume after lease loss',
    });
    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed' });
  });

  it('keeps cancellation terminal when a previously leased worker completes late', async () => {
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const jobs = new PlatformJobModel(db);
    await expect(
      jobs.claimNext({ types: ['platform.agent.rollout.v1'], workerId: 'late-worker' }),
    ).resolves.toMatchObject({ id: started.jobId, status: 'running' });
    const cancelled = await service.cancel('admin', {
      agentId: 'agent-support',
      expectedJobRevision: 0,
      expectedStatus: 'running',
      jobId: started.jobId,
      reason: 'cancel leased rollout',
    });
    expect(cancelled.status).toBe('cancelled');
    await expect(
      jobs.complete({ jobId: started.jobId, workerId: 'late-worker' }),
    ).resolves.toBeNull();
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('records failures separately, preserves a prior version, then retries only the exact set', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const v1Checksum = exactChecksum('Support v1');
    await db.insert(platformUserAgentMaterializations).values({
      lastSyncedAt: new Date(),
      platformAgentId: 'agent-support',
      platformAgentVersionChecksum: v1Checksum,
      platformAgentVersionId: 'version-1',
      status: 'pending',
      userId: 'user-a',
    });
    await processNextPlatformAgentRolloutBatch(db, 'fault-worker', {
      lifecycle: {
        beforeBulkWrite: async ({ userIds }) => new Set(userIds),
      },
    });
    const failed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    expect(failed).toMatchObject({ completed: 0, failed: 3, status: 'failed' });
    const [preserved] = await db
      .select()
      .from(platformUserAgentMaterializations)
      .where(sql`${platformUserAgentMaterializations.userId} = 'user-a'`);
    expect(preserved.platformAgentVersionId).toBe('version-1');
    expect(
      await db
        .select()
        .from(platformJobs)
        .where(sql`${platformJobs.type} = ${PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE}`),
    ).toHaveLength(3);

    await service.retry('admin', {
      agentId: 'agent-support',
      expectedJobRevision: failed.revision,
      expectedStatus: failed.status,
      jobId: failed.jobId,
      reason: 'repair completed',
    });
    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed' });
    expect(
      await db
        .select()
        .from(platformJobs)
        .where(
          sql`${platformJobs.type} = ${PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE} AND ${platformJobs.status} = 'failed'`,
        ),
    ).toHaveLength(0);
  });

  it('freezes real V1 transitions so V1 → V3 rolls back to V1, never intermediate V2', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await seedMaterializations();
    await publishV3();
    const publish = vi.fn();
    const service = new PlatformAgentRolloutService(db, {
      invalidation: { publish },
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    const oldOperationPin = {
      checksum: exactChecksum('Support v3'),
      platformAgentId: 'agent-support',
      versionId: started.targetVersionId,
    };
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    expect(completed.previousVersionId).toBe('version-1');
    expect(completed.targetVersionId).toBe('version-3');

    const dependencyFailureService = new PlatformAgentRolloutService(db, {
      invalidation: { publish },
      validateDependencies: vi.fn(async () => {
        throw new PlatformAgentDependencyValidationError(['AI_MODEL_UNAVAILABLE']);
      }),
    });
    await expect(
      dependencyFailureService.rollback('admin', {
        agentId: 'agent-support',
        expectedJobRevision: completed.revision,
        expectedStatus: completed.status,
        jobId: completed.jobId,
        reason: 'dependency failure is audited',
        targetVersionId: 'version-1',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDependencyValidationError);
    expect(
      await db
        .select()
        .from(platformAuditLogs)
        .where(
          sql`${platformAuditLogs.action} = 'admin.agents.rollouts.rollback' AND ${platformAuditLogs.result} = 'failure'`,
        ),
    ).toEqual([expect.objectContaining({ afterDiff: { error: 'dependency_validation_failed' } })]);

    const reverse = await service.rollback('admin', {
      agentId: 'agent-support',
      expectedJobRevision: completed.revision,
      expectedStatus: completed.status,
      jobId: completed.jobId,
      reason: 'return to stable V1',
      targetVersionId: 'version-1',
    });
    expect(reverse).toMatchObject({
      previousVersionId: null,
      status: 'pending',
      targetVersionId: 'version-1',
    });
    const [identity] = await db.select().from(platformAgents);
    expect(identity.currentVersionId).toBe('version-1');
    expect(oldOperationPin.versionId).toBe('version-3');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'agent-support', revision: 4 }),
    );
    await expect(
      service.rollback('admin', {
        agentId: 'agent-support',
        expectedJobRevision: completed.revision,
        expectedStatus: completed.status,
        jobId: completed.jobId,
        reason: 'stale rollback is audited',
        targetVersionId: 'version-1',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(
      await db
        .select()
        .from(platformAuditLogs)
        .where(
          sql`${platformAuditLogs.action} = 'admin.agents.rollouts.rollback' AND ${platformAuditLogs.result} = 'failure'`,
        ),
    ).toEqual([
      expect.objectContaining({ afterDiff: { error: 'dependency_validation_failed' } }),
      expect.objectContaining({ afterDiff: { error: 'revision_conflict' } }),
    ]);

    await runPlatformAgentRolloutBatches(db, 10);
    const rows = await db.select().from(platformUserAgentMaterializations);
    expect(rows.every(({ platformAgentVersionId }) => platformAgentVersionId === 'version-1')).toBe(
      true,
    );
    await expect(
      service.get({ agentId: 'agent-support', jobId: reverse.jobId }),
    ).resolves.toMatchObject({ previousVersionId: 'version-3', status: 'completed' });
  });

  it('rolls a pinned assignment back without changing the Agent latest pointer', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await seedMaterializations();
    await db
      .update(platformAgentAssignments)
      .set({ pinnedVersionId: 'version-2', versionPolicy: 'pinned' });
    const service = new PlatformAgentRolloutService(db, {
      invalidation: { publish: vi.fn() },
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    await service.rollback('admin', {
      agentId: 'agent-support',
      expectedJobRevision: completed.revision,
      expectedStatus: completed.status,
      jobId: completed.jobId,
      reason: 'pin V1 again',
      targetVersionId: 'version-1',
    });

    const [identity] = await db.select().from(platformAgents);
    const [assignment] = await db.select().from(platformAgentAssignments);
    expect(identity.currentVersionId).toBe('version-2');
    expect(assignment.pinnedVersionId).toBe('version-1');
  });

  it('does not fabricate one rollback pointer for mixed per-user transition history', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await publishV3();
    await seedMaterializations({
      'admin': { checksum: exactChecksum('Support v1'), versionId: 'version-1' },
      'user-a': { checksum: exactChecksum('Support v2'), versionId: 'version-2' },
      'user-b': { checksum: exactChecksum('Support v1'), versionId: 'version-1' },
    });
    const service = new PlatformAgentRolloutService(db, {
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    expect(completed).toMatchObject({ previousVersionId: null, status: 'completed' });
    await expect(
      service.rollback('admin', {
        agentId: 'agent-support',
        expectedJobRevision: completed.revision,
        expectedStatus: completed.status,
        jobId: completed.jobId,
        reason: 'mixed history must fail closed',
        targetVersionId: 'version-1',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
  });

  it('fails rollback closed when the frozen transition proof checksum drifts', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await seedMaterializations();
    const service = new PlatformAgentRolloutService(db, {
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    const [job] = await db
      .select()
      .from(platformJobs)
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    await db
      .update(platformJobs)
      .set({
        resultSummary: {
          ...(job.resultSummary as Record<string, unknown>),
          previousVersionChecksum: exactChecksum('Support v2'),
        },
      })
      .where(sql`${platformJobs.id} = ${started.jobId}`);

    await expect(
      service.rollback('admin', {
        agentId: 'agent-support',
        expectedJobRevision: completed.revision,
        expectedStatus: completed.status,
        jobId: completed.jobId,
        reason: 'checksum drift must fail closed',
        targetVersionId: 'version-1',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(
      await db
        .select()
        .from(platformAuditLogs)
        .where(
          sql`${platformAuditLogs.action} = 'admin.agents.rollouts.rollback' AND ${platformAuditLogs.result} = 'failure'`,
        ),
    ).toEqual([expect.objectContaining({ afterDiff: { error: 'revision_conflict' } })]);
  });

  it('fails pinned rollback when Assignment scope changed after the frozen rollout', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await seedMaterializations();
    await db
      .update(platformAgentAssignments)
      .set({ pinnedVersionId: 'version-2', versionPolicy: 'pinned' });
    const service = new PlatformAgentRolloutService(db, {
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });
    await db.update(platformAgentAssignments).set({ targetId: 'user-a', targetType: 'user' });
    await expect(
      service.rollback('admin', {
        agentId: 'agent-support',
        expectedJobRevision: completed.revision,
        expectedStatus: completed.status,
        jobId: completed.jobId,
        reason: 'scope drift',
        targetVersionId: 'version-1',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
  });

  it('delegates default-inbox rollback to the publication pointer and audits rollout rejection', async () => {
    await db
      .update(platformAgents)
      .set({ isDefault: true, systemKey: 'default-inbox' })
      .where(sql`${platformAgents.id} = 'agent-support'`);
    const service = new PlatformAgentRolloutService(db);
    await expect(service.start('admin', await startInput())).rejects.toBeInstanceOf(
      PlatformAgentInvalidInputError,
    );
    expect(
      await db
        .select()
        .from(platformAuditLogs)
        .where(sql`${platformAuditLogs.action} = 'admin.agents.rollouts.start'`),
    ).toEqual([
      expect.objectContaining({
        afterDiff: { error: 'invalid_input' },
        result: 'failure',
      }),
    ]);

    const [before] = await db.select().from(platformAgents);
    const oldOperationPin = { versionId: before.currentVersionId };
    const publication = new PlatformAgentPublicationService(db, {
      invalidation: { publish: vi.fn() },
      validateDependencies: vi.fn(async () => {}),
    });
    await publication.rollback('admin', {
      agentId: before.id,
      expectedDraftToken: platformAgentDraftToken(before),
      expectedRevision: before.revision,
      reason: 'default inbox publication rollback',
      targetVersionId: 'version-1',
    });
    const [after] = await db.select().from(platformAgents);
    expect(after.currentVersionId).toBe('version-1');
    expect(oldOperationPin.versionId).toBe('version-2');
  });
});
