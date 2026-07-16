import { getRedisConfig } from '@/envs/redis';
import { initializeRedis } from '@/libs/redis';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';

export type ConnectorRuntimeEffectiveMode = 'blocked' | 'enforced' | 'legacy';

export interface ConnectorRuntimeEffectiveState {
  mode: ConnectorRuntimeEffectiveMode;
  revision: number;
}

const REDIS_KEY = 'platform:managed:connectors:effective:v1';
let localState: ConnectorRuntimeEffectiveState | null = null;

const parseState = (value: string | null): ConnectorRuntimeEffectiveState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ConnectorRuntimeEffectiveState>;
    return parsed &&
      ['blocked', 'enforced', 'legacy'].includes(parsed.mode ?? '') &&
      Number.isSafeInteger(parsed.revision) &&
      (parsed.revision ?? -1) >= 0
      ? { mode: parsed.mode!, revision: parsed.revision! }
      : null;
  } catch {
    return null;
  }
};

/**
 * Publish the already-resolved server capability. Runtime callers consume this
 * state and never query the policy/catalog merely to decide a mode.
 */
export const publishConnectorRuntimeEffectiveState = async (
  state: ConnectorRuntimeEffectiveState,
): Promise<void> => {
  const config = getRedisConfig();
  if (!config.enabled) {
    localState = { ...state };
    return;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  await redis.set(REDIS_KEY, JSON.stringify(state));
  localState = { ...state };
};

/** Feature-off is exact legacy. Feature-on without trusted state is fail-closed. */
export const getConnectorRuntimeEffectiveState = async (
  env: ConnectorOAuthRuntimeEnv = process.env,
): Promise<ConnectorRuntimeEffectiveState> => {
  if (!parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    return { mode: 'legacy', revision: 0 };
  }
  try {
    const config = getRedisConfig();
    if (config.enabled) {
      const redis = await initializeRedis(config);
      const shared = parseState((await redis?.get(REDIS_KEY)) ?? null);
      if (shared) {
        localState = shared;
        return { ...shared };
      }
      return { mode: 'blocked', revision: 0 };
    }
  } catch (error) {
    console.error('[connector-runtime-state] shared state read failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return { mode: 'blocked', revision: 0 };
  }
  if (localState) return { ...localState };
  return { mode: 'blocked', revision: 0 };
};

export const resetConnectorRuntimeEffectiveStateForTest = (): void => {
  localState = null;
};
