import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AdminSystemPrepareRestartInput,
  AdminSystemRequestRestartInput,
} from '@/server/enterprise/contracts/adminSystem';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import {
  getIdentityProviderProcessInstance,
  IDENTITY_PROVIDER_INSTANCE_STALE_MS,
  identityProviderDegradedCategory,
} from './instanceRegistry';
import { identityProviderLkgIdentity } from './lkg';
import { ProcessRestartController, type RestartController } from './restartController';
import { getIdentityProviderStartupArtifactHealth } from './startupArtifact';

const RESTART_INTENT_TTL_MS = 5 * 60 * 1000;

export class IdentityProviderSystemError extends Error {
  constructor(
    public readonly code:
      | 'PLATFORM_IDENTITY_RESTART_CONFLICT'
      | 'PLATFORM_IDENTITY_RESTART_INTENT_EXPIRED'
      | 'PLATFORM_IDENTITY_RESTART_INTENT_INVALID'
      | 'PLATFORM_IDENTITY_RESTART_NOT_PENDING'
      | 'PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE'
      | 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED',
  ) {
    super(code);
    this.name = 'IdentityProviderSystemError';
  }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const normalizeReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 1000 || containsEnterpriseSecretMaterial(normalized)) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
  }
  return normalized;
};

const providerKey = (payload: Record<string, unknown>): string => {
  const value = payload.providerKey;
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
  }
  return value;
};

export const loadPublishedIdentityTarget = async (db: LobeChatDatabase | Transaction) => {
  const revisions = await db
    .select({
      checksum: platformResourceRevisions.checksum,
      id: platformResourceRevisions.id,
      payload: platformResourceRevisions.payload,
      publishedAt: platformResourceRevisions.publishedAt,
      resourceId: platformResourceRevisions.resourceId,
      revision: platformResourceRevisions.revision,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
    })
    .from(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'oidc'),
        eq(platformResourceRevisions.status, 'published'),
      ),
    )
    .orderBy(desc(platformResourceRevisions.revision));

  const selected = new Map<string, (typeof revisions)[number]>();
  for (const revision of revisions) {
    if (!selected.has(revision.resourceId)) selected.set(revision.resourceId, revision);
  }
  const providers = [...selected.values()].map((revision) => {
    if (!revision.publishedAt || !revision.secretFingerprint) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
    }
    return {
      checksum: revision.checksum,
      generation: `${revision.publishedAt.toISOString()}:${revision.id}`,
      payload: revision.payload,
      providerId: revision.resourceId,
      providerKey: providerKey(revision.payload),
      publishedRevision: revision.revision,
      revision: revision.revision,
      secretFingerprint: revision.secretFingerprint,
    };
  });
  return {
    identityRevision: providers.length > 0 ? identityProviderLkgIdentity(providers) : null,
    providers,
  };
};

type AuthSnapshotStatus = Awaited<
  ReturnType<IdentityProviderSystemService['getAuthSnapshotStatus']>
>;

const restartPayloadHash = (input: {
  actorId: string;
  expectedIdentityRevision: string;
  reason: string;
  requestId: string;
  targetInstanceId: string;
}): string => checksumPayload(input);

export class IdentityProviderSystemService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly restartController: RestartController = new ProcessRestartController(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  getAuthSnapshotStatus = async () => {
    const artifact = getIdentityProviderStartupArtifactHealth();
    if (!artifact) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
    }
    const [{ identityRevision: targetIdentityRevision }, instances, pendingRows] =
      await Promise.all([
        loadPublishedIdentityTarget(this.db),
        this.db
          .select()
          .from(platformIdentityProviderInstances)
          .orderBy(desc(platformIdentityProviderInstances.lastHeartbeat))
          .limit(200),
        this.db
          .select({
            activationRevision: platformIdentityProviders.activationRevision,
            id: platformIdentityProviders.id,
            providerKey: platformIdentityProviders.providerKey,
          })
          .from(platformIdentityProviders)
          .where(eq(platformIdentityProviders.status, 'pending_restart')),
      ]);
    const now = this.now().getTime();
    const instanceProjection = instances.map((instance) => ({
      activeIdentityRevision: instance.activeIdentityRevision,
      degradedCategory: instance.degradedCategory,
      fresh: now - instance.lastHeartbeat.getTime() <= IDENTITY_PROVIDER_INSTANCE_STALE_MS,
      health: instance.health,
      hostnameHash: instance.hostnameHash,
      instanceId: instance.instanceId,
      lastHeartbeat: instance.lastHeartbeat,
      loadedAt: instance.loadedAt,
      startedAt: instance.startedAt,
      startupGeneration: instance.startupGeneration,
      startupSource: instance.startupSource,
    }));
    const fresh = instanceProjection.filter((instance) => instance.fresh);
    const isActive = (instance: (typeof fresh)[number]) =>
      Boolean(targetIdentityRevision) &&
      instance.activeIdentityRevision === targetIdentityRevision &&
      instance.health === 'healthy' &&
      instance.startupSource === 'database';
    const activeCount = fresh.filter(isActive).length;
    const allFreshInstancesActive = fresh.length > 0 && activeCount === fresh.length;
    const pendingPublished = pendingRows.flatMap((row) =>
      row.activationRevision
        ? [
            {
              providerId: row.id,
              providerKey: row.providerKey,
              publishedRevision: row.activationRevision,
            },
          ]
        : [],
    );
    const pendingRestart = pendingPublished.length > 0 && !allFreshInstancesActive;
    const capability = this.restartController.capability();
    const local = getIdentityProviderProcessInstance();
    return {
      active: {
        allFreshInstancesActive,
        partial: activeCount > 0 && !allFreshInstancesActive,
        staleInstances: instanceProjection.filter((instance) => !instance.fresh).length,
      },
      artifact: {
        degradedCategory: identityProviderDegradedCategory({
          ...artifact,
          databaseProviders: [],
          providerIds: [],
        }),
        generation: artifact.generation,
        health: artifact.health,
        identityRevision: artifact.identityRevision,
        instanceId: local.instanceId,
        loadedAt: artifact.loadedAt,
        source: artifact.source,
      },
      instances: instanceProjection,
      pendingPublished,
      pendingRestart,
      restart: {
        reason: pendingRestart ? capability.reason : ('no_pending_restart' as const),
        supported: pendingRestart && capability.supported,
      },
      targetIdentityRevision,
    };
  };

  prepareRestart = async (actorId: string, input: AdminSystemPrepareRestartInput) => {
    const status = await this.getAuthSnapshotStatus();
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
    const requestId = input.requestId.toLowerCase();
    const reason = normalizeReason(input.reason);
    const intentToken = randomBytes(32).toString('hex');
    const ownerFence = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now().getTime() + RESTART_INTENT_TTL_MS);
    const targetInstanceId = status.artifact.instanceId;
    const payloadHash = restartPayloadHash({
      actorId,
      expectedIdentityRevision: status.targetIdentityRevision,
      reason,
      requestId,
      targetInstanceId,
    });
    const [prepared] = await this.db
      .insert(platformIdentityProviderRestartRequests)
      .values({
        actorId,
        expectedIdentityRevision: status.targetIdentityRevision,
        expiresAt,
        intentTokenHash: digest(intentToken),
        ownerFence,
        payloadHash,
        requestId,
        targetInstanceId,
      })
      .onConflictDoNothing({ target: platformIdentityProviderRestartRequests.requestId })
      .returning({ requestId: platformIdentityProviderRestartRequests.requestId });
    if (!prepared) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
    }
    return {
      expectedIdentityRevision: status.targetIdentityRevision,
      expiresAt,
      intentToken,
      requestId,
    };
  };

  private recordFailure = async (
    actorId: string,
    input: AdminSystemRequestRestartInput,
    category: string,
  ): Promise<void> => {
    try {
      await this.db.insert(platformAuditLogs).values({
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

  requestRestart = async (actorId: string, input: AdminSystemRequestRestartInput) => {
    const requestId = input.requestId.toLowerCase();
    const reason = normalizeReason(input.reason);
    let accepted:
      | {
          duplicate: boolean;
          ownerFence: string;
          requestId: string;
          status: 'accepted' | 'signaled';
        }
      | undefined;
    try {
      accepted = await this.db.transaction(async (tx) => {
        const [request] = await tx
          .select()
          .from(platformIdentityProviderRestartRequests)
          .where(eq(platformIdentityProviderRestartRequests.requestId, requestId))
          .for('update')
          .limit(1);
        if (!request || request.actorId !== actorId) {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
        }
        const expectedPayloadHash = restartPayloadHash({
          actorId,
          expectedIdentityRevision: request.expectedIdentityRevision,
          reason,
          requestId,
          targetInstanceId: request.targetInstanceId,
        });
        if (
          request.payloadHash !== expectedPayloadHash ||
          request.intentTokenHash !== digest(input.intentToken)
        ) {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_INVALID');
        }
        if (request.status === 'accepted' || request.status === 'signaled') {
          return {
            duplicate: true,
            ownerFence: request.ownerFence,
            requestId,
            status: request.status,
          };
        }
        if (request.status !== 'prepared') {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
        }
        const now = this.now();
        if (request.expiresAt.getTime() <= now.getTime()) {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_INTENT_EXPIRED');
        }
        const capability = this.restartController.capability();
        if (!capability.supported) {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_UNSUPPORTED');
        }
        const target = await loadPublishedIdentityTarget(tx);
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
              eq(platformIdentityProviderRestartRequests.requestId, requestId),
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
          actorUserId: actorId,
          afterDiff: {
            expectedIdentityRevision: request.expectedIdentityRevision,
            outcome: 'accepted',
          },
          reason,
          requestId,
          result: 'success',
          targetId: 'identity_provider_runtime',
          targetType: 'system',
        });
        return {
          duplicate: false,
          ownerFence: request.ownerFence,
          requestId,
          status: 'accepted' as const,
        };
      });
    } catch (error) {
      const category =
        error instanceof IdentityProviderSystemError
          ? error.code.toLowerCase()
          : 'platform_identity_restart_unavailable';
      await this.recordFailure(actorId, input, category);
      throw error;
    }

    if (accepted.duplicate) {
      return { accepted: true as const, ...accepted };
    }

    try {
      await this.restartController.schedule({ ownerFence: accepted.ownerFence, requestId });
      const now = this.now();
      const [signaled] = await this.db
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
            eq(platformIdentityProviderRestartRequests.ownerFence, accepted.ownerFence),
          ),
        )
        .returning({ requestId: platformIdentityProviderRestartRequests.requestId });
      if (!signaled) {
        console.error('[admin.system] restart signal outcome persistence lost owner fence', {
          requestId,
        });
      }
      return { accepted: true as const, duplicate: false, requestId, status: 'signaled' as const };
    } catch {
      const now = this.now();
      await this.db
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
  };
}

export type IdentityProviderAuthSnapshotStatus = AuthSnapshotStatus;
