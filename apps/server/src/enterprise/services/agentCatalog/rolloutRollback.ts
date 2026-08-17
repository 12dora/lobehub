import { and, eq, sql } from 'drizzle-orm';

import type { ExactPlatformAgentVersion } from '@/database/repositories/platformAgentCatalog';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { PlatformJobItem } from '@/database/schemas/platform';
import {
  PLATFORM_AGENT_ROLLOUT_TRANSITION_TYPE,
  platformAgentAssignments,
  platformJobs,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import type { AdminPlatformAgentRolloutRollbackInput } from '../../contracts/platformAgents';
import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';
import type { PlatformAgentRolloutJobInput } from './rolloutShared';
import {
  getPlatformAgentRolloutResult,
  parsePlatformAgentRolloutInput,
  persistenceStatus,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  platformAgentRolloutJobRevision,
} from './rolloutShared';

export const loadRollbackOriginJob = async (
  tx: Transaction,
  input: AdminPlatformAgentRolloutRollbackInput,
) => {
  const [original] = await tx
    .select()
    .from(platformJobs)
    .where(
      and(
        eq(platformJobs.id, input.jobId),
        eq(platformJobs.type, PLATFORM_AGENT_ROLLOUT_JOB_TYPE),
        eq(platformJobs.status, persistenceStatus(input.expectedStatus)),
        eq(platformAgentRolloutJobRevision, input.expectedJobRevision),
        sql`${platformJobs.input}->'snapshot'->>'agentId' = ${input.agentId}`,
      ),
    )
    .for('update')
    .limit(1);
  if (!original || original.status !== 'succeeded') {
    throw new PlatformAgentRevisionConflictError();
  }
  const originalInput = parsePlatformAgentRolloutInput(original);
  const rolloutResult = getPlatformAgentRolloutResult(original);
  if (
    !rolloutResult.previousVersionId ||
    !rolloutResult.previousVersionChecksum ||
    rolloutResult.previousVersionId !== input.targetVersionId ||
    input.targetVersionId === originalInput.snapshot.targetVersionId
  ) {
    throw new PlatformAgentInvalidInputError();
  }
  return { original, originalInput, rolloutResult };
};

export const assertRollbackTransitionProof = async (
  tx: Transaction,
  original: PlatformJobItem,
  rolloutResult: ReturnType<typeof getPlatformAgentRolloutResult>,
) => {
  // Re-prove the summary from the complete per-target transition ledger. A mixed population,
  // a target with no prior materialization, or a missing ledger row cannot be represented as
  // one Assignment pointer and therefore fails closed instead of fabricating a previous value.
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
        eq(platformJobs.status, 'succeeded'),
        sql`${platformJobs.input}->>'parentJobId' = ${original.id}`,
      ),
    );
  if (
    !proof ||
    proof.count !== original.progressTotal ||
    proof.nullCount !== 0 ||
    proof.minVersionId !== proof.maxVersionId ||
    proof.minChecksum !== proof.maxChecksum ||
    proof.minVersionId !== rolloutResult.previousVersionId ||
    proof.minChecksum !== rolloutResult.previousVersionChecksum
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
};

export const applyRollbackPointer = async (
  tx: Transaction,
  params: {
    actorUserId: string;
    identity: {
      currentVersionId: string | null;
      draftSequence: number;
      id: string;
      revision: number;
    };
    originalInput: PlatformAgentRolloutJobInput;
    target: Pick<ExactPlatformAgentVersion, 'id'>;
  },
) => {
  const { actorUserId, identity, originalInput, target } = params;
  const repository = new PlatformAgentCatalogRepository(tx);
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
          eq(platformAgentAssignments.targetType, originalInput.snapshot.targetType),
          eq(platformAgentAssignments.targetId, originalInput.snapshot.targetId),
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
    const assignment = await repository.getAssignment(
      identity.id,
      originalInput.snapshot.assignmentId,
    );
    if (
      !assignment ||
      !assignment.enabled ||
      assignment.status !== 'active' ||
      assignment.targetType !== originalInput.snapshot.targetType ||
      assignment.targetId !== originalInput.snapshot.targetId ||
      assignment.versionPolicy !== 'latest_published'
    ) {
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
  return updatedIdentity;
};
