import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformSandboxSettingsModel } from '@/database/models/platform/sandboxSettings';
import { sandboxEnv } from '@/envs/sandbox';
import type {
  PlatformSandboxSettings,
  SandboxSettingsNetwork,
  SandboxSettingsProviderKind,
  SandboxSettingsPullPolicy,
} from '@/types/platform/sandboxSettings';
import { normalizeSandboxSettings } from '@/types/platform/sandboxSettings';

const CACHE_TTL_MS = 30_000;

export interface SandboxEnvBag {
  SANDBOX_DOCKER_HOST?: string;
  SANDBOX_DOCKER_SOCKET: string;
  SANDBOX_LOCAL_CPUS: number;
  SANDBOX_LOCAL_IDLE_TTL_SEC: number;
  SANDBOX_LOCAL_IMAGE: string;
  SANDBOX_LOCAL_MAX_CONTAINERS: number;
  SANDBOX_LOCAL_MAX_OUTPUT_BYTES: number;
  SANDBOX_LOCAL_MEMORY_MB: number;
  SANDBOX_LOCAL_NETWORK: SandboxSettingsNetwork;
  SANDBOX_LOCAL_PIDS_LIMIT: number;
  SANDBOX_LOCAL_PULL_POLICY: SandboxSettingsPullPolicy;
  SANDBOX_LOCAL_TIMEOUT_MS: number;
  SANDBOX_PROVIDER: SandboxSettingsProviderKind;
}

/** Fully resolved sandbox settings used by the factory and health probe. */
export interface EffectiveSandboxSettings {
  cpus: number;
  dockerHost?: string;
  dockerSocket: string;
  idleTtlSec: number;
  image: string;
  maxContainers: number;
  maxOutputBytes: number;
  memoryMb: number;
  network: SandboxSettingsNetwork;
  pidsLimit: number;
  provider: SandboxSettingsProviderKind;
  pullPolicy: SandboxSettingsPullPolicy;
  revision: number;
  source: 'db' | 'env';
  timeoutMs: number;
}

interface CacheSlot {
  expiresAt: number;
  value: EffectiveSandboxSettings;
}

let cache: CacheSlot | null = null;

const readEnvBag = (override?: SandboxEnvBag): SandboxEnvBag => {
  if (override) return override;
  return {
    SANDBOX_DOCKER_HOST: sandboxEnv.SANDBOX_DOCKER_HOST,
    SANDBOX_DOCKER_SOCKET: sandboxEnv.SANDBOX_DOCKER_SOCKET,
    SANDBOX_LOCAL_CPUS: sandboxEnv.SANDBOX_LOCAL_CPUS,
    SANDBOX_LOCAL_IDLE_TTL_SEC: sandboxEnv.SANDBOX_LOCAL_IDLE_TTL_SEC,
    SANDBOX_LOCAL_IMAGE: sandboxEnv.SANDBOX_LOCAL_IMAGE,
    SANDBOX_LOCAL_MAX_CONTAINERS: sandboxEnv.SANDBOX_LOCAL_MAX_CONTAINERS,
    SANDBOX_LOCAL_MAX_OUTPUT_BYTES: sandboxEnv.SANDBOX_LOCAL_MAX_OUTPUT_BYTES,
    SANDBOX_LOCAL_MEMORY_MB: sandboxEnv.SANDBOX_LOCAL_MEMORY_MB,
    SANDBOX_LOCAL_NETWORK: sandboxEnv.SANDBOX_LOCAL_NETWORK,
    SANDBOX_LOCAL_PIDS_LIMIT: sandboxEnv.SANDBOX_LOCAL_PIDS_LIMIT,
    SANDBOX_LOCAL_PULL_POLICY: sandboxEnv.SANDBOX_LOCAL_PULL_POLICY,
    SANDBOX_LOCAL_TIMEOUT_MS: sandboxEnv.SANDBOX_LOCAL_TIMEOUT_MS,
    SANDBOX_PROVIDER: sandboxEnv.SANDBOX_PROVIDER,
  };
};

const pick = <T>(dbValue: T | undefined, envValue: T): T =>
  dbValue !== undefined && dbValue !== null ? dbValue : envValue;

export const mergeSandboxSettings = (
  env: SandboxEnvBag,
  stored: PlatformSandboxSettings & { revision: number },
): EffectiveSandboxSettings => {
  const useDb = stored.enabled;
  const source: 'db' | 'env' = useDb ? 'db' : 'env';
  const dockerHost = useDb
    ? pick(stored.dockerHost, env.SANDBOX_DOCKER_HOST)
    : env.SANDBOX_DOCKER_HOST;
  return {
    cpus: useDb ? pick(stored.cpus, env.SANDBOX_LOCAL_CPUS) : env.SANDBOX_LOCAL_CPUS,
    ...(dockerHost ? { dockerHost } : {}),
    dockerSocket: useDb
      ? pick(stored.dockerSocket, env.SANDBOX_DOCKER_SOCKET)
      : env.SANDBOX_DOCKER_SOCKET,
    idleTtlSec: useDb
      ? pick(stored.idleTtlSec, env.SANDBOX_LOCAL_IDLE_TTL_SEC)
      : env.SANDBOX_LOCAL_IDLE_TTL_SEC,
    image: useDb ? pick(stored.image, env.SANDBOX_LOCAL_IMAGE) : env.SANDBOX_LOCAL_IMAGE,
    maxContainers: useDb
      ? pick(stored.maxContainers, env.SANDBOX_LOCAL_MAX_CONTAINERS)
      : env.SANDBOX_LOCAL_MAX_CONTAINERS,
    maxOutputBytes: useDb
      ? pick(stored.maxOutputBytes, env.SANDBOX_LOCAL_MAX_OUTPUT_BYTES)
      : env.SANDBOX_LOCAL_MAX_OUTPUT_BYTES,
    memoryMb: useDb
      ? pick(stored.memoryMb, env.SANDBOX_LOCAL_MEMORY_MB)
      : env.SANDBOX_LOCAL_MEMORY_MB,
    network: useDb ? pick(stored.network, env.SANDBOX_LOCAL_NETWORK) : env.SANDBOX_LOCAL_NETWORK,
    pidsLimit: useDb
      ? pick(stored.pidsLimit, env.SANDBOX_LOCAL_PIDS_LIMIT)
      : env.SANDBOX_LOCAL_PIDS_LIMIT,
    provider: useDb ? pick(stored.provider, env.SANDBOX_PROVIDER) : env.SANDBOX_PROVIDER,
    pullPolicy: useDb
      ? pick(stored.pullPolicy, env.SANDBOX_LOCAL_PULL_POLICY)
      : env.SANDBOX_LOCAL_PULL_POLICY,
    revision: stored.revision,
    source,
    timeoutMs: useDb
      ? pick(stored.timeoutMs, env.SANDBOX_LOCAL_TIMEOUT_MS)
      : env.SANDBOX_LOCAL_TIMEOUT_MS,
  };
};

export const settingsFromEnv = (override?: SandboxEnvBag): EffectiveSandboxSettings =>
  mergeSandboxSettings(readEnvBag(override), { ...normalizeSandboxSettings({}), revision: 0 });

/** Sync peek of the in-process cache — env when cold. Used by `getSandboxProviderKind`. */
export const peekEffectiveSandboxProviderKind = (): SandboxSettingsProviderKind | undefined =>
  cache?.value.provider;

export const invalidateEffectiveSandboxSettings = (): void => {
  cache = null;
};

export const resetEffectiveSandboxSettingsForTest = (): void => {
  cache = null;
};

export interface GetEffectiveSandboxSettingsOptions {
  db?: ConstructorParameters<typeof PlatformSandboxSettingsModel>[0];
  env?: SandboxEnvBag;
  now?: () => number;
}

/**
 * Cached effective sandbox settings: each stored field overrides env (`DB ?? env`).
 * Invalidated on save. Fail-open to env when the database is unavailable.
 */
export const getEffectiveSandboxSettings = async (
  options: GetEffectiveSandboxSettingsOptions = {},
): Promise<EffectiveSandboxSettings> => {
  const now = options.now?.() ?? Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }

  const env = readEnvBag(options.env);
  let stored: PlatformSandboxSettings & { revision: number } = {
    ...normalizeSandboxSettings({}),
    revision: 0,
  };
  try {
    const db = options.db ?? (await getServerDB());
    stored = await new PlatformSandboxSettingsModel(db).get();
  } catch {
    // Fail open: a DB outage must not take the sandbox factory down.
  }

  const value = mergeSandboxSettings(env, stored);
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
};
