import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { PlatformJobItem } from '@/database/schemas/platform';
import { platformJobs } from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';
import type {
  PlatformAgentRolloutJobInput,
  PlatformAgentRolloutTransitionInput,
} from './rolloutService';
import {
  PLATFORM_AGENT_ROLLOUT_BATCH_SIZE,
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  platformAgentRolloutTransitionInputSchema,
} from './rolloutService';

const transitionUserId = sql<string>`${platformJobs.input}->>'userId'`;
const databaseNow = sql<Date>`statement_timestamp()`;

export interface TransitionTarget {
  previousVersionChecksum: string | null;
  previousVersionId: string | null;
  userId: string;
}

export const listFailedTransitions = async (
  tx: Transaction,
  params: { cursor?: string; parentJobId: string },
) => {
  const rows = await tx
    .select({ input: platformJobs.input })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE),
        eq(platformJobs.status, 'failed'),
        sql`${platformJobs.input}->>'parentJobId' = ${params.parentJobId}`,
        params.cursor ? gt(transitionUserId, params.cursor) : undefined,
      ),
    )
    .orderBy(asc(transitionUserId))
    .limit(PLATFORM_AGENT_ROLLOUT_BATCH_SIZE + 1);
  const parsed = rows.map(({ input }) => {
    const result = platformAgentRolloutTransitionInputSchema.safeParse(input);
    if (!result.success) throw new PlatformAgentInvalidInputError();
    return result.data;
  });
  const hasMore = parsed.length > PLATFORM_AGENT_ROLLOUT_BATCH_SIZE;
  const items = hasMore ? parsed.slice(0, PLATFORM_AGENT_ROLLOUT_BATCH_SIZE) : parsed;
  return { items, nextCursor: hasMore ? (items.at(-1)?.userId ?? null) : null };
};

export const upsertTransitionLedger = async (
  tx: Transaction,
  params: {
    appliedUserIds: ReadonlySet<string>;
    input: PlatformAgentRolloutJobInput;
    job: PlatformJobItem;
    targets: TransitionTarget[];
  },
) => {
  if (params.targets.length === 0) return;
  if (params.targets.length > PLATFORM_AGENT_ROLLOUT_BATCH_SIZE) {
    throw new PlatformAgentInvalidInputError();
  }
  const { snapshot } = params.input;
  const values = params.targets.map((target) => {
    const succeeded = params.appliedUserIds.has(target.userId);
    const input: PlatformAgentRolloutTransitionInput = {
      assignmentId: snapshot.assignmentId,
      parentAttempt: params.job.attempt,
      parentJobId: params.job.id,
      parentRevision: params.input.control.revision,
      previousVersionChecksum: target.previousVersionChecksum,
      previousVersionId: target.previousVersionId,
      targetId: snapshot.targetId,
      targetType: snapshot.targetType,
      targetVersionChecksum: snapshot.targetVersionChecksum,
      targetVersionId: snapshot.targetVersionId,
      userId: target.userId,
      versionPolicy: snapshot.versionPolicy,
    };
    return {
      finishedAt: succeeded ? databaseNow : null,
      idempotencyKey: `${params.job.id}:${target.userId}`,
      input,
      lastError: succeeded ? null : { category: 'materialization_failed' },
      maxAttempts: 1,
      progressDone: succeeded ? 1 : 0,
      progressTotal: 1,
      status: succeeded ? ('succeeded' as const) : ('failed' as const),
      type: PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
    };
  });
  const ledgerRows = await tx
    .insert(platformJobs)
    .values(values)
    .onConflictDoUpdate({
      set: {
        finishedAt: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN ${platformJobs.finishedAt} ELSE excluded.finished_at END`,
        input: sql`${platformJobs.input} || jsonb_build_object('parentAttempt', excluded.input->'parentAttempt', 'parentRevision', excluded.input->'parentRevision')`,
        lastError: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN NULL ELSE excluded.last_error END`,
        progressDone: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN 1 ELSE excluded.progress_done END`,
        status: sql`CASE WHEN ${platformJobs.status} = 'succeeded' THEN 'succeeded' ELSE excluded.status END`,
        updatedAt: databaseNow,
      },
      target: [platformJobs.type, platformJobs.idempotencyKey],
      where: and(
        sql`${platformJobs.input}->>'parentJobId' = excluded.input->>'parentJobId'`,
        sql`${platformJobs.input}->>'assignmentId' = excluded.input->>'assignmentId'`,
        sql`${platformJobs.input}->>'targetType' = excluded.input->>'targetType'`,
        sql`${platformJobs.input}->>'targetId' = excluded.input->>'targetId'`,
        sql`${platformJobs.input}->>'userId' = excluded.input->>'userId'`,
        sql`${platformJobs.input}->>'versionPolicy' = excluded.input->>'versionPolicy'`,
        sql`${platformJobs.input}->>'targetVersionId' = excluded.input->>'targetVersionId'`,
        sql`${platformJobs.input}->>'targetVersionChecksum' = excluded.input->>'targetVersionChecksum'`,
        sql`(${platformJobs.input}->>'previousVersionId') IS NOT DISTINCT FROM (excluded.input->>'previousVersionId')`,
        sql`(${platformJobs.input}->>'previousVersionChecksum') IS NOT DISTINCT FROM (excluded.input->>'previousVersionChecksum')`,
        sql`COALESCE((${platformJobs.input}->>'parentAttempt')::int, 0) <= (excluded.input->>'parentAttempt')::int`,
      ),
    })
    .returning({ id: platformJobs.id });
  if (ledgerRows.length !== params.targets.length) {
    throw new PlatformAgentRevisionConflictError();
  }
};

export const deriveUniformPrevious = async (
  tx: Transaction,
  params: { parentJobId: string; targetVersionId: string; total: number },
) => {
  if (params.total === 0) return { checksum: null, versionId: null };
  const [proof] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      maxChecksum: sql<string | null>`max(${platformJobs.input}->>'previousVersionChecksum')`,
      maxVersionId: sql<string | null>`max(${platformJobs.input}->>'previousVersionId')`,
      minChecksum: sql<string | null>`min(${platformJobs.input}->>'previousVersionChecksum')`,
      minVersionId: sql<string | null>`min(${platformJobs.input}->>'previousVersionId')`,
      nullCount: sql<number>`count(*) FILTER (WHERE ${platformJobs.input}->>'previousVersionId' IS NULL OR ${platformJobs.input}->>'previousVersionChecksum' IS NULL)::int`,
    })
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE),
        sql`${platformJobs.input}->>'parentJobId' = ${params.parentJobId}`,
      ),
    );
  const uniform =
    proof &&
    proof.count === params.total &&
    proof.nullCount === 0 &&
    proof.minVersionId === proof.maxVersionId &&
    proof.minChecksum === proof.maxChecksum &&
    proof.minVersionId !== params.targetVersionId;
  return uniform
    ? { checksum: proof.minChecksum, versionId: proof.minVersionId }
    : { checksum: null, versionId: null };
};
