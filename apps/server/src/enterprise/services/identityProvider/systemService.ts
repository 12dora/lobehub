import { createHash, randomBytes } from 'node:crypto';

import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';

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
  acquireIdentityProviderConvergenceLock,
  demoteEnvironmentShadowedIdentityProviders,
  getIdentityProviderInstanceRegistrationState,
  getIdentityProviderProcessInstance,
  IDENTITY_PROVIDER_INSTANCE_STALE_MS,
  identityProviderDegradedCategory,
} from './instanceRegistry';
import { identityProviderLkgIdentity } from './lkg';
import { ProcessRestartController, type RestartController } from './restartController';
import { getIdentityProviderStartupArtifactHealth } from './startupArtifact';
import {
  loadPublishedIdentityProviderSelection,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

const RESTART_INTENT_TTL_MS = 5 * 60 * 1000;
export const IDENTITY_PROVIDER_RESTART_CONVERGENCE_TIMEOUT_MS = 120_000;
export const IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT = 10;

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
  let selection: Awaited<ReturnType<typeof loadPublishedIdentityProviderSelection>>;
  try {
    selection = await loadPublishedIdentityProviderSelection({
      db,
      environmentProviderIds: new Set(parseEnvironmentIdentityProviderIds(env)),
    });
  } catch {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
  }
  const providers = selection.selected.map((revision) => {
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
  // Always compute the identity digest — including the empty provider set after a
  // full tombstone — so restart status can converge on a real target revision.
  return {
    environmentShadowed: selection.environmentShadowed,
    identityRevision: identityProviderLkgIdentity(
      providers.map((provider) => ({
        ...provider,
        payload: provider.payload as unknown as Record<string, unknown>,
      })),
    ),
    providers,
  };
};

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
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private restartCapability = () => {
    const capability = this.restartController.capability();
    return capability.supported && !this.afterResponse
      ? ({ reason: 'supervisor_not_configured', supported: false } as const)
      : capability;
  };

  private restartAcceptanceTiming = (acceptedAt: Date) => {
    const serverNow = this.now();
    const convergenceDeadlineAt = new Date(
      acceptedAt.getTime() + IDENTITY_PROVIDER_RESTART_CONVERGENCE_TIMEOUT_MS,
    );
    return {
      convergenceDeadlineAt,
      remainingMs: Math.min(
        IDENTITY_PROVIDER_RESTART_CONVERGENCE_TIMEOUT_MS,
        Math.max(0, convergenceDeadlineAt.getTime() - serverNow.getTime()),
      ),
      serverNow,
    };
  };

  getAuthSnapshotStatus = async () => {
    const artifact = getIdentityProviderStartupArtifactHealth();
    if (!artifact) {
      throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
    }
    const local = getIdentityProviderProcessInstance();
    const registrationState = getIdentityProviderInstanceRegistrationState();
    return this.db.transaction(async (tx) => {
      await acquireIdentityProviderConvergenceLock(tx);
      const target = await loadPublishedIdentityTarget(tx, this.env);
      await demoteEnvironmentShadowedIdentityProviders(tx, target.environmentShadowed);
      const snapshotClock = await tx.execute<{ cutoff: Date | string }>(
        sql`SELECT clock_timestamp() - (${IDENTITY_PROVIDER_INSTANCE_STALE_MS} * interval '1 millisecond') AS cutoff`,
      );
      const rawCutoff = snapshotClock.rows[0]?.cutoff;
      const cutoff = rawCutoff instanceof Date ? rawCutoff : new Date(rawCutoff ?? Number.NaN);
      if (Number.isNaN(cutoff.getTime())) {
        throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
      }
      const freshInstances = await tx
        .select()
        .from(platformIdentityProviderInstances)
        .where(
          and(
            gte(platformIdentityProviderInstances.lastHeartbeat, cutoff),
            ne(platformIdentityProviderInstances.instanceId, local.instanceId),
          ),
        )
        .orderBy(
          desc(platformIdentityProviderInstances.lastHeartbeat),
          asc(platformIdentityProviderInstances.instanceId),
        );
      const [localRow] = await tx
        .select()
        .from(platformIdentityProviderInstances)
        .where(eq(platformIdentityProviderInstances.instanceId, local.instanceId))
        .limit(1);
      const [staleAggregate] = await tx
        .select({ count: count() })
        .from(platformIdentityProviderInstances)
        .where(
          and(
            lt(platformIdentityProviderInstances.lastHeartbeat, cutoff),
            ne(platformIdentityProviderInstances.instanceId, local.instanceId),
          ),
        );
      const staleInstances = await tx
        .select()
        .from(platformIdentityProviderInstances)
        .where(
          and(
            lt(platformIdentityProviderInstances.lastHeartbeat, cutoff),
            ne(platformIdentityProviderInstances.instanceId, local.instanceId),
          ),
        )
        .orderBy(
          desc(platformIdentityProviderInstances.lastHeartbeat),
          asc(platformIdentityProviderInstances.instanceId),
        )
        .limit(IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT);
      const pendingRows = await tx
        .select({
          activationRevision: platformIdentityProviders.activationRevision,
          id: platformIdentityProviders.id,
          providerKey: platformIdentityProviders.providerKey,
        })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.status, 'pending_restart'));

      const registrationFailed =
        registrationState === 'failed' || (!localRow && registrationState !== 'registered');
      const localProjection = {
        activeIdentityRevision: artifact.identityRevision,
        degradedCategory: registrationFailed
          ? 'instance_status_unavailable'
          : identityProviderDegradedCategory({
              ...artifact,
              databaseProviders: [],
              providerIds: [],
            }),
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
      const fresh = [
        ...freshInstances.map((instance) => ({ ...instance, fresh: true })),
        localProjection,
      ];
      const sortedFreshInstances = [...fresh].sort(
        (left, right) =>
          right.lastHeartbeat.getTime() - left.lastHeartbeat.getTime() ||
          left.instanceId.localeCompare(right.instanceId),
      );
      const diagnosticInstances = [
        ...sortedFreshInstances,
        ...staleInstances.map((instance) => ({ ...instance, fresh: false })),
      ];
      const isActive = (instance: (typeof fresh)[number]) =>
        Boolean(target.identityRevision) &&
        instance.activeIdentityRevision === target.identityRevision &&
        instance.health === 'healthy' &&
        instance.startupSource === 'database';
      const activeCount = fresh.filter(isActive).length;
      const allFreshInstancesActive = fresh.length > 0 && activeCount === fresh.length;
      let pendingPublished = pendingRows.flatMap((row) =>
        row.activationRevision
          ? [
              {
                blockedCategory: target.environmentShadowed.some(
                  (provider) => provider.providerId === row.id,
                )
                  ? ('environment_provider_shadowed' as const)
                  : null,
                providerId: row.id,
                providerKey: row.providerKey,
                publishedRevision: row.activationRevision,
              },
            ]
          : [],
      );
      if (allFreshInstancesActive && target.identityRevision) {
        const canonicalProviderIds = new Set(
          target.providers.map((provider) => provider.providerId),
        );
        const reconciled = new Set<string>();
        for (const row of pendingRows) {
          if (!row.activationRevision) continue;
          if (canonicalProviderIds.has(row.id)) {
            // Live publish: mark active once every fresh instance reports the target.
            const [updated] = await tx
              .update(platformIdentityProviders)
              .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
              .where(
                and(
                  eq(platformIdentityProviders.id, row.id),
                  eq(platformIdentityProviders.status, 'pending_restart'),
                  eq(platformIdentityProviders.activationRevision, row.activationRevision),
                  eq(platformIdentityProviders.revision, row.activationRevision),
                ),
              )
              .returning({ id: platformIdentityProviders.id });
            if (updated) reconciled.add(updated.id);
            continue;
          }
          // Tombstone / removal: provider is no longer in the live target set.
          // Reconcile to disabled only after every fresh instance reports the reduced target.
          const [updated] = await tx
            .update(platformIdentityProviders)
            .set({
              activationRevision: null,
              enabled: false,
              status: 'disabled',
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(platformIdentityProviders.id, row.id),
                eq(platformIdentityProviders.status, 'pending_restart'),
                eq(platformIdentityProviders.activationRevision, row.activationRevision),
                eq(platformIdentityProviders.revision, row.activationRevision),
                eq(platformIdentityProviders.enabled, false),
              ),
            )
            .returning({ id: platformIdentityProviders.id });
          if (updated) reconciled.add(updated.id);
        }
        pendingPublished = pendingPublished.filter(
          (provider) => !reconciled.has(provider.providerId),
        );
      }
      const pendingRestart = pendingPublished.length > 0;
      const restartablePending = pendingPublished.some(
        (provider) => provider.blockedCategory === null,
      );
      const capability = this.restartCapability();
      // Bounded recent requests (newest first) so concurrent restarts cannot hide
      // the polling administrator's failed schedule outcome.
      const recentRestartRequests = await tx
        .select({
          requestId: platformIdentityProviderRestartRequests.requestId,
          resultCategory: platformIdentityProviderRestartRequests.resultCategory,
          status: platformIdentityProviderRestartRequests.status,
        })
        .from(platformIdentityProviderRestartRequests)
        .where(
          and(
            eq(platformIdentityProviderRestartRequests.targetInstanceId, local.instanceId),
            inArray(platformIdentityProviderRestartRequests.status, [
              'accepted',
              'signaled',
              'failed',
            ]),
          ),
        )
        .orderBy(desc(platformIdentityProviderRestartRequests.createdAt))
        .limit(32);
      const restartRequests = recentRestartRequests.flatMap((request) =>
        request.status === 'accepted' ||
        request.status === 'signaled' ||
        request.status === 'failed'
          ? [
              {
                requestId: request.requestId,
                resultCategory: request.resultCategory,
                status: request.status,
              },
            ]
          : [],
      );
      const restartRequest = restartRequests[0] ?? null;
      return {
        active: {
          allFreshInstancesActive,
          partial: activeCount > 0 && !allFreshInstancesActive,
          staleInstances: staleAggregate?.count ?? 0,
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
        instances: diagnosticInstances,
        pendingPublished,
        pendingRestart,
        restart: {
          reason: !pendingRestart
            ? ('no_pending_restart' as const)
            : !restartablePending
              ? ('environment_provider_shadowed' as const)
              : capability.reason,
          supported: restartablePending && capability.supported,
        },
        restartRequest,
        restartRequests,
        targetIdentityRevision: target.identityRevision,
      };
    });
  };

  prepareRestart = async (actorId: string, input: AdminSystemPrepareRestartInput) => {
    const requestId = input.requestId.toLowerCase();
    const reason = normalizeReason(input.reason);
    try {
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
      const intentToken = randomBytes(32).toString('hex');
      const ownerFence = randomBytes(32).toString('hex');
      const expiresAt = new Date(this.now().getTime() + RESTART_INTENT_TTL_MS);
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
      const prepared = await this.db.transaction(async (tx) => {
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
      await this.recordPrepareFailure(actorId, input, category);
      throw error;
    }
  };

  private recordPrepareFailure = async (
    actorId: string,
    input: AdminSystemPrepareRestartInput,
    category: string,
  ): Promise<void> => {
    try {
      await this.db.insert(platformAuditLogs).values({
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
          acceptedAt: Date;
          expectedIdentityRevision: string;
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
          if (!request.acceptedAt) {
            throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_CONFLICT');
          }
          return {
            acceptedAt: request.acceptedAt,
            duplicate: true,
            expectedIdentityRevision: request.expectedIdentityRevision,
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
          acceptedAt: now,
          duplicate: false,
          expectedIdentityRevision: request.expectedIdentityRevision,
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
      return {
        accepted: true as const,
        acceptedAt: accepted.acceptedAt,
        ...this.restartAcceptanceTiming(accepted.acceptedAt),
        duplicate: true,
        expectedIdentityRevision: accepted.expectedIdentityRevision,
        requestId: accepted.requestId,
        status: accepted.status,
      };
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
    return {
      accepted: true as const,
      acceptedAt: accepted.acceptedAt,
      ...this.restartAcceptanceTiming(accepted.acceptedAt),
      duplicate: false,
      expectedIdentityRevision: accepted.expectedIdentityRevision,
      requestId,
      status: 'accepted' as const,
    };
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
