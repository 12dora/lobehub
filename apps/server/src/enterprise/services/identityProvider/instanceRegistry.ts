import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { eq } from 'drizzle-orm';

import { platformIdentityProviderInstances } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { IdentityProviderStartupSnapshot } from './startupArtifact';

export const IDENTITY_PROVIDER_INSTANCE_STALE_MS = 90_000;
export const IDENTITY_PROVIDER_HEARTBEAT_MS = 30_000;

const processStartedAt = new Date();
const processInstanceId = `oidci_${randomBytes(24).toString('hex')}`;
const processHostnameHash = createHash('sha256').update(hostname(), 'utf8').digest('hex');

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;
let registrationState: 'failed' | 'registered' | 'unknown' = 'unknown';

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

const heartbeat = async (db: LobeChatDatabase): Promise<void> => {
  if (!registered) return;
  await db
    .update(platformIdentityProviderInstances)
    .set({ lastHeartbeat: new Date() })
    .where(eq(platformIdentityProviderInstances.instanceId, processInstanceId));
};

/** Upsert the real startup result for this process, including fail-closed fallback starts. */
export const registerIdentityProviderInstance = async (input: {
  db: LobeChatDatabase;
  env?: Record<string, string | undefined>;
  snapshot: IdentityProviderStartupSnapshot;
}): Promise<void> => {
  const now = new Date();
  const category = identityProviderDegradedCategory(input.snapshot);
  await input.db
    .insert(platformIdentityProviderInstances)
    .values({
      activeIdentityRevision: input.snapshot.identityRevision,
      degradedCategory: category,
      health: input.snapshot.health,
      hostnameHash: processHostnameHash,
      instanceId: processInstanceId,
      lastHeartbeat: now,
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
        lastHeartbeat: now,
        loadedAt: input.snapshot.loadedAt,
        startupGeneration: input.snapshot.generation,
        startupSource: input.snapshot.source,
      },
      target: platformIdentityProviderInstances.instanceId,
    });
  registered = true;
  registrationState = 'registered';

  const env = input.env ?? process.env;
  if (heartbeatTimer || isServerlessRuntime(env)) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat(input.db).catch((error) => {
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
