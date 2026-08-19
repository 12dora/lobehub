import type { PlatformIdentityProviderInstanceItem } from '@/database/schemas/platform';

import type { AuthSnapshotRestartRequestRow } from './authSnapshotQuery';
import type { AuthSnapshotPendingPublished } from './authSnapshotReconcile';
import { identityProviderDegradedCategory } from './instanceRegistry';
import type { RestartCapability } from './restartController';
import type { IdentityProviderStartupHealth } from './startupArtifact';

export interface AuthSnapshotLocalInstance {
  hostnameHash: string;
  instanceId: string;
  startedAt: Date;
}

export interface AuthSnapshotLocalProjection {
  activeIdentityRevision: string | null;
  degradedCategory: string | null;
  fresh: true;
  health: 'degraded' | 'healthy';
  hostnameHash: string;
  instanceId: string;
  lastHeartbeat: Date;
  loadedAt: Date;
  startedAt: Date;
  startupGeneration: string | null;
  startupSource: IdentityProviderStartupHealth['source'];
}

export const assembleLocalProjection = (input: {
  artifact: IdentityProviderStartupHealth;
  local: AuthSnapshotLocalInstance;
  localRow: PlatformIdentityProviderInstanceItem | undefined;
  now: () => Date;
  registrationState: 'failed' | 'registered' | 'unknown';
}): AuthSnapshotLocalProjection => {
  const registrationFailed =
    input.registrationState === 'failed' ||
    (!input.localRow && input.registrationState !== 'registered');
  return {
    activeIdentityRevision: input.artifact.identityRevision,
    degradedCategory: registrationFailed
      ? 'instance_status_unavailable'
      : identityProviderDegradedCategory({
          ...input.artifact,
          databaseProviders: [],
        }),
    fresh: true,
    health: registrationFailed ? ('degraded' as const) : input.artifact.health,
    hostnameHash: input.local.hostnameHash,
    instanceId: input.local.instanceId,
    lastHeartbeat: input.localRow?.lastHeartbeat ?? input.now(),
    loadedAt: input.artifact.loadedAt,
    startedAt: input.local.startedAt,
    startupGeneration: input.artifact.generation,
    startupSource: input.artifact.source,
  };
};

export const assembleDiagnosticInstances = (input: {
  freshInstances: PlatformIdentityProviderInstanceItem[];
  localProjection: AuthSnapshotLocalProjection;
  staleInstances: PlatformIdentityProviderInstanceItem[];
}) => {
  const fresh = [
    ...input.freshInstances.map((instance) => ({ ...instance, fresh: true })),
    input.localProjection,
  ];
  const sortedFreshInstances = [...fresh].sort(
    (left, right) =>
      right.lastHeartbeat.getTime() - left.lastHeartbeat.getTime() ||
      left.instanceId.localeCompare(right.instanceId),
  );
  const diagnosticInstances = [
    ...sortedFreshInstances,
    ...input.staleInstances.map((instance) => ({ ...instance, fresh: false })),
  ];
  return { diagnosticInstances, fresh, sortedFreshInstances };
};

export const assembleAuthSnapshotStatus = (input: {
  activeCount: number;
  allFreshInstancesActive: boolean;
  artifact: IdentityProviderStartupHealth;
  capability: RestartCapability;
  diagnosticInstances: ReturnType<typeof assembleDiagnosticInstances>['diagnosticInstances'];
  local: AuthSnapshotLocalInstance;
  localProjection: AuthSnapshotLocalProjection;
  pendingPublished: AuthSnapshotPendingPublished[];
  recentRestartRequests: AuthSnapshotRestartRequestRow[];
  staleInstanceCount: number;
  targetIdentityRevision: string | null;
}) => {
  const pendingRestart = input.pendingPublished.length > 0;
  const restartablePending = input.pendingPublished.some(
    (provider) => provider.blockedCategory === null,
  );
  const restartRequests = input.recentRestartRequests.flatMap((request) =>
    request.status === 'accepted' || request.status === 'signaled' || request.status === 'failed'
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
      allFreshInstancesActive: input.allFreshInstancesActive,
      partial: input.activeCount > 0 && !input.allFreshInstancesActive,
      staleInstances: input.staleInstanceCount,
    },
    artifact: {
      degradedCategory: input.localProjection.degradedCategory,
      generation: input.artifact.generation,
      health: input.localProjection.health,
      identityRevision: input.artifact.identityRevision,
      instanceId: input.local.instanceId,
      loadedAt: input.artifact.loadedAt,
      source: input.artifact.source,
    },
    instances: input.diagnosticInstances,
    pendingPublished: input.pendingPublished,
    pendingRestart,
    restart: {
      reason: !pendingRestart
        ? ('no_pending_restart' as const)
        : !restartablePending
          ? ('environment_provider_shadowed' as const)
          : input.capability.reason,
      supported: restartablePending && input.capability.supported,
    },
    restartRequest,
    restartRequests,
    targetIdentityRevision: input.targetIdentityRevision,
  };
};
