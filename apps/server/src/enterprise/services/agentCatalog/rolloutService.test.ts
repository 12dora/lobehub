// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformJobModel } from '@/database/models/platform/job';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { runPlatformAgentRolloutBatches } from '../../jobs/agentRollout';
import { PlatformAgentRevisionConflictError } from './errors';
import { platformAgentDraftToken } from './publication';
import { PlatformAgentRolloutService } from './rolloutService';

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
      previousVersionId: 'version-1',
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
        targetVersionChecksum: checksumPayload({
          config: config('Support v2'),
          dependencySnapshot: dependencies,
        }),
        targetVersionId: 'version-2',
        versionPolicy: 'latest_published',
      }),
    });
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

  it('coordinates concurrent workers across multiple bounded pages without duplicates', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    await db.insert(users).values(
      Array.from({ length: 202 }, (_, index) => ({
        id: `bulk-${String(index).padStart(4, '0')}`,
      })),
    );
    const service = new PlatformAgentRolloutService(db);
    const started = await service.start('admin', await startInput());
    await Promise.all([
      runPlatformAgentRolloutBatches(db, 10),
      runPlatformAgentRolloutBatches(db, 10),
    ]);

    await expect(
      service.get({ agentId: 'agent-support', jobId: started.jobId }),
    ).resolves.toMatchObject({ completed: 205, failed: 0, status: 'completed', total: 205 });
    expect(await db.select().from(platformUserAgentMaterializations)).toHaveLength(205);
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
    const v1Checksum = checksumPayload({
      config: config('Support v1'),
      dependencySnapshot: dependencies,
    });
    await db.insert(platformUserAgentMaterializations).values({
      lastSyncedAt: new Date(),
      platformAgentId: 'agent-support',
      platformAgentVersionChecksum: v1Checksum,
      platformAgentVersionId: 'version-1',
      status: 'pending',
      userId: 'user-a',
    });
    await db.update(platformAgents).set({ status: 'archived' });

    await runPlatformAgentRolloutBatches(db, 10);
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
        .where(sql`${platformJobs.type} = 'platform.agent.rollout.failure.v1'`),
    ).toHaveLength(3);

    await db
      .update(platformAgents)
      .set({ currentVersionId: 'version-2', publishedAt: new Date(), status: 'published' });
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
          sql`${platformJobs.type} = 'platform.agent.rollout.failure.v1' AND ${platformJobs.status} = 'failed'`,
        ),
    ).toHaveLength(0);
  });

  it('creates an explicit reverse rollout while old operation pins stay on V2 and new work uses V1', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const publish = vi.fn();
    const service = new PlatformAgentRolloutService(db, {
      invalidation: { publish },
      validateDependencies: vi.fn(async () => {}),
    });
    const started = await service.start('admin', await startInput());
    const oldOperationPin = {
      checksum: checksumPayload({
        config: config('Support v2'),
        dependencySnapshot: dependencies,
      }),
      platformAgentId: 'agent-support',
      versionId: started.targetVersionId,
    };
    await runPlatformAgentRolloutBatches(db, 10);
    const completed = await service.get({ agentId: 'agent-support', jobId: started.jobId });

    const reverse = await service.rollback('admin', {
      agentId: 'agent-support',
      expectedJobRevision: completed.revision,
      expectedStatus: completed.status,
      jobId: completed.jobId,
      reason: 'return to stable V1',
      targetVersionId: 'version-1',
    });
    expect(reverse).toMatchObject({
      previousVersionId: 'version-2',
      status: 'pending',
      targetVersionId: 'version-1',
    });
    const [identity] = await db.select().from(platformAgents);
    expect(identity.currentVersionId).toBe('version-1');
    expect(oldOperationPin.versionId).toBe('version-2');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'agent-support', revision: 3 }),
    );

    await runPlatformAgentRolloutBatches(db, 10);
    const rows = await db.select().from(platformUserAgentMaterializations);
    expect(rows.every(({ platformAgentVersionId }) => platformAgentVersionId === 'version-1')).toBe(
      true,
    );
  });

  it('rolls a pinned assignment back without changing the Agent latest pointer', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
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
});
