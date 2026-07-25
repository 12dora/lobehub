// @vitest-environment node
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformJobModel } from '@/database/models/platform/job';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgentAssignments,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
  roles,
  userRoles,
  users,
} from '@/database/schemas';

import { runPlatformAgentRolloutBatches } from '../../jobs/agentRollout';
import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';
import {
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  PlatformAgentRolloutService,
} from './rolloutService';
import {
  config,
  db,
  dependencies,
  exactChecksum,
  runPostgres,
  startInput,
} from './rolloutService.test.fixture';
import { processNextPlatformAgentRolloutBatch } from './rolloutWorker';

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

  it('filters list by projection status (pending includes reserved; completed maps succeeded)', async () => {
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    expect(started.status).toBe('pending');

    // Reserved rows project as pending — an active poll must still see them.
    await db
      .update(platformJobs)
      .set({ status: 'reserved' })
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    await expect(
      service.list({ agentId: 'agent-support', limit: 50, status: ['pending', 'running'] }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ jobId: started.jobId, status: 'pending' })],
      nextCursor: null,
    });
    await expect(
      service.list({ agentId: 'agent-support', limit: 50, status: ['running'] }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });

    // Succeeded rows project as completed — terminal filter must map accordingly.
    await db
      .update(platformJobs)
      .set({ status: 'succeeded' })
      .where(sql`${platformJobs.id} = ${started.jobId}`);
    await expect(
      service.list({ agentId: 'agent-support', limit: 50, status: ['completed'] }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ jobId: started.jobId, status: 'completed' })],
      nextCursor: null,
    });
    // Active poll filter must not silently drop completed-as-missing without a list hit.
    await expect(
      service.list({ agentId: 'agent-support', limit: 50, status: ['pending', 'running'] }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('starts a distinct launch after a terminal job so newly eligible targets are included', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const first = await service.start('admin', await startInput());
    await expect(runPlatformAgentRolloutBatches(db, 10)).resolves.toBeGreaterThan(0);
    await expect(
      service.get({ agentId: 'agent-support', jobId: first.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed', total: 3 });

    await db.insert(users).values({ id: 'user-c' });
    const second = await service.start('admin', await startInput());
    expect(second.jobId).not.toBe(first.jobId);
    expect(second).toMatchObject({
      assignmentId: 'assignment-global',
      status: 'pending',
      targetVersionId: 'version-2',
      total: 4,
    });
    const jobs = await db
      .select()
      .from(platformJobs)
      .where(sql`${platformJobs.type} = 'platform.agent.rollout.v1'`)
      .orderBy(sql`${platformJobs.createdAt}`);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.id).toBe(first.jobId);
    expect(jobs[1]!.id).toBe(second.jobId);
    const firstCutoff = parsePlatformAgentRolloutInput(jobs[0]!).snapshot.targetCutoff;
    const secondCutoff = parsePlatformAgentRolloutInput(jobs[1]!).snapshot.targetCutoff;
    expect(secondCutoff >= firstCutoff).toBe(true);
    expect(jobs[0]!.idempotencyKey).not.toBe(jobs[1]!.idempotencyKey);
  });

  it('uses status + JSON revision CAS for cancel/retry and rejects stale transitions', async () => {
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    const cancelled = await service.cancel('admin', {
      agentId: 'agent-support',
      expectedJobRevision: started.revision,
      expectedStatus: 'pending',
      jobId: started.jobId,
      reason: 'stop safely',
    });
    expect(cancelled).toMatchObject({ revision: 1, status: 'cancelled' });
    await expect(
      service.cancel('admin', {
        agentId: 'agent-support',
        expectedJobRevision: started.revision,
        expectedStatus: 'pending',
        jobId: started.jobId,
        reason: 'stale cancel',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);

    const retried = await service.retry('admin', {
      agentId: 'agent-support',
      expectedJobRevision: cancelled.revision,
      expectedStatus: 'cancelled',
      jobId: cancelled.jobId,
      reason: 'resume checkpoint',
    });
    expect(retried).toMatchObject({ revision: 2, status: 'pending' });
    await expect(
      service.retry('admin', {
        agentId: 'agent-support',
        expectedJobRevision: cancelled.revision,
        expectedStatus: 'cancelled',
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
      expectedStatus: 'failed',
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
      expectedStatus: 'cancelled',
      jobId: cancelled.jobId,
      reason: 'resume after lease loss',
    });
    await runPlatformAgentRolloutBatches(db, 10);
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed' });
  });

  it.runIf(runPostgres)('uses the database clock when the worker clock is in 2099', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));

    await expect(processNextPlatformAgentRolloutBatch(db, 'forward-skew-worker')).resolves.toEqual({
      claimed: true,
      jobId: started.jobId,
      terminal: true,
    });
    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 3, failed: 0, status: 'completed' });
  });

  it.runIf(runPostgres)(
    'rejects an expired checkpoint when the worker clock is in 2000',
    async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
      const service = new PlatformAgentRolloutService(db);
      const started = await service.start('admin', await startInput());
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));

      await expect(
        processNextPlatformAgentRolloutBatch(db, 'backward-skew-worker', {
          leaseMs: 20,
          lifecycle: {
            beforeBulkWrite: async () => {
              await new Promise((resolve) => setTimeout(resolve, 50));
            },
          },
        }),
      ).resolves.toEqual({ claimed: true, jobId: started.jobId, terminal: false });
      expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(0);
    },
  );

  it('returns terminal:false when invalid-payload dead-mark loses the lease', async () => {
    await db.insert(platformJobs).values({
      idempotencyKey: 'invalid-payload-poison',
      input: { not: 'a-valid-rollout-snapshot' },
      maxAttempts: 5,
      progressTotal: 0,
      requestedBy: 'admin',
      resultSummary: { failed: 0 },
      status: 'pending',
      type: 'platform.agent.rollout.v1',
    });

    await expect(
      processNextPlatformAgentRolloutBatch(db, 'poison-invalid-worker', {
        leaseMs: 25,
        lifecycle: {
          beforeMarkClaimedDead: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
      }),
    ).resolves.toEqual({ claimed: true, jobId: expect.any(String), terminal: false });

    const [job] = await db.select().from(platformJobs);
    expect(job.status).toBe('running');
    expect(job.lastError).toBeNull();
  });

  it('returns terminal:false when snapshot-conflict dead-mark loses the lease', async () => {
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    await db
      .update(platformAgentAssignments)
      .set({ enabled: false })
      .where(sql`${platformAgentAssignments.id} = 'assignment-global'`);

    await expect(
      processNextPlatformAgentRolloutBatch(db, 'poison-snapshot-worker', {
        leaseMs: 25,
        lifecycle: {
          beforeMarkClaimedDead: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
      }),
    ).resolves.toEqual({ claimed: true, jobId: started.jobId, terminal: false });

    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ status: 'running' });
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
      expectedStatus: 'failed',
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
});
