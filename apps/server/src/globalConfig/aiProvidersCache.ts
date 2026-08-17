import { createHash } from 'node:crypto';

import {
  genServerAiProvidersConfig,
  type ProviderSpecificConfig,
} from './genServerAiProviderConfig';

const AI_PROVIDERS_CACHE_TTL_MS = 60_000;

type ProvidersConfig = Awaited<ReturnType<typeof genServerAiProvidersConfig>>;

interface ProvidersCacheSlot {
  expiresAt: number;
  fingerprint: string;
  value: ProvidersConfig;
}

let slot: ProvidersCacheSlot | null = null;
let inflight: { fingerprint: string; promise: Promise<ProvidersConfig> } | null = null;

/**
 * Env + specific-config fingerprint for the 86-provider generation.
 * Infra snapshot does not feed this path (`enableUploadFileToServer` stays uncached).
 */
export const fingerprintAiProvidersConfig = (
  specificConfig: Record<string, ProviderSpecificConfig>,
): string => {
  const envKeys = Object.keys(process.env)
    .filter((key) => key.endsWith('_MODEL_LIST') || key.startsWith('ENABLED_'))
    .sort();
  return createHash('sha256')
    .update(JSON.stringify(specificConfig))
    .update('\0')
    .update(envKeys.map((key) => `${key}=${process.env[key] ?? ''}`).join('\n'))
    .digest('hex');
};

/**
 * Process-level memo around {@link genServerAiProvidersConfig}.
 * Single-slot + single-flight, TTL 60s. Does not wrap the whole server config.
 */
export const getCachedServerAiProvidersConfig = async (
  specificConfig: Record<string, ProviderSpecificConfig>,
): Promise<ProvidersConfig> => {
  const fingerprint = fingerprintAiProvidersConfig(specificConfig);
  const now = Date.now();
  if (slot && slot.fingerprint === fingerprint && slot.expiresAt > now) {
    return slot.value;
  }
  if (inflight && inflight.fingerprint === fingerprint) {
    return inflight.promise;
  }

  const promise = genServerAiProvidersConfig(specificConfig)
    .then((value) => {
      slot = {
        expiresAt: Date.now() + AI_PROVIDERS_CACHE_TTL_MS,
        fingerprint,
        value,
      };
      return value;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { fingerprint, promise };
  return promise;
};

/** Test helper. */
export const resetAiProvidersCacheForTest = (): void => {
  slot = null;
  inflight = null;
};
