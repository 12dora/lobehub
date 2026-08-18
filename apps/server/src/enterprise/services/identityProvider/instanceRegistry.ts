import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  platformIdentityProviderInstances,
  platformIdentityProviders,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  isPlatformInstanceHeartbeatTickerRunning,
  onPlatformInstanceHeartbeatTick,
  onPlatformInstanceHeartbeatTickerStarted,
} from '../platformInstance/heartbeatRuntime';
import { identityProviderLkgIdentity } from './lkg';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';
import {
  loadPublishedIdentityProviderSelection,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

export const IDENTITY_PROVIDER_INSTANCE_STALE_MS = 90_000;
export const IDENTITY_PROVIDER_HEARTBEAT_MS = 30_000;

interface IdentityProviderInstanceProcessState {
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  hostnameHash: string;
  instanceId: string;
  registered: boolean;
  registrationState: 'failed' | 'registered' | 'unknown';
  startedAt: Date;
  tickAttached: boolean;
  tickDetach: (() => void) | null;
  tickerStartedDetach: (() => void) | null;
}

const instanceProcess = process as NodeJS.Process & {
  __lobehubIdentityProviderInstanceState?: IdentityProviderInstanceProcessState;
};

const ownedInstanceProcessState = (instanceProcess.__lobehubIdentityProviderInstanceState ??= {
  heartbeatTimer: null,
  hostnameHash: createHash('sha256').update(hostname(), 'utf8').digest('hex'),
  instanceId: `oidci_${randomBytes(24).toString('hex')}`,
  registered: false,
  registrationState: 'unknown',
  startedAt: new Date(),
  tickAttached: false,
  tickDetach: null,
  tickerStartedDetach: null,
});

const instanceProcessState = (): IdentityProviderInstanceProcessState => ownedInstanceProcessState;

export const INSTANCE_CONVERGENCE_LOCK_NAMESPACE = 1_278_874_436;
export const INSTANCE_CONVERGENCE_LOCK_RESOURCE = 1_348_691_815;

export const acquireIdentityProviderConvergenceLock = async (tx: Transaction): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${INSTANCE_CONVERGENCE_LOCK_NAMESPACE}, ${INSTANCE_CONVERGENCE_LOCK_RESOURCE})`,
  );
};

const isServerlessRuntime = (env: Record<string, string | undefined>): boolean =>
  Boolean(
    env.VERCEL ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV?.startsWith('AWS_Lambda_') ||
    env.NEXT_RUNTIME === 'edge',
  );

export const identityProviderDegradedCategory = (
  snapshot: IdentityProviderStartupSnapshot,
): string | null => {
  if (snapshot.health === 'healthy') return null;
  if (snapshot.source === 'lkg') return 'lkg_fallback';
  const error = snapshot.lastError ?? '';
  if (error.includes('secret')) return 'secret_unavailable';
  if (error.includes('permission') || error.includes('owner')) return 'lkg_permissions_invalid';
  if (error.includes('signature')) return 'lkg_signature_invalid';
  if (error.includes('stale')) return 'lkg_stale';
  if (error.startsWith('lkg_write_')) return 'lkg_write_unavailable';
  if (error.includes('activation_status')) return 'instance_status_unavailable';
  // Process-init lastError values — not a published-config load failure.
  if (error.includes('startup_snapshot') && error !== 'startup_snapshot_unavailable') {
    return 'startup_snapshot_unavailable';
  }
  // Only after lastError: break-glass means published material failed to load.
  if (snapshot.source === 'break_glass') return 'break_glass_fallback';
  return 'startup_snapshot_unavailable';
};

export const getIdentityProviderProcessInstance = () => ({
  hostnameHash: instanceProcessState().hostnameHash,
  instanceId: instanceProcessState().instanceId,
  startedAt: instanceProcessState().startedAt,
});

export const getIdentityProviderInstanceRegistrationState = () =>
  instanceProcessState().registrationState;

export const markIdentityProviderInstanceRegistrationFailed = (): void => {
  const state = instanceProcessState();
  state.registrationState = 'failed';
  state.registered = false;
};

const demoteActiveProvidersForInstance = async (input: {
  env: Record<string, string | undefined>;
  health: 'degraded' | 'healthy';
  identityRevision: string | null;
  source: IdentityProviderStartupSnapshot['source'];
  tx: Transaction;
}): Promise<void> => {
  const { environmentShadowed, selected } = await loadPublishedIdentityProviderSelection({
    db: input.tx,
    environmentProviderIds: new Set(parseEnvironmentIdentityProviderIds(input.env)),
  });
  await demoteEnvironmentShadowedIdentityProviders(input.tx, environmentShadowed);
  if (selected.length === 0) return;
  const targetIdentityRevision = identityProviderLkgIdentity(
    selected.map((provider) => ({
      ...provider,
      payload: provider.payload as unknown as Record<string, unknown>,
    })),
  );
  const converged =
    input.health === 'healthy' &&
    input.source === 'database' &&
    input.identityRevision === targetIdentityRevision;
  if (converged) return;

  await input.tx
    .update(platformIdentityProviders)
    .set({ status: 'pending_restart', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(platformIdentityProviders.status, 'active'),
        inArray(
          platformIdentityProviders.id,
          selected.map((provider) => provider.providerId),
        ),
      ),
    );
};

export const demoteEnvironmentShadowedIdentityProviders = async (
  tx: Transaction,
  shadowed: Array<{ providerId: string }>,
): Promise<void> => {
  if (shadowed.length === 0) return;
  await tx
    .update(platformIdentityProviders)
    .set({ status: 'pending_restart', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(platformIdentityProviders.status, 'active'),
        inArray(
          platformIdentityProviders.id,
          shadowed.map((provider) => provider.providerId),
        ),
      ),
    );
};

/** Apply the IdP instance heartbeat on an already-open transaction. */
export const applyIdentityProviderInstanceHeartbeat = async (
  tx: Transaction,
  env: Record<string, string | undefined>,
): Promise<void> => {
  const state = instanceProcessState();
  if (!state.registered) return;
  await acquireIdentityProviderConvergenceLock(tx);
  const [instance] = await tx
    .update(platformIdentityProviderInstances)
    .set({ lastHeartbeat: sql`clock_timestamp()` })
    .where(eq(platformIdentityProviderInstances.instanceId, state.instanceId))
    .returning({
      activeIdentityRevision: platformIdentityProviderInstances.activeIdentityRevision,
      health: platformIdentityProviderInstances.health,
      startupSource: platformIdentityProviderInstances.startupSource,
    });
  if (!instance) return;
  await demoteActiveProvidersForInstance({
    env,
    health: instance.health,
    identityRevision: instance.activeIdentityRevision,
    source: instance.startupSource,
    tx,
  });
};

const heartbeat = async (
  db: LobeChatDatabase,
  env: Record<string, string | undefined>,
): Promise<void> => {
  await db.transaction(async (tx) => {
    await applyIdentityProviderInstanceHeartbeat(tx, env);
  });
};

/** Upsert the real startup result for this process, including fail-closed fallback starts. */
export const registerIdentityProviderInstance = async (input: {
  db: LobeChatDatabase;
  env?: Record<string, string | undefined>;
  snapshot: IdentityProviderStartupSnapshot;
}): Promise<void> => {
  const state = instanceProcessState();
  const category = identityProviderDegradedCategory(input.snapshot);
  const env = input.env ?? process.env;
  await input.db.transaction(async (tx) => {
    await acquireIdentityProviderConvergenceLock(tx);
    await tx
      .insert(platformIdentityProviderInstances)
      .values({
        activeIdentityRevision: input.snapshot.identityRevision,
        degradedCategory: category,
        health: input.snapshot.health,
        hostnameHash: state.hostnameHash,
        instanceId: state.instanceId,
        lastHeartbeat: sql`clock_timestamp()`,
        loadedAt: input.snapshot.loadedAt,
        startedAt: state.startedAt,
        startupGeneration: input.snapshot.generation,
        startupSource: input.snapshot.source,
      })
      .onConflictDoUpdate({
        set: {
          activeIdentityRevision: input.snapshot.identityRevision,
          degradedCategory: category,
          health: input.snapshot.health,
          hostnameHash: state.hostnameHash,
          lastHeartbeat: sql`clock_timestamp()`,
          loadedAt: input.snapshot.loadedAt,
          startupGeneration: input.snapshot.generation,
          startupSource: input.snapshot.source,
        },
        target: platformIdentityProviderInstances.instanceId,
      });
    await demoteActiveProvidersForInstance({
      env,
      health: input.snapshot.health,
      identityRevision: input.snapshot.identityRevision,
      source: input.snapshot.source,
      tx,
    });
  });
  state.registered = true;
  state.registrationState = 'registered';

  if (isServerlessRuntime(env)) return;

  const stopFallbackTimer = (): void => {
    if (!state.heartbeatTimer) return;
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  };

  if (!state.tickAttached) {
    state.tickAttached = true;
    const runTick = async (db: LobeChatDatabase) => {
      try {
        // Nested SAVEPOINT when invoked from the platform ticker; rethrow so
        // the savepoint rolls back. Catch only logs.
        await applyIdentityProviderInstanceHeartbeat(db as Transaction, env);
      } catch (error) {
        console.error('[identityProviderInstance] heartbeat unavailable', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
          instanceId: state.instanceId,
        });
        throw error;
      }
    };
    state.tickDetach = onPlatformInstanceHeartbeatTick(runTick);
    state.tickerStartedDetach = onPlatformInstanceHeartbeatTickerStarted(stopFallbackTimer);
  }

  // Production: instrumentation starts the platform-instance ticker after IdP
  // registration, then takeover stops this fallback. Dev/test (ticker gated
  // off) keeps the existing 30s timer so lastHeartbeat semantics stay intact.
  if (state.heartbeatTimer || isPlatformInstanceHeartbeatTickerRunning()) return;
  state.heartbeatTimer = setInterval(() => {
    void heartbeat(input.db, env).catch((error) => {
      console.error('[identityProviderInstance] heartbeat unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        instanceId: state.instanceId,
      });
    });
  }, IDENTITY_PROVIDER_HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();
};

export const stopIdentityProviderHeartbeatForTest = (): void => {
  const state = instanceProcessState();
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  state.tickDetach?.();
  state.tickerStartedDetach?.();
  state.tickDetach = null;
  state.tickerStartedDetach = null;
  state.tickAttached = false;
  state.registered = false;
  state.registrationState = 'unknown';
};
