import type { PlatformAgentAssignmentTargetType } from '@lobechat/types';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { PlatformJobModel } from '@/database/models/platform/job';
import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import {
  platformAgentAssignments,
  type PlatformJobItem,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminPlatformAgentRolloutCancelInput,
  AdminPlatformAgentRolloutGetInput,
  AdminPlatformAgentRolloutListInput,
  AdminPlatformAgentRolloutRetryInput,
  AdminPlatformAgentRolloutRollbackInput,
  AdminPlatformAgentRolloutStartInput,
} from '../../contracts/platformAgents';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { assertExpectedPlatformAgentIdentity } from './publication';

export const PLATFORM_AGENT_ROLLOUT_JOB_TYPE = 'platform.agent.rollout.v1';
export const PLATFORM_AGENT_ROLLOUT_FAILURE_TYPE = 'platform.agent.rollout.failure.v1';
export const PLATFORM_AGENT_ROLLOUT_BATCH_SIZE = 100;

const rolloutJobInputSchema = z
  .object({
    control: z
      .object({
        phase: z.enum(['failed', 'targets']),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    snapshot: z
      .object({
        agentId: z.string().min(1).max(128),
        assignmentId: z.string().min(1).max(128),
        previousVersionId: z.string().min(1).max(128).nullable(),
        rollbackOfJobId: z.string().min(1).max(128).nullable(),
        targetId: z.string().min(1).max(128),
        targetType: z.enum(['global', 'global_role', 'user']),
        targetVersionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
        targetVersionId: z.string().min(1).max(128),
        versionPolicy: z.enum(['latest_published', 'pinned']),
      })
      .strict(),
  })
  .strict();

export type PlatformAgentRolloutJobInput = z.infer<typeof rolloutJobInputSchema>;

const rolloutResultSchema = z.object({ failed: z.number().int().nonnegative() }).passthrough();

const jobRevision = sql<number>`COALESCE((${platformJobs.input}->'control'->>'revision')::int, 0)`;

const failureUserId = sql<string>`${platformJobs.input}->>'userId'`;

const parseInput = (job: PlatformJobItem): PlatformAgentRolloutJobInput => {
  const parsed = rolloutJobInputSchema.safeParse(job.input);
  if (!parsed.success) throw new PlatformAgentInvalidInputError();
  return parsed.data;
};

const failedCount = (job: PlatformJobItem): number => {
  const parsed = rolloutResultSchema.safeParse(job.resultSummary);
  return parsed.success ? parsed.data.failed : 0;
};

const projectionStatus = (status: PlatformJobItem['status']) => {
  if (status === 'succeeded') return 'completed' as const;
  if (status === 'reserved') return 'pending' as const;
  return status;
};

const persistenceStatus = (
  status: 'cancelled' | 'completed' | 'dead' | 'failed' | 'pending' | 'running',
) => (status === 'completed' ? ('succeeded' as const) : status);

export const projectPlatformAgentRollout = (job: PlatformJobItem) => {
  const input = parseInput(job);
  const { snapshot } = input;
  return {
    assignmentId: snapshot.assignmentId,
    completed: job.progressDone,
    cursor: typeof job.cursor === 'string' ? job.cursor : null,
    failed: failedCount(job),
    jobId: job.id,
    previousVersionId: snapshot.previousVersionId,
    revision: input.control.revision,
    status: projectionStatus(job.status),
    targetVersionId: snapshot.targetVersionId,
    total: job.progressTotal ?? 0,
    updatedAt: job.updatedAt,
  };
};

const enqueueRollout = async (
  tx: Transaction,
  params: {
    idempotencyKey: string;
    input: PlatformAgentRolloutJobInput;
    progressTotal: number;
    requestedBy: string;
  },
): Promise<PlatformJobItem> => {
  const [inserted] = await tx
    .insert(platformJobs)
    .values({
      idempotencyKey: params.idempotencyKey,
      input: { ...params.input },
      maxAttempts: 5,
      progressTotal: params.progressTotal,
      requestedBy: params.requestedBy,
      resultSummary: { failed: 0 },
      status: 'pending',
      type: PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
    })
    .onConflictDoNothing({ target: [platformJobs.type, platformJobs.idempotencyKey] })
    .returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
        eq(platformJobs.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new PlatformAgentInvalidInputError();
  return existing;
};

const recordRolloutFailure = async (
  db: LobeChatDatabase,
  params: { parentJobId: string; userId: string },
) => {
  await db
    .insert(platformJobs)
    .values({
      idempotencyKey: `${params.parentJobId}:${params.userId}`,
      input: { parentJobId: params.parentJobId, userId: params.userId },
      lastError: { category: 'materialization_failed' },
      maxAttempts: 1,
      progressTotal: 1,
      status: 'failed',
      type: PLATFORM_AGENT_ROLLOUT_FAILURE_TYPE,
    })
    .onConflictDoUpdate({
      set: {
        lastError: { category: 'materialization_failed' },
        status: 'failed',
        updatedAt: new Date(),
      },
      target: [platformJobs.type, platformJobs.idempotencyKey],
    });
};

const listRolloutFailures = async (
  db: LobeChatDatabase,
  params: { cursor?: string; parentJobId: string },
) => {
  const rows = await db
    .select({ id: platformJobs.id, userId: failureUserId })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_FAILURE_TYPE),
        eq(platformJobs.status, 'failed'),
        sql`${platformJobs.input}->>'parentJobId' = ${params.parentJobId}`,
        params.cursor ? gt(failureUserId, params.cursor) : undefined,
      ),
    )
    .orderBy(asc(failureUserId))
    .limit(PLATFORM_AGENT_ROLLOUT_BATCH_SIZE + 1);
  const hasMore = rows.length > PLATFORM_AGENT_ROLLOUT_BATCH_SIZE;
  const items = hasMore ? rows.slice(0, PLATFORM_AGENT_ROLLOUT_BATCH_SIZE) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.userId ?? null) : null };
};

const appendRolloutAudit = async (
  db: Transaction | LobeChatDatabase,
  params: {
    action: string;
    actorUserId: string;
    afterDiff: Record<string, unknown>;
    reason: string;
    targetId: string;
  },
) =>
  new PlatformAuditService(db).append({
    action: params.action,
    actorUserId: params.actorUserId,
    afterDiff: params.afterDiff,
    reason: params.reason,
    result: 'success',
    targetId: params.targetId,
    targetType: 'agent',
  });

export class PlatformAgentRolloutService {
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly validateDependencies: typeof assertExactPlatformAgentDependencies;

  constructor(
    private readonly db: LobeChatDatabase,
    options: {
      invalidation?: PlatformConfigInvalidationPublisher;
      validateDependencies?: typeof assertExactPlatformAgentDependencies;
    } = {},
  ) {
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
    this.validateDependencies =
      options.validateDependencies ?? assertExactPlatformAgentDependencies;
  }

  start = async (actorUserId: string, input: AdminPlatformAgentRolloutStartInput) => {
    const job = await this.db.transaction(async (tx) => {
      const repository = new PlatformAgentCatalogRepository(tx);
      const identity = await repository.lockIdentity(input.agentId);
      if (!identity) throw new PlatformAgentNotFoundError();
      assertExpectedPlatformAgentIdentity(
        identity,
        input.expectedDraftToken,
        input.expectedRevision,
      );
      if (identity.status !== 'published' || !identity.currentVersionId) {
        throw new PlatformAgentInvalidInputError();
      }
      const assignment = await repository.getAssignment(identity.id, input.assignmentId);
      if (!assignment || !assignment.enabled || assignment.status !== 'active') {
        throw new PlatformAgentNotFoundError();
      }
      const targetVersionId =
        assignment.versionPolicy === 'pinned'
          ? assignment.pinnedVersionId
          : identity.currentVersionId;
      if (!targetVersionId) throw new PlatformAgentInvalidInputError();
      const target = await repository.getExactVersion(identity.id, targetVersionId);
      if (!target) throw new PlatformAgentNotFoundError();
      const previous = await repository.getPreviousExactVersion(identity.id, target.id);
      const progressTotal = await repository.countAssignmentTargets(assignment);
      const idempotencyKey = [
        identity.id,
        assignment.id,
        identity.revision,
        identity.draftSequence,
        target.id,
      ].join(':');
      const created = await enqueueRollout(tx, {
        idempotencyKey,
        input: {
          control: { phase: 'targets', revision: 0 },
          snapshot: {
            agentId: identity.id,
            assignmentId: assignment.id,
            previousVersionId: previous?.id ?? null,
            rollbackOfJobId: null,
            targetId: assignment.targetId,
            targetType: assignment.targetType,
            targetVersionChecksum: target.checksum,
            targetVersionId: target.id,
            versionPolicy: assignment.versionPolicy,
          },
        },
        progressTotal,
        requestedBy: actorUserId,
      });
      await appendRolloutAudit(tx, {
        action: 'admin.agents.rollouts.start',
        actorUserId,
        afterDiff: {
          assignmentId: assignment.id,
          jobId: created.id,
          targetVersionId: target.id,
          total: progressTotal,
        },
        reason: input.reason,
        targetId: identity.id,
      });
      return created;
    });
    return projectPlatformAgentRollout(job);
  };

  get = async (input: AdminPlatformAgentRolloutGetInput) => {
    const [job] = await this.db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.id, input.jobId),
          eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
          sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
        ),
      )
      .limit(1);
    if (!job) throw new PlatformAgentNotFoundError();
    return projectPlatformAgentRollout(job);
  };

  list = async (input: AdminPlatformAgentRolloutListInput) => {
    const limit = input.limit ?? 50;
    const rows = await this.db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
          sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
          input.cursor ? lt(platformJobs.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(platformJobs.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(projectPlatformAgentRollout),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  };

  cancel = async (actorUserId: string, input: AdminPlatformAgentRolloutCancelInput) =>
    this.transition(actorUserId, input, 'cancel');

  retry = async (actorUserId: string, input: AdminPlatformAgentRolloutRetryInput) =>
    this.transition(actorUserId, input, 'retry');

  rollback = async (actorUserId: string, input: AdminPlatformAgentRolloutRollbackInput) => {
    const result = await this.db.transaction(async (tx) => {
      const [original] = await tx
        .select()
        .from(platformJobs)
        .where(
          and(
            eq(platformJobs.id, input.jobId),
            eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
            eq(platformJobs.status, persistenceStatus(input.expectedStatus)),
            eq(jobRevision, input.expectedJobRevision),
            sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
          ),
        )
        .for('update')
        .limit(1);
      if (!original) throw new PlatformAgentRevisionConflictError();
      if (original.status !== 'succeeded') throw new PlatformAgentRevisionConflictError();
      const originalInput = parseInput(original);
      if (
        originalInput.snapshot.previousVersionId !== input.targetVersionId ||
        input.targetVersionId === originalInput.snapshot.targetVersionId
      ) {
        throw new PlatformAgentInvalidInputError();
      }

      const repository = new PlatformAgentCatalogRepository(tx);
      await acquirePlatformAgentReferenceLock(tx, input.agentId);
      const identity = await repository.lockIdentity(input.agentId);
      if (!identity) throw new PlatformAgentNotFoundError();
      const target = await repository.getExactVersion(identity.id, input.targetVersionId);
      if (!target) throw new PlatformAgentNotFoundError();
      await acquirePlatformDependencyPublicationLock(tx);
      await this.validateDependencies(tx, target.dependencySnapshot);
      let updatedIdentity;
      if (originalInput.snapshot.versionPolicy === 'pinned') {
        const [assignment] = await tx
          .update(platformAgentAssignments)
          .set({ pinnedVersionId: target.id, updatedAt: new Date() })
          .where(
            and(
              eq(platformAgentAssignments.id, originalInput.snapshot.assignmentId),
              eq(platformAgentAssignments.agentId, identity.id),
              eq(platformAgentAssignments.enabled, true),
              eq(platformAgentAssignments.status, 'active'),
              eq(platformAgentAssignments.versionPolicy, 'pinned'),
              eq(platformAgentAssignments.pinnedVersionId, originalInput.snapshot.targetVersionId),
            ),
          )
          .returning({ id: platformAgentAssignments.id });
        if (!assignment) throw new PlatformAgentRevisionConflictError();
        updatedIdentity = await repository.updateDraftCas({
          expectedDraftSequence: identity.draftSequence,
          expectedRevision: identity.revision,
          id: identity.id,
          patch: { updatedBy: actorUserId },
        });
      } else {
        if (identity.currentVersionId !== originalInput.snapshot.targetVersionId) {
          throw new PlatformAgentRevisionConflictError();
        }
        updatedIdentity = await repository.pointToVersionCas({
          agentId: identity.id,
          expectedDraftSequence: identity.draftSequence,
          expectedRevision: identity.revision,
          publishedAt: new Date(),
          versionId: target.id,
        });
      }
      if (!updatedIdentity) throw new PlatformAgentRevisionConflictError();

      const progressTotal = original.progressTotal ?? 0;
      const rollbackJob = await enqueueRollout(tx, {
        idempotencyKey: `rollback:${original.id}:${input.expectedJobRevision}:${target.id}`,
        input: {
          control: { phase: 'targets', revision: 0 },
          snapshot: {
            ...originalInput.snapshot,
            previousVersionId: originalInput.snapshot.targetVersionId,
            rollbackOfJobId: original.id,
            targetVersionChecksum: target.checksum,
            targetVersionId: target.id,
          },
        },
        progressTotal,
        requestedBy: actorUserId,
      });
      const consumedInput = {
        ...originalInput,
        control: { ...originalInput.control, revision: originalInput.control.revision + 1 },
      };
      const [consumed] = await tx
        .update(platformJobs)
        .set({ input: consumedInput, updatedAt: new Date() })
        .where(
          and(eq(platformJobs.id, original.id), eq(jobRevision, originalInput.control.revision)),
        )
        .returning({ id: platformJobs.id });
      if (!consumed) throw new PlatformAgentRevisionConflictError();
      await appendRolloutAudit(tx, {
        action: 'admin.agents.rollouts.rollback',
        actorUserId,
        afterDiff: {
          fromJobId: original.id,
          jobId: rollbackJob.id,
          revision: updatedIdentity.revision,
          targetVersionId: target.id,
        },
        reason: input.reason,
        targetId: identity.id,
      });
      return { identityRevision: updatedIdentity.revision, job: rollbackJob };
    });
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: input.agentId,
        resourceType: 'agent',
        revision: result.identityRevision,
        scopes: ['agent-catalog', 'agent-runtime'],
      });
    } catch (error) {
      console.error('[platform-agent-rollout:rollback] invalidation failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return projectPlatformAgentRollout(result.job);
  };

  private transition = async (
    actorUserId: string,
    input: AdminPlatformAgentRolloutCancelInput | AdminPlatformAgentRolloutRetryInput,
    action: 'cancel' | 'retry',
  ) => {
    const job = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(platformJobs)
        .where(
          and(
            eq(platformJobs.id, input.jobId),
            eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
            eq(platformJobs.status, persistenceStatus(input.expectedStatus)),
            eq(jobRevision, input.expectedJobRevision),
            sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
          ),
        )
        .for('update')
        .limit(1);
      if (!current) throw new PlatformAgentRevisionConflictError();
      if (
        (action === 'cancel' && !['pending', 'running'].includes(current.status)) ||
        (action === 'retry' && !['cancelled', 'dead', 'failed'].includes(current.status))
      ) {
        throw new PlatformAgentRevisionConflictError();
      }
      const currentInput = parseInput(current);
      const nextInput = {
        ...currentInput,
        control: {
          phase:
            action === 'retry' && current.status === 'failed'
              ? ('failed' as const)
              : currentInput.control.phase,
          revision: currentInput.control.revision + 1,
        },
      };
      const [updated] = await tx
        .update(platformJobs)
        .set(
          action === 'cancel'
            ? {
                finishedAt: new Date(),
                input: nextInput,
                leaseOwner: null,
                leaseUntil: null,
                status: 'cancelled',
                updatedAt: new Date(),
              }
            : {
                cursor: current.status === 'failed' ? null : current.cursor,
                finishedAt: null,
                input: nextInput,
                lastError: null,
                leaseOwner: null,
                leaseUntil: null,
                maxAttempts: Math.max(current.maxAttempts ?? 0, current.attempt + 3),
                progressDone: current.progressDone,
                resultSummary: current.resultSummary,
                status: 'pending',
                updatedAt: new Date(),
              },
        )
        .where(
          and(
            eq(platformJobs.id, current.id),
            eq(platformJobs.status, current.status),
            eq(jobRevision, currentInput.control.revision),
          ),
        )
        .returning();
      if (!updated) throw new PlatformAgentRevisionConflictError();
      await appendRolloutAudit(tx, {
        action: `admin.agents.rollouts.${action}`,
        actorUserId,
        afterDiff: {
          jobId: updated.id,
          revision: nextInput.control.revision,
          status: updated.status,
        },
        reason: input.reason,
        targetId: input.agentId,
      });
      return updated;
    });
    return projectPlatformAgentRollout(job);
  };
}

export interface ProcessPlatformAgentRolloutBatchResult {
  claimed: boolean;
  jobId?: string;
  terminal?: boolean;
}

export const processNextPlatformAgentRolloutBatch = async (
  db: LobeChatDatabase,
  workerId: string,
): Promise<ProcessPlatformAgentRolloutBatchResult> => {
  const jobs = new PlatformJobModel(db);
  const claimed = await jobs.claimNext({
    leaseMs: 60_000,
    types: [PLATFORM_AGENT_ROLLOUT_JOB_TYPE],
    workerId,
  });
  if (!claimed) return { claimed: false };

  let input: PlatformAgentRolloutJobInput;
  try {
    input = parseInput(claimed);
  } catch {
    await jobs.fail({
      error: { category: 'invalid_rollout_snapshot' },
      jobId: claimed.id,
      terminal: true,
      workerId,
    });
    return { claimed: true, jobId: claimed.id, terminal: true };
  }

  const repository = new PlatformAgentCatalogRepository(db);
  const current = await jobs.findById(claimed.id);
  if (!current || current.status !== 'running' || current.leaseOwner !== workerId) {
    return { claimed: true, jobId: claimed.id, terminal: true };
  }
  const completedBefore = current.progressDone;
  const failedBefore = failedCount(current);
  const { snapshot } = input;
  const remaining = Math.max(0, (current.progressTotal ?? 0) - completedBefore - failedBefore);
  let nextCursor: string | null;
  let targets: Array<{ id: string | null; userId: string }>;
  if (input.control.phase === 'failed') {
    const failures = await listRolloutFailures(db, {
      cursor: typeof current.cursor === 'string' ? current.cursor : undefined,
      parentJobId: current.id,
    });
    targets = failures.items;
    nextCursor = failures.nextCursor;
  } else {
    const targetPage = await repository.listAssignmentTargetUserIds({
      cursor: typeof current.cursor === 'string' ? current.cursor : undefined,
      limit: Math.min(
        PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
        remaining || PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
      ),
      targetId: snapshot.targetId,
      targetType: snapshot.targetType as PlatformAgentAssignmentTargetType,
    });
    targets = targetPage.items.slice(0, remaining).map((userId) => ({ id: null, userId }));
    nextCursor = targetPage.nextCursor;
  }
  let completed = completedBefore;
  let failed = failedBefore;

  for (const target of targets) {
    const { userId } = target;
    try {
      const existing = await repository.getMaterialization(userId, snapshot.agentId);
      const alreadyApplied =
        existing?.platformAgentVersionId === snapshot.targetVersionId &&
        existing.platformAgentVersionChecksum === snapshot.targetVersionChecksum &&
        existing.lastSyncedAt !== null &&
        existing.status !== 'error';
      if (!alreadyApplied) {
        const written = await repository.upsertMaterialization({
          expectedCurrent:
            existing && (existing.lastSyncedAt !== null || existing.materializedAgentId !== null)
              ? {
                  checksum: existing.platformAgentVersionChecksum,
                  versionId: existing.platformAgentVersionId,
                }
              : undefined,
          lastErrorCategory: null,
          platformAgentId: snapshot.agentId,
          platformAgentVersionChecksum: snapshot.targetVersionChecksum,
          platformAgentVersionId: snapshot.targetVersionId,
          status: 'pending',
          userId,
        });
        if (!written) throw new PlatformAgentRevisionConflictError();
      }
      completed += 1;
      if (input.control.phase === 'failed') {
        failed -= 1;
        await db
          .update(platformJobs)
          .set({
            finishedAt: new Date(),
            lastError: null,
            progressDone: 1,
            status: 'succeeded',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(platformJobs.id, target.id!),
              eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_FAILURE_TYPE),
              eq(platformJobs.status, 'failed'),
            ),
          );
      }
    } catch {
      if (input.control.phase === 'targets') failed += 1;
      await recordRolloutFailure(db, { parentJobId: current.id, userId });
    }
  }

  const cursor =
    targets.at(-1)?.userId ?? (typeof current.cursor === 'string' ? current.cursor : null);
  const terminal =
    input.control.phase === 'failed'
      ? nextCursor === null
      : completed + failed >= (current.progressTotal ?? 0) || nextCursor === null;
  const nextInput = {
    ...input,
    control: { ...input.control, revision: input.control.revision + 1 },
  };
  const now = new Date();
  const [checkpointed] = await db
    .update(platformJobs)
    .set({
      cursor,
      ...(terminal
        ? {
            finishedAt: now,
            lastError: failed > 0 ? { category: 'rollout_items_failed' } : null,
            leaseOwner: null,
            leaseUntil: null,
            status: failed > 0 ? ('failed' as const) : ('succeeded' as const),
          }
        : {
            heartbeatAt: now,
            leaseOwner: null,
            leaseUntil: null,
            status: 'pending' as const,
          }),
      input: nextInput,
      progressDone: completed,
      resultSummary: { failed },
      updatedAt: now,
    })
    .where(
      and(
        eq(platformJobs.id, current.id),
        eq(platformJobs.status, 'running'),
        eq(platformJobs.leaseOwner, workerId),
        eq(jobRevision, input.control.revision),
      ),
    )
    .returning({ id: platformJobs.id });
  return { claimed: true, jobId: claimed.id, terminal: terminal || !checkpointed };
};
