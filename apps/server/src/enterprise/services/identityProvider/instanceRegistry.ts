import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  platformIdentityProviderInstances,
  platformIdentityProviders,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { identityProviderLkgIdentity } from './lkg';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';
import {
  loadCanonicalPublishedIdentityProviders,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

export const IDENTITY_PROVIDER_INSTANCE_STALE_MS = 90_000;
export const IDENTITY_PROVIDER_HEARTBEAT_MS = 30_000;

const processStartedAt = new Date();
const processInstanceId = `oidci_${randomBytes(24).toString('hex')}`;
const processHostnameHash = createHash('sha256').update(hostname(), 'utf8').digest('hex');

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;
let registrationState: 'failed' | 'registered' | 'unknown' = 'unknown';

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
  if (snapshot.source === 'break_glass') return 'break_glass_fallback';
  const error = snapshot.lastError ?? '';
  if (error.includes('secret')) return 'secret_unavailable';
  if (error.includes('permission') || error.includes('owner')) return 'lkg_permissions_invalid';
  if (error.includes('signature')) return 'lkg_signature_invalid';
  if (error.includes('stale')) return 'lkg_stale';
  if (error.startsWith('lkg_write_')) return 'lkg_write_unavailable';
  if (error.includes('activation_status')) return 'instance_status_unavailable';
  return 'startup_snapshot_unavailable';
};

export const getIdentityProviderProcessInstance = () => ({
  hostnameHash: processHostnameHash,
  instanceId: processInstanceId,
  startedAt: processStartedAt,
});

export const getIdentityProviderInstanceRegistrationState = () => registrationState;

export const markIdentityProviderInstanceRegistrationFailed = (): void => {
  registrationState = 'failed';
  registered = false;
};

const demoteActiveProvidersForInstance = async (input: {
  env: Record<string, string | undefined>;
  health: 'degraded' | 'healthy';
  identityRevision: string | null;
  source: IdentityProviderStartupSnapshot['source'];
  tx: Transaction;
}): Promise<void> => {
  const selected = await loadCanonicalPublishedIdentityProviders({
    db: input.tx,
    environmentProviderIds: new Set(parseEnvironmentIdentityProviderIds(input.env)),
  });
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

const heartbeat = async (
  db: LobeChatDatabase,
  env: Record<string, string | undefined>,
): Promise<void> => {
  if (!registered) return;
  await db.transaction(async (tx) => {
    await acquireIdentityProviderConvergenceLock(tx);
    const [instance] = await tx
      .update(platformIdentityProviderInstances)
      .set({ lastHeartbeat: sql`clock_timestamp()` })
      .where(eq(platformIdentityProviderInstances.instanceId, processInstanceId))
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
  });
};

/** Upsert the real startup result for this process, including fail-closed fallback starts. */
export const registerIdentityProviderInstance = async (input: {
  db: LobeChatDatabase;
  env?: Record<string, string | undefined>;
  snapshot: IdentityProviderStartupSnapshot;
}): Promise<void> => {
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
        hostnameHash: processHostnameHash,
        instanceId: processInstanceId,
        lastHeartbeat: sql`clock_timestamp()`,
        loadedAt: input.snapshot.loadedAt,
        startedAt: processStartedAt,
        startupGeneration: input.snapshot.generation,
        startupSource: input.snapshot.source,
      })
      .onConflictDoUpdate({
        set: {
          activeIdentityRevision: input.snapshot.identityRevision,
          degradedCategory: category,
          health: input.snapshot.health,
          hostnameHash: processHostnameHash,
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
  registered = true;
  registrationState = 'registered';

  if (heartbeatTimer || isServerlessRuntime(env)) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat(input.db, env).catch((error) => {
      console.error('[identityProviderInstance] heartbeat unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        instanceId: processInstanceId,
      });
    });
  }, IDENTITY_PROVIDER_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
};

export const stopIdentityProviderHeartbeatForTest = (): void => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  registered = false;
  registrationState = 'unknown';
};
