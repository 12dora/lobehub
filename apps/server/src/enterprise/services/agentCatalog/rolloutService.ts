import { randomUUID } from 'node:crypto';

import debug from 'debug';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import {
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
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
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentDependencyValidationError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
  redactPlatformReadError,
} from './errors';
import { assertExpectedPlatformAgentIdentity } from './publication';
import {
  applyRollbackPointer,
  assertRollbackTransitionProof,
  loadRollbackOriginJob,
} from './rolloutRollback';
import type { PlatformAgentRolloutJobInput } from './rolloutShared';
import {
  getPlatformAgentRolloutResult,
  parsePlatformAgentRolloutInput,
  persistenceStatus,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  platformAgentRolloutCutoffSchema,
  platformAgentRolloutJobRevision,
} from './rolloutShared';

export { PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE };
export type { PlatformAgentRolloutJobInput } from './rolloutShared';
export {
  getPlatformAgentRolloutResult,
  parsePlatformAgentRolloutInput,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  platformAgentRolloutJobRevision,
} from './rolloutShared';
export const PLATFORM_AGENT_ROLLOUT_BATCH_SIZE = 100;

const log = debug('lobe-server:platform-agent-rollout');

export const platformAgentRolloutTransitionInputSchema = z
  .object({
    assignmentId: z.string().min(1).max(128),
    parentAttempt: z.number().int().positive(),
    parentJobId: z.string().min(1).max(128),
    parentRevision: z.number().int().nonnegative(),
    previousVersionChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    previousVersionId: z.string().min(1).max(128).nullable(),
    targetId: z.string().min(1).max(128),
    targetType: z.enum(['global', 'global_role', 'user']),
    targetVersionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    targetVersionId: z.string().min(1).max(128),
    userId: z.string().min(1).max(128),
    versionPolicy: z.enum(['latest_published', 'pinned']),
  })
  .strict();

export type PlatformAgentRolloutTransitionInput = z.infer<
  typeof platformAgentRolloutTransitionInputSchema
>;

const databaseNow = sql<Date>`statement_timestamp()`;

const projectionStatus = (status: PlatformJobItem['status']) => {
  if (status === 'succeeded') return 'completed' as const;
  if (status === 'reserved') return 'pending' as const;
  return status;
};

/** Map one or more projection statuses to the platform_jobs rows they cover. */
const persistenceStatusesForFilter = (
  statuses: Array<'cancelled' | 'completed' | 'dead' | 'failed' | 'pending' | 'running'>,
): PlatformJobItem['status'][] => {
  const out = new Set<PlatformJobItem['status']>();
  for (const status of statuses) {
    if (status === 'pending') {
      // Reserved jobs project as pending — include both so active filters stay complete.
      out.add('pending');
      out.add('reserved');
    } else if (status === 'completed') {
      out.add('succeeded');
    } else {
      out.add(status);
    }
  }
  return [...out];
};

export interface PlatformAgentRolloutControlInput {
  action: 'cancel' | 'retry';
  agentId?: string;
  expectedRevision: number;
  expectedStatus: PlatformJobItem['status'];
  jobId: string;
}

/** Shared authoritative cancel/retry state machine for every administrative API surface. */
export const controlPlatformAgentRolloutJob = async (
  db: Transaction,
  input: PlatformAgentRolloutControlInput,
): Promise<PlatformJobItem> => {
  const [current] = await db
    .select()
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.id, input.jobId),
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
        eq(platformJobs.status, input.expectedStatus),
        eq(platformAgentRolloutJobRevision, input.expectedRevision),
        input.agentId
          ? sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`
          : undefined,
      ),
    )
    .for('update')
    .limit(1);
  if (!current) throw new PlatformAgentRevisionConflictError();
  if (
    (input.action === 'cancel' && !['pending', 'running'].includes(current.status)) ||
    (input.action === 'retry' && !['cancelled', 'dead', 'failed'].includes(current.status))
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
  const currentInput = parsePlatformAgentRolloutInput(current);
  const nextInput = {
    ...currentInput,
    control: {
      phase:
        input.action === 'retry' && current.status === 'failed'
          ? ('failed' as const)
          : currentInput.control.phase,
      revision: currentInput.control.revision + 1,
    },
  };
  const [updated] = await db
    .update(platformJobs)
    .set(
      input.action === 'cancel'
        ? {
            finishedAt: databaseNow,
            input: nextInput,
            leaseOwner: null,
            leaseUntil: null,
            status: 'cancelled',
            updatedAt: databaseNow,
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
            updatedAt: databaseNow,
          },
    )
    .where(
      and(
        eq(platformJobs.id, current.id),
        eq(platformJobs.status, current.status),
        eq(platformAgentRolloutJobRevision, currentInput.control.revision),
      ),
    )
    .returning();
  if (!updated) throw new PlatformAgentRevisionConflictError();
  return updated;
};

export const projectPlatformAgentRollout = (job: PlatformJobItem) => {
  const input = parsePlatformAgentRolloutInput(job);
  const { snapshot } = input;
  const result = getPlatformAgentRolloutResult(job);
  return {
    assignmentId: snapshot.assignmentId,
    completed: job.progressDone,
    cursor: typeof job.cursor === 'string' ? job.cursor : null,
    failed: result.failed,
    jobId: job.id,
    previousVersionId: result.previousVersionId ?? snapshot.previousVersionId,
    revision: input.control.revision,
    status: projectionStatus(job.status),
    targetVersionId: snapshot.targetVersionId,
    total: job.progressTotal ?? 0,
    updatedAt: job.updatedAt,
  };
};

/**
 * Active launch for the same assignment + target version. Callers hold the agent identity lock
 * so concurrent starts serialize and collapse onto one in-flight job rather than minting a second.
 * Terminal jobs are intentionally excluded so a later start can include newly eligible targets.
 */
const findActiveRollout = async (
  tx: Transaction,
  params: {
    agentId: string;
    assignmentId: string;
    targetVersionChecksum: string;
    targetVersionId: string;
  },
): Promise<PlatformJobItem | undefined> => {
  const [existing] = await tx
    .select()
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
        inArray(platformJobs.status, ['pending', 'reserved', 'running']),
        // Launch collapse only — an in-flight rollback shares agent/assignment/target
        // version coords but must not absorb a fresh Start rollout (different cutoff).
        sql`${platformJobs.input}->'snapshot'->>'rollbackOfJobId' IS NULL`,
        sql`${platformJobs.input}->'snapshot'->>'agentId' = ${params.agentId}`,
        sql`${platformJobs.input}->'snapshot'->>'assignmentId' = ${params.assignmentId}`,
        sql`${platformJobs.input}->'snapshot'->>'targetVersionId' = ${params.targetVersionId}`,
        sql`${platformJobs.input}->'snapshot'->>'targetVersionChecksum' = ${params.targetVersionChecksum}`,
      ),
    )
    .orderBy(desc(platformJobs.createdAt))
    .limit(1);
  return existing;
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

const appendRolloutAudit = async (
  db: Transaction | LobeChatDatabase,
  params: {
    action: AuditAction;
    actorUserId: string;
    afterDiff: Record<string, unknown>;
    reason?: string | null;
    result: 'failure' | 'success';
    targetId: string;
  },
) =>
  new PlatformAuditService(db).append({
    action: params.action,
    actorUserId: params.actorUserId,
    afterDiff: params.afterDiff,
    reason: params.reason,
    result: params.result,
    targetId: params.targetId,
    targetType: 'agent',
  });

const rolloutFailureCategory = (error: unknown): string => {
  if (error instanceof PlatformAgentRevisionConflictError) return 'revision_conflict';
  if (error instanceof PlatformAgentDependencyValidationError) {
    return 'dependency_validation_failed';
  }
  if (error instanceof PlatformAgentNotFoundError) return 'not_found';
  if (error instanceof PlatformAgentInvalidInputError) return 'invalid_input';
  return 'rollout_mutation_failed';
};

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

  /**
   * Success audit is atomic with the mutation. A rejected/failed mutation rolls back first, then
   * appends a stable redacted failure category on a fresh transaction. If the database itself is
   * unavailable, that second append is best-effort and emits an observable debug event; it is not
   * falsely described as atomic delivery.
   */
  private auditedMutation = async <T>(params: {
    action: AuditAction;
    actorUserId: string;
    reason?: string | null;
    run: (tx: Transaction) => Promise<T>;
    summarize: (result: T) => Record<string, unknown>;
    targetId: string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(async (tx) => {
        const result = await params.run(tx);
        await appendRolloutAudit(tx, {
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: params.summarize(result),
          reason: params.reason,
          result: 'success',
          targetId: params.targetId,
        });
        return result;
      });
    } catch (error) {
      try {
        await appendRolloutAudit(this.db, {
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: { error: rolloutFailureCategory(error) },
          reason: params.reason,
          result: 'failure',
          targetId: params.targetId,
        });
      } catch (auditError) {
        log(
          'failure audit append unavailable action=%s class=%s',
          params.action,
          auditError instanceof Error ? auditError.name : 'UnknownError',
        );
      }
      throw redactPlatformReadError(error);
    }
  };

  start = async (actorUserId: string, input: AdminPlatformAgentRolloutStartInput) => {
    const job = await this.auditedMutation({
      action: 'admin.agents.rollouts.start',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const identity = await repository.lockIdentity(input.agentId);
        if (!identity) throw new PlatformAgentNotFoundError();
        assertExpectedPlatformAgentIdentity(
          identity,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        if (
          identity.status !== 'published' ||
          !identity.currentVersionId ||
          identity.systemKey === 'default-inbox'
        ) {
          // Default inbox has no ordinary per-user materialization to reverse. Its V2→V1 rollback
          // is the publication pointer CAS, which preserves old operation pins and changes new work.
          throw new PlatformAgentInvalidInputError();
        }
        const assignment = await repository.getAssignment(identity.id, input.assignmentId);
        if (!assignment || !assignment.enabled || assignment.status !== 'active') {
          throw new PlatformAgentNotFoundError();
        }
        const targetVersionId = identity.currentVersionId;
        if (!targetVersionId) throw new PlatformAgentInvalidInputError();
        const target = await repository.getExactVersion(identity.id, targetVersionId);
        if (!target) throw new PlatformAgentNotFoundError();
        const clockResult = await tx.execute(
          sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`,
        );
        const [clock] = clockResult.rows as unknown as Array<{ cutoff: string }>;
        if (!clock?.cutoff) throw new PlatformAgentInvalidInputError();
        const targetCutoff = platformAgentRolloutCutoffSchema.parse(clock.cutoff);
        const progressTotal = await repository.countAssignmentTargets({
          ...assignment,
          cutoff: targetCutoff,
        });
        // Collapse concurrent starts for the same assignment/version onto the in-flight job.
        // Once that job is terminal, a later start must mint a new launch (with a fresh cutoff)
        // so newly eligible users are included.
        const active = await findActiveRollout(tx, {
          agentId: identity.id,
          assignmentId: assignment.id,
          targetVersionChecksum: target.checksum,
          targetVersionId: target.id,
        });
        if (active) return active;
        // Launch id keeps the unique (type, idempotency_key) constraint while allowing relaunch
        // after terminal completion. Identity lock above serializes concurrent inserts.
        const launchId = randomUUID();
        const idempotencyKey = [
          identity.id,
          assignment.id,
          identity.revision,
          identity.draftSequence,
          assignment.targetType,
          assignment.targetId,
          target.id,
          target.checksum,
          launchId,
        ].join(':');
        return enqueueRollout(tx, {
          idempotencyKey,
          input: {
            control: { phase: 'targets', revision: 0 },
            snapshot: {
              agentId: identity.id,
              assignmentId: assignment.id,
              previousVersionChecksum: null,
              previousVersionId: null,
              rollbackOfJobId: null,
              targetCutoff,
              targetId: assignment.targetId,
              targetType: assignment.targetType,
              targetVersionChecksum: target.checksum,
              targetVersionId: target.id,
              versionPolicy: 'latest_published',
            },
          },
          progressTotal,
          requestedBy: actorUserId,
        });
      },
      summarize: (created) => ({
        assignmentId: parsePlatformAgentRolloutInput(created).snapshot.assignmentId,
        jobId: created.id,
        targetVersionId: parsePlatformAgentRolloutInput(created).snapshot.targetVersionId,
        total: created.progressTotal ?? 0,
      }),
      targetId: input.agentId,
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
    const statusFilter =
      input.status && input.status.length > 0
        ? inArray(platformJobs.status, persistenceStatusesForFilter(input.status))
        : undefined;
    const rows = await this.db
      .select()
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
          sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
          statusFilter,
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
    const result = await this.auditedMutation({
      action: 'admin.agents.rollouts.rollback',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const { original, originalInput, rolloutResult } = await loadRollbackOriginJob(tx, input);
        await assertRollbackTransitionProof(tx, original, rolloutResult);

        const repository = new PlatformAgentCatalogRepository(tx);
        await acquirePlatformAgentReferenceLock(tx, input.agentId);
        const identity = await repository.lockIdentity(input.agentId);
        if (!identity || identity.systemKey === 'default-inbox') {
          throw new PlatformAgentInvalidInputError();
        }
        const currentTarget = await repository.getExactVersion(
          identity.id,
          originalInput.snapshot.targetVersionId,
        );
        const target = await repository.getExactVersion(identity.id, input.targetVersionId);
        if (
          !currentTarget ||
          currentTarget.checksum !== originalInput.snapshot.targetVersionChecksum ||
          !target ||
          target.checksum !== rolloutResult.previousVersionChecksum
        ) {
          throw new PlatformAgentRevisionConflictError();
        }
        await acquirePlatformDependencyPublicationLock(tx);
        await this.validateDependencies(tx, target.dependencySnapshot);
        const updatedIdentity = await applyRollbackPointer(tx, {
          actorUserId,
          identity,
          originalInput,
          target,
        });

        const rollbackJob = await enqueueRollout(tx, {
          idempotencyKey: `rollback:${original.id}:${input.expectedJobRevision}:${target.id}:${target.checksum}`,
          input: {
            control: { phase: 'targets', revision: 0 },
            snapshot: {
              ...originalInput.snapshot,
              previousVersionChecksum: null,
              previousVersionId: null,
              rollbackOfJobId: original.id,
              targetVersionChecksum: target.checksum,
              targetVersionId: target.id,
            },
          },
          progressTotal: original.progressTotal ?? 0,
          requestedBy: actorUserId,
        });
        const consumedInput = {
          ...originalInput,
          control: { ...originalInput.control, revision: originalInput.control.revision + 1 },
        };
        const [consumed] = await tx
          .update(platformJobs)
          .set({ input: consumedInput, updatedAt: databaseNow })
          .where(
            and(
              eq(platformJobs.id, original.id),
              eq(platformAgentRolloutJobRevision, originalInput.control.revision),
            ),
          )
          .returning({ id: platformJobs.id });
        if (!consumed) throw new PlatformAgentRevisionConflictError();
        return { identityRevision: updatedIdentity.revision, job: rollbackJob };
      },
      summarize: ({ identityRevision, job }) => ({
        fromJobId: input.jobId,
        jobId: job.id,
        revision: identityRevision,
        targetVersionId: input.targetVersionId,
      }),
      targetId: input.agentId,
    });
    let invalidationStatus: 'deferred' | 'delivered' = 'delivered';
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: input.agentId,
        resourceType: 'agent',
        revision: result.identityRevision,
        scopes: ['agent-catalog', 'agent-runtime'],
      });
    } catch (error) {
      invalidationStatus = 'deferred';
      log(
        'rollback invalidation failed errorClass=%s',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
    return { ...projectPlatformAgentRollout(result.job), invalidationStatus };
  };

  private transition = async (
    actorUserId: string,
    input: AdminPlatformAgentRolloutCancelInput | AdminPlatformAgentRolloutRetryInput,
    action: 'cancel' | 'retry',
  ) => {
    const job = await this.auditedMutation({
      action: `admin.agents.rollouts.${action}`,
      actorUserId,
      reason: input.reason,
      run: (tx) =>
        controlPlatformAgentRolloutJob(tx, {
          action,
          agentId: input.agentId,
          expectedRevision: input.expectedJobRevision,
          expectedStatus: persistenceStatus(input.expectedStatus),
          jobId: input.jobId,
        }),
      summarize: (updated) => ({
        jobId: updated.id,
        revision: parsePlatformAgentRolloutInput(updated).control.revision,
        status: updated.status,
      }),
      targetId: input.agentId,
    });
    return projectPlatformAgentRollout(job);
  };
}
