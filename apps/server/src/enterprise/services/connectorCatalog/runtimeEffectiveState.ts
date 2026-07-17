import { randomUUID } from 'node:crypto';

import { getRedisConfig } from '@/envs/redis';
import { initializeRedis } from '@/libs/redis';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';

export type ConnectorRuntimeEffectiveMode = 'blocked' | 'enforced' | 'legacy';

export interface ConnectorRuntimeEffectiveState {
  epoch: number;
  mode: ConnectorRuntimeEffectiveMode;
  revision: number;
}

const REDIS_KEY = 'platform:managed:connectors:effective:v1';
const REDIS_EPOCH_KEY = 'platform:managed:connectors:effective:epoch:v1';
const REDIS_TRANSITION_KEY = 'platform:managed:connectors:effective:transition:v1';
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if tonumber(decoded.epoch or 0) > tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;
let localState: ConnectorRuntimeEffectiveState | null = null;
let localEpoch = 0;
let localTransitionToken: string | null = null;

const BEGIN_TRANSITION_SCRIPT = `
local epoch = redis.call('INCR', KEYS[2])
local transition = cjson.encode({ token = ARGV[1], epoch = epoch })
redis.call('SET', KEYS[3], transition)
local state = cjson.encode({ epoch = epoch, mode = 'blocked', revision = tonumber(ARGV[2]) })
redis.call('SET', KEYS[1], state)
return state
`;
const CAPABILITY_SCRIPT = `
local epoch = redis.call('INCR', KEYS[2])
local mode = ARGV[1]
if redis.call('EXISTS', KEYS[3]) == 1 then mode = 'blocked' end
local state = cjson.encode({ epoch = epoch, mode = mode, revision = tonumber(ARGV[2]) })
redis.call('SET', KEYS[1], state)
return state
`;
const FINALIZE_TRANSITION_SCRIPT = `
local transition = redis.call('GET', KEYS[3])
if not transition or cjson.decode(transition).token ~= ARGV[1] then return nil end
local epoch = redis.call('INCR', KEYS[2])
local state = cjson.encode({ epoch = epoch, mode = ARGV[2], revision = tonumber(ARGV[3]) })
redis.call('SET', KEYS[1], state)
redis.call('DEL', KEYS[3])
return state
`;

const parseState = (value: string | null): ConnectorRuntimeEffectiveState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ConnectorRuntimeEffectiveState>;
    return parsed &&
      ['blocked', 'enforced', 'legacy'].includes(parsed.mode ?? '') &&
      Number.isSafeInteger(parsed.epoch) &&
      (parsed.epoch ?? -1) >= 0 &&
      Number.isSafeInteger(parsed.revision) &&
      (parsed.revision ?? -1) >= 0
      ? { epoch: parsed.epoch!, mode: parsed.mode!, revision: parsed.revision! }
      : null;
  } catch {
    return null;
  }
};

/** Reserve authority order before reading DB policy/readiness, not after. */
export const reserveConnectorRuntimeEffectiveStateEpoch = async (): Promise<number> => {
  const config = getRedisConfig();
  if (!config.enabled) {
    localEpoch += 1;
    return localEpoch;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  const epoch = Number(await redis.incr(REDIS_EPOCH_KEY));
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error('Connector runtime effective-state epoch is invalid');
  }
  return epoch;
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
    if (!localState || localState.epoch <= state.epoch) localState = { ...state };
    return;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  const applied = Number(
    await redis.eval(CAS_SCRIPT, 1, REDIS_KEY, String(state.epoch), JSON.stringify(state)),
  );
  if (applied === 1) localState = { ...state };
};

export const beginConnectorRuntimeEffectiveStateTransition = async (
  revision: number,
): Promise<string> => {
  const token = randomUUID();
  const config = getRedisConfig();
  if (!config.enabled) {
    localEpoch += 1;
    localTransitionToken = token;
    localState = { epoch: localEpoch, mode: 'blocked', revision };
    return token;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  const value = await redis.eval(
    BEGIN_TRANSITION_SCRIPT,
    3,
    REDIS_KEY,
    REDIS_EPOCH_KEY,
    REDIS_TRANSITION_KEY,
    token,
    String(revision),
  );
  const state = parseState(typeof value === 'string' ? value : null);
  if (!state) throw new Error('Connector runtime transition state is invalid');
  localState = state;
  return token;
};

export const publishConnectorRuntimeCapabilityState = async (params: {
  mode: ConnectorRuntimeEffectiveMode;
  revision: number;
}): Promise<void> => {
  const config = getRedisConfig();
  if (!config.enabled) {
    localEpoch += 1;
    localState = {
      epoch: localEpoch,
      mode: localTransitionToken ? 'blocked' : params.mode,
      revision: params.revision,
    };
    return;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  const value = await redis.eval(
    CAPABILITY_SCRIPT,
    3,
    REDIS_KEY,
    REDIS_EPOCH_KEY,
    REDIS_TRANSITION_KEY,
    params.mode,
    String(params.revision),
  );
  const state = parseState(typeof value === 'string' ? value : null);
  if (!state) throw new Error('Connector runtime capability state is invalid');
  localState = state;
};

export const finalizeConnectorRuntimeEffectiveStateTransition = async (params: {
  mode: ConnectorRuntimeEffectiveMode;
  revision: number;
  token: string;
}): Promise<void> => {
  const config = getRedisConfig();
  if (!config.enabled) {
    if (localTransitionToken !== params.token) {
      throw new Error('Connector runtime transition authority mismatch');
    }
    localEpoch += 1;
    localState = { epoch: localEpoch, mode: params.mode, revision: params.revision };
    localTransitionToken = null;
    return;
  }
  const redis = await initializeRedis(config);
  if (!redis) throw new Error('Connector runtime effective-state Redis is unavailable');
  const value = await redis.eval(
    FINALIZE_TRANSITION_SCRIPT,
    3,
    REDIS_KEY,
    REDIS_EPOCH_KEY,
    REDIS_TRANSITION_KEY,
    params.token,
    params.mode,
    String(params.revision),
  );
  const state = parseState(typeof value === 'string' ? value : null);
  if (!state) throw new Error('Connector runtime transition authority mismatch');
  localState = state;
};

/** Feature-off is exact legacy. Feature-on without trusted state is fail-closed. */
export const getConnectorRuntimeEffectiveState = async (
  env: ConnectorOAuthRuntimeEnv = process.env,
): Promise<ConnectorRuntimeEffectiveState> => {
  if (!parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    return { epoch: 0, mode: 'legacy', revision: 0 };
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
      return { epoch: 0, mode: 'blocked', revision: 0 };
    }
  } catch (error) {
    console.error('[connector-runtime-state] shared state read failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return { epoch: 0, mode: 'blocked', revision: 0 };
  }
  // Without shared authority, multiple Web instances cannot prove that a
  // publish transition is complete. Fail closed instead of trusting process CAS.
  if (!getRedisConfig().enabled) return { epoch: 0, mode: 'blocked', revision: 0 };
  if (localState) return { ...localState };
  return { epoch: 0, mode: 'blocked', revision: 0 };
};

export const resetConnectorRuntimeEffectiveStateForTest = (): void => {
  localState = null;
  localEpoch = 0;
  localTransitionToken = null;
};
