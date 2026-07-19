import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { checksumPayload } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AdminSystemPrepareRestartInput,
  AdminSystemRequestRestartInput,
} from '@/server/enterprise/contracts/adminSystem';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import {
  getIdentityProviderInstanceRegistrationState,
  getIdentityProviderProcessInstance,
  IDENTITY_PROVIDER_INSTANCE_STALE_MS,
  identityProviderDegradedCategory,
} from './instanceRegistry';
import { identityProviderLkgIdentity } from './lkg';
import { ProcessRestartController, type RestartController } from './restartController';
import { getIdentityProviderStartupArtifactHealth } from './startupArtifact';
import {
  loadCanonicalPublishedIdentityProviders,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

const RESTART_INTENT_TTL_MS = 5 * 60 * 1000;

export type IdentityProviderAfterResponseHook = (task: () => Promise<void>) => void;

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

export const loadPublishedIdentityTarget = async (
  db: LobeChatDatabase | Transaction,
  env: Record<string, string | undefined> = process.env,
) => {
  let selected: Awaited<ReturnType<typeof loadCanonicalPublishedIdentityProviders>>;
  try {
    selected = await loadCanonicalPublishedIdentityProviders({
      db,
      environmentProviderIds: new Set(parseEnvironmentIdentityProviderIds(env)),
    });
  } catch {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
  }
  const providers = selected.map((revision) => {
    return {
      checksum: revision.checksum,
      generation: revision.generation,
      payload: revision.payload,
      providerId: revision.providerId,
      providerKey: revision.payload.providerKey,
      publishedRevision: revision.revision,
      revision: revision.revision,
      secretFingerprint: revision.secretFingerprint,
    };
  });
  return {
    identityRevision:
      providers.length > 0
        ? identityProviderLkgIdentity(
            providers.map((provider) => ({
              ...provider,
              payload: provider.payload as unknown as Record<string, unknown>,
            })),
          )
        : null,
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
    private readonly afterResponse?: IdentityProviderAfterResponseHook,
  ) {}

  private restartCapability = () => {
    const capability = this.restartController.capability();
    return capability.supported && !this.afterResponse
      ? ({ reason: 'supervisor_not_configured', supported: false } as const)
      : capability;
  };

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
    let instanceProjection = instances.map((instance) => ({
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
    const local = getIdentityProviderProcessInstance();
    const localRow = instanceProjection.find(
      (instance) => instance.instanceId === local.instanceId,
    );
    const registrationState = getIdentityProviderInstanceRegistrationState();
    const registrationFailed =
      registrationState === 'failed' || (!localRow && registrationState !== 'registered');
    const localProjection = {
      activeIdentityRevision: artifact.identityRevision,
      degradedCategory: registrationFailed
        ? 'instance_status_unavailable'
        : identityProviderDegradedCategory({ ...artifact, databaseProviders: [], providerIds: [] }),
      fresh: true,
      health: registrationFailed ? ('degraded' as const) : artifact.health,
      hostnameHash: local.hostnameHash,
      instanceId: local.instanceId,
      lastHeartbeat: localRow?.lastHeartbeat ?? this.now(),
      loadedAt: artifact.loadedAt,
      startedAt: local.startedAt,
      startupGeneration: artifact.generation,
      startupSource: artifact.source,
    };
    instanceProjection = [
      ...instanceProjection.filter((instance) => instance.instanceId !== local.instanceId),
      localProjection,
    ];
    const fresh = instanceProjection.filter((instance) => instance.fresh);
    const isActive = (instance: (typeof fresh)[number]) =>
      Boolean(targetIdentityRevision) &&
      instance.activeIdentityRevision === targetIdentityRevision &&
      instance.health === 'healthy' &&
      instance.startupSource === 'database';
    const activeCount = fresh.filter(isActive).length;
    const allFreshInstancesActive = fresh.length > 0 && activeCount === fresh.length;
    let pendingPublished = pendingRows.flatMap((row) =>
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
    if (allFreshInstancesActive && targetIdentityRevision && pendingRows.length > 0) {
      const reconciled = await this.db.transaction(async (tx) => {
        const ids = new Set<string>();
        for (const row of pendingRows) {
          if (!row.activationRevision) continue;
          const [updated] = await tx
            .update(platformIdentityProviders)
            .set({ status: 'active', updatedAt: this.now() })
            .where(
              and(
                eq(platformIdentityProviders.id, row.id),
                eq(platformIdentityProviders.status, 'pending_restart'),
                eq(platformIdentityProviders.activationRevision, row.activationRevision),
                eq(platformIdentityProviders.revision, row.activationRevision),
              ),
            )
            .returning({ id: platformIdentityProviders.id });
          if (updated) ids.add(updated.id);
        }
        return ids;
      });
      pendingPublished = pendingPublished.filter(
        (provider) => !reconciled.has(provider.providerId),
      );
    }
    // A failed reconciliation CAS remains pending even when runtime instances already agree.
    const pendingRestart = pendingPublished.length > 0;
    const capability = this.restartCapability();
    return {
      active: {
        allFreshInstancesActive,
        partial: activeCount > 0 && !allFreshInstancesActive,
        staleInstances: instanceProjection.filter((instance) => !instance.fresh).length,
      },
      artifact: {
        degradedCategory: localProjection.degradedCategory,
        generation: artifact.generation,
        health: localProjection.health,
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
        const capability = this.restartCapability();
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
      if (accepted.status === 'accepted') {
        try {
          this.afterResponse!(() =>
            this.signalAcceptedRestart(accepted!.ownerFence, accepted!.requestId),
          );
        } catch {
          throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_UNSUPPORTED');
        }
      }
      return { accepted: true as const, ...accepted };
    }

    try {
      this.afterResponse!(() => this.signalAcceptedRestart(accepted!.ownerFence, requestId));
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
    return { accepted: true as const, duplicate: false, requestId, status: 'accepted' as const };
  };

  private signalAcceptedRestart = async (ownerFence: string, requestId: string): Promise<void> => {
    const now = this.now();
    const [persisted] = await this.db
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
      await this.restartController.schedule({ ownerFence, requestId });
    } catch {
      const failedAt = this.now();
      await this.db
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
}

export type IdentityProviderAuthSnapshotStatus = AuthSnapshotStatus;
