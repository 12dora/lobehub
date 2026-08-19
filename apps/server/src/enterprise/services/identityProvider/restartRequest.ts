import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AdminSystemPrepareRestartInput,
  AdminSystemRequestRestartInput,
} from '@/server/enterprise/contracts/adminSystem';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { getIdentityProviderProcessInstance } from './instanceRegistry';
import type { RestartCapability, RestartController } from './restartController';
import type { IdentityProviderAfterResponseHook } from './systemService';
import { IdentityProviderSystemError } from './systemService';

const RESTART_INTENT_TTL_MS = 5 * 60 * 1000;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const normalizeReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 1000 || containsEnterpriseSecretMaterial(normalized)) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
  }
  return normalized;
};

const restartPayloadHash = (input: {
  actorId: string;
  expectedIdentityRevision: string;
  reason: string;
  requestId: string;
  targetInstanceId: string;
}): string => checksumPayload(input);

interface AcceptedRestart {
  acceptedAt: Date;
  duplicate: boolean;
  expectedIdentityRevision: string;
  ownerFence: string;
  requestId: string;
  status: 'accepted' | 'signaled';
}

const recordPrepareFailure = async (
  db: LobeChatDatabase,
  actorId: string,
  input: AdminSystemPrepareRestartInput,
  category: string,
): Promise<void> => {
  try {
    await db.insert(platformAuditLogs).values({
      action: 'admin.system.prepareRestart',
      actorUserId: actorId,
      afterDiff: { error: category },
      reason: normalizeReason(input.reason),
      requestId: input.requestId.toLowerCase(),
      result: 'failure',
      targetId: 'identity_provider_runtime',
      targetType: 'system',
    });
  } catch (auditError) {
    console.error('[admin.system] prepareRestart failure audit unavailable', {
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

const recordFailure = async (
  db: LobeChatDatabase,
  actorId: string,
  input: AdminSystemRequestRestartInput,
  category: string,
): Promise<void> => {
  try {
    await db.insert(platformAuditLogs).values({
      action: 'admin.system.requestRestart',
      actorUserId: actorId,
      afterDiff: { error: category },
      reason: normalizeReason(input.reason),
      requestId: input.requestId,
      result: 'failure',
      targetId: 'identity_provider_runtime',
      targetType: 'system',
    });
  } catch (auditError) {
    console.error('[admin.system] restart failure audit unavailable', {
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

const signalAcceptedRestart = async (
  deps: {
    db: LobeChatDatabase;
    now: () => Date;
    restartController: RestartController;
  },
  ownerFence: string,
  requestId: string,
): Promise<void> => {
  const now = deps.now();
  const [persisted] = await deps.db
    .update(platformIdentityProviderRestartRequests)
    .set({
      resultCategory: 'signal_scheduled',
      signaledAt: now,
      status: 'signaled',
      updatedAt: now,
    })
    .where(
      and(
        eq(platformIdentityProviderRestartRequests.requestId, requestId),
        eq(platformIdentityProviderRestartRequests.status, 'accepted'),
        eq(platformIdentityProviderRestartRequests.ownerFence, ownerFence),
      ),
    )
    .returning({ requestId: platformIdentityProviderRestartRequests.requestId });
  if (!persisted) return;

  try {
    // Persistence deliberately precedes timer creation; this callback itself is registered
    // with Next's post-response lifecycle by the router.
    await deps.restartController.schedule({ ownerFence, requestId });
  } catch {
    const failedAt = deps.now();
    await deps.db
      .update(platformIdentityProviderRestartRequests)
      .set({
        failedAt,
        resultCategory: 'signal_schedule_failed',
        signaledAt: null,
        status: 'failed',
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(platformIdentityProviderRestartRequests.requestId, requestId),
          eq(platformIdentityProviderRestartRequests.status, 'signaled'),
          eq(platformIdentityProviderRestartRequests.ownerFence, ownerFence),
        ),
      );
  }
};

const acceptPreparedRestart = async (
  tx: Transaction,
  input: {
    actorId: string;
    intentToken: string;
    loadPublishedIdentityTarget: (db: Transaction) => Promise<{ identityRevision: string | null }>;
    now: () => Date;
    reason: string;
    requestId: string;
    restartCapability: () => RestartCapability;
  },
): Promise<AcceptedRestart> => {
  const [request] = await tx
    .select()
    .from(platformIdentityProviderRestartRequests)
    .where(eq(platformIdentityProviderRestartRequests.requestId, input.requestId))
    .for('update')
    .limit(1);
  if (!request || request.actorId !== input.actorId) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
  }
  const expectedPayloadHash = restartPayloadHash({
    actorId: input.actorId,
    expectedIdentityRevision: request.expectedIdentityRevision,
    reason: input.reason,
    requestId: input.requestId,
    targetInstanceId: request.targetInstanceId,
  });
  if (
    request.payloadHash !== expectedPayloadHash ||
    request.intentTokenHash !== digest(input.intentToken)
  ) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
  }
  if (request.status === 'accepted' || request.status === 'signaled') {
    if (!request.acceptedAt) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
    }
    return {
      acceptedAt: request.acceptedAt,
      duplicate: true,
      expectedIdentityRevision: request.expectedIdentityRevision,
      ownerFence: request.ownerFence,
      requestId: input.requestId,
      status: request.status,
    };
  }
  if (request.status !== 'prepared') {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
  }
  const now = input.now();
  if (request.expiresAt.getTime() <= now.getTime()) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_EXPIRED');
  }
  const capability = input.restartCapability();
  if (!capability.supported) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_UNSUPPORTED');
  }
  const target = await input.loadPublishedIdentityTarget(tx);
  const [pending] = await tx
    .select({ id: platformIdentityProviders.id })
    .from(platformIdentityProviders)
    .where(eq(platformIdentityProviders.status, 'pending_restart'))
    .limit(1);
  const local = getIdentityProviderProcessInstance();
  if (
    !pending ||
    !target.identityRevision ||
    target.identityRevision !== request.expectedIdentityRevision ||
    request.targetInstanceId !== local.instanceId
  ) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_NOT_PENDING');
  }
  const [updated] = await tx
    .update(platformIdentityProviderRestartRequests)
    .set({ acceptedAt: now, status: 'accepted', updatedAt: now })
    .where(
      and(
        eq(platformIdentityProviderRestartRequests.requestId, input.requestId),
        eq(platformIdentityProviderRestartRequests.status, 'prepared'),
        eq(platformIdentityProviderRestartRequests.ownerFence, request.ownerFence),
      ),
    )
    .returning({ requestId: platformIdentityProviderRestartRequests.requestId });
  if (!updated) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
  }
  await tx.insert(platformAuditLogs).values({
    action: 'admin.system.requestRestart',
    actorUserId: input.actorId,
    afterDiff: {
      expectedIdentityRevision: request.expectedIdentityRevision,
      outcome: 'accepted',
    },
    reason: input.reason,
    requestId: input.requestId,
    result: 'success',
    targetId: 'identity_provider_runtime',
    targetType: 'system',
  });
  return {
    acceptedAt: now,
    duplicate: false,
    expectedIdentityRevision: request.expectedIdentityRevision,
    ownerFence: request.ownerFence,
    requestId: input.requestId,
    status: 'accepted' as const,
  };
};

export const prepareRestart = async (
  deps: {
    db: LobeChatDatabase;
    getAuthSnapshotStatus: () => Promise<{
      artifact: { instanceId: string };
      pendingRestart: boolean;
      restart: { supported: boolean };
      targetIdentityRevision: string | null;
    }>;
    now: () => Date;
  },
  actorId: string,
  input: AdminSystemPrepareRestartInput,
) => {
  const requestId = input.requestId.toLowerCase();
  const reason = normalizeReason(input.reason);
  try {
    const status = await deps.getAuthSnapshotStatus();
    if (!status.restart.supported) {
      throw new IdentityProviderSystemError(
        status.pendingRestart
          ? 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED'
          : 'PLATFORM_IDENTITY_RESTART_NOT_PENDING',
      );
    }
    if (!status.targetIdentityRevision) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
    }
    const intentToken = randomBytes(32).toString('hex');
    const ownerFence = randomBytes(32).toString('hex');
    const expiresAt = new Date(deps.now().getTime() + RESTART_INTENT_TTL_MS);
    const targetInstanceId = status.artifact.instanceId;
    const expectedIdentityRevision = status.targetIdentityRevision;
    const payloadHash = restartPayloadHash({
      actorId,
      expectedIdentityRevision,
      reason,
      requestId,
      targetInstanceId,
    });
    // Intent row and success audit share one transaction so a failed audit cannot
    // leave a durable prepared intent that looks successful without an audit trail.
    const prepared = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(platformIdentityProviderRestartRequests)
        .values({
          actorId,
          expectedIdentityRevision,
          expiresAt,
          intentTokenHash: digest(intentToken),
          ownerFence,
          payloadHash,
          requestId,
          targetInstanceId,
        })
        .onConflictDoNothing({ target: platformIdentityProviderRestartRequests.requestId })
        .returning({ requestId: platformIdentityProviderRestartRequests.requestId });
      if (!row) {
        throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
      }
      await tx.insert(platformAuditLogs).values({
        action: 'admin.system.prepareRestart',
        actorUserId: actorId,
        afterDiff: {
          expectedIdentityRevision,
          outcome: 'prepared',
        },
        reason,
        requestId,
        result: 'success',
        targetId: 'identity_provider_runtime',
        targetType: 'system',
      });
      return row;
    });
    if (!prepared) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
    }
    return {
      expectedIdentityRevision,
      expiresAt,
      intentToken,
      requestId,
    };
  } catch (error) {
    const category =
      error instanceof IdentityProviderSystemError
        ? error.code.toLowerCase()
        : 'platform_identity_restart_unavailable';
    await recordPrepareFailure(deps.db, actorId, input, category);
    throw error;
  }
};

export const requestRestart = async (
  deps: {
    afterResponse?: IdentityProviderAfterResponseHook;
    db: LobeChatDatabase;
    loadPublishedIdentityTarget: (db: Transaction) => Promise<{ identityRevision: string | null }>;
    now: () => Date;
    restartAcceptanceTiming: (acceptedAt: Date) => {
      convergenceDeadlineAt: Date;
      remainingMs: number;
      serverNow: Date;
    };
    restartCapability: () => RestartCapability;
    restartController: RestartController;
  },
  actorId: string,
  input: AdminSystemRequestRestartInput,
) => {
  const requestId = input.requestId.toLowerCase();
  const reason = normalizeReason(input.reason);
  let accepted: AcceptedRestart | undefined;
  try {
    accepted = await deps.db.transaction(async (tx) => {
      return acceptPreparedRestart(tx, {
        actorId,
        intentToken: input.intentToken,
        loadPublishedIdentityTarget: deps.loadPublishedIdentityTarget,
        now: deps.now,
        reason,
        requestId,
        restartCapability: deps.restartCapability,
      });
    });
  } catch (error) {
    const category =
      error instanceof IdentityProviderSystemError
        ? error.code.toLowerCase()
        : 'platform_identity_restart_unavailable';
    await recordFailure(deps.db, actorId, input, category);
    throw error;
  }

  if (accepted.duplicate) {
    if (accepted.status === 'accepted') {
      try {
        deps.afterResponse!(() =>
          signalAcceptedRestart(
            {
              db: deps.db,
              now: deps.now,
              restartController: deps.restartController,
            },
            accepted!.ownerFence,
            accepted!.requestId,
          ),
        );
      } catch {
        throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_UNSUPPORTED');
      }
    }
    return {
      accepted: true as const,
      acceptedAt: accepted.acceptedAt,
      ...deps.restartAcceptanceTiming(accepted.acceptedAt),
      duplicate: true,
      expectedIdentityRevision: accepted.expectedIdentityRevision,
      requestId: accepted.requestId,
      status: accepted.status,
    };
  }

  try {
    deps.afterResponse!(() =>
      signalAcceptedRestart(
        {
          db: deps.db,
          now: deps.now,
          restartController: deps.restartController,
        },
        accepted!.ownerFence,
        requestId,
      ),
    );
  } catch {
    const now = deps.now();
    await deps.db
      .update(platformIdentityProviderRestartRequests)
      .set({
        failedAt: now,
        resultCategory: 'signal_schedule_failed',
        status: 'failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(platformIdentityProviderRestartRequests.requestId, requestId),
          eq(platformIdentityProviderRestartRequests.status, 'accepted'),
          eq(platformIdentityProviderRestartRequests.ownerFence, accepted.ownerFence),
        ),
      );
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_UNSUPPORTED');
  }
  return {
    accepted: true as const,
    acceptedAt: accepted.acceptedAt,
    ...deps.restartAcceptanceTiming(accepted.acceptedAt),
    duplicate: false,
    expectedIdentityRevision: accepted.expectedIdentityRevision,
    requestId,
    status: 'accepted' as const,
  };
};
