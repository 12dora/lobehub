// @vitest-environment node
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
  platformAgentAssignments,
  platformAgents,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
} from '@/database/schemas';

import { runPlatformAgentRolloutBatches } from '../../jobs/agentRollout';
import {
  PlatformAgentDependencyValidationError,
  PlatformAgentInvalidInputError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { platformAgentDraftToken, PlatformAgentPublicationService } from './publication';
import { PlatformAgentRolloutService } from './rolloutService';
import {
  db,
  exactChecksum,
  publishV3,
  seedMaterializations,
  startInput,
} from './rolloutService.test.fixture';

describe('PlatformAgentRolloutService rollback plane', () => {
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
        expectedStatus: 'completed',
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
      expectedStatus: 'completed',
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
        expectedStatus: 'completed',
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

  it('rolls a legacy pinned assignment back via the Agent latest pointer', async () => {
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
      expectedStatus: 'completed',
      jobId: completed.jobId,
      reason: 'return to V1',
      targetVersionId: 'version-1',
    });

    const [identity] = await db.select().from(platformAgents);
    const [assignment] = await db.select().from(platformAgentAssignments);
    expect(identity.currentVersionId).toBe('version-1');
    expect(assignment.pinnedVersionId).toBe('version-2');
    expect(assignment.versionPolicy).toBe('pinned');
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
        expectedStatus: 'completed',
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
        expectedStatus: 'completed',
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
        expectedStatus: 'completed',
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
