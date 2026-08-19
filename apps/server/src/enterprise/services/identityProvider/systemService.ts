import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AdminSystemPrepareRestartInput,
  AdminSystemRequestRestartInput,
} from '@/server/enterprise/contracts/adminSystem';

import {
  assembleAuthSnapshotStatus,
  assembleDiagnosticInstances,
  assembleLocalProjection,
} from './authSnapshotAssemble';
import { queryAuthSnapshotRows, queryRecentRestartRequests } from './authSnapshotQuery';
import { isActive, reconcilePendingPublished } from './authSnapshotReconcile';
import {
  acquireIdentityProviderConvergenceLock,
  demoteEnvironmentShadowedIdentityProviders,
  getIdentityProviderInstanceRegistrationState,
  getIdentityProviderProcessInstance,
} from './instanceRegistry';
import { identityProviderLkgIdentity } from './lkg';
import type { RestartController } from './restartController';
import { ProcessRestartController } from './restartController';
import { prepareRestart, requestRestart } from './restartRequest';
import { getIdentityProviderStartupArtifactHealth } from './startupArtifact';
import {
  loadPublishedIdentityProviderSelection,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

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
      const rows = await queryAuthSnapshotRows(tx, local.instanceId);
      const localProjection = assembleLocalProjection({
        artifact,
        local,
        localRow: rows.localRow,
        now: this.now,
        registrationState,
      });
      const { diagnosticInstances, fresh } = assembleDiagnosticInstances({
        freshInstances: rows.freshInstances,
        localProjection,
        staleInstances: rows.staleInstances,
      });
      const activeCount = fresh.filter((instance) => isActive(instance, target)).length;
      const allFreshInstancesActive = fresh.length > 0 && activeCount === fresh.length;
      const pendingPublished = await reconcilePendingPublished(tx, {
        allFreshInstancesActive,
        pendingRows: rows.pendingRows,
        target,
      });
      const capability = this.restartCapability();
      // Bounded recent requests (newest first) so concurrent restarts cannot hide
      // the polling administrator's failed schedule outcome.
      const recentRestartRequests = await queryRecentRestartRequests(tx, local.instanceId);
      return assembleAuthSnapshotStatus({
        activeCount,
        allFreshInstancesActive,
        artifact,
        capability,
        diagnosticInstances,
        local,
        localProjection,
        pendingPublished,
        recentRestartRequests,
        staleInstanceCount: rows.staleAggregate?.count ?? 0,
        targetIdentityRevision: target.identityRevision,
      });
    });
  };

  prepareRestart = async (actorId: string, input: AdminSystemPrepareRestartInput) => {
    return prepareRestart(
      {
        db: this.db,
        getAuthSnapshotStatus: this.getAuthSnapshotStatus,
        now: this.now,
      },
      actorId,
      input,
    );
  };

  requestRestart = async (actorId: string, input: AdminSystemRequestRestartInput) => {
    return requestRestart(
      {
        afterResponse: this.afterResponse,
        db: this.db,
        loadPublishedIdentityTarget,
        now: this.now,
        restartAcceptanceTiming: this.restartAcceptanceTiming,
        restartCapability: this.restartCapability,
        restartController: this.restartController,
      },
      actorId,
      input,
    );
  };
}
