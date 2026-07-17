import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginConnectorRuntimeEffectiveStateTransition,
  finalizeConnectorRuntimeEffectiveStateTransition,
  getConnectorRuntimeEffectiveState,
  publishConnectorRuntimeCapabilityState,
  publishConnectorRuntimeEffectiveState,
  reserveConnectorRuntimeEffectiveStateEpoch,
  resetConnectorRuntimeEffectiveStateForTest,
} from './runtimeEffectiveState';

const redisState = vi.hoisted(() => ({
  enabled: true,
  epoch: 0,
  transition: null as string | null,
  value: null as string | null,
}));
const redis = vi.hoisted(() => ({
  eval: vi.fn(async (script: string, _keys: number, ...args: string[]) => {
    if (script.includes('transition = cjson.encode')) {
      redisState.epoch += 1;
      redisState.transition = args[3]!;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: 'blocked',
        revision: Number(args[4]),
      });
      return redisState.value;
    }
    if (script.includes("redis.call('EXISTS'")) {
      redisState.epoch += 1;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: redisState.transition ? 'blocked' : args[3],
        revision: Number(args[4]),
      });
      return redisState.value;
    }
    if (script.includes("redis.call('DEL'")) {
      if (redisState.transition !== args[3]) return null;
      redisState.epoch += 1;
      redisState.transition = null;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: args[4],
        revision: Number(args[5]),
      });
      return redisState.value;
    }
    const epoch = args[1]!;
    const value = args[2]!;
    const current = redisState.value ? (JSON.parse(redisState.value) as { epoch: number }) : null;
    if (current && current.epoch > Number(epoch)) return 0;
    redisState.value = value;
    return 1;
  }),
  get: vi.fn(async () => redisState.value),
  incr: vi.fn(async () => {
    redisState.epoch += 1;
    return redisState.epoch;
  }),
}));

vi.mock('@/envs/redis', () => ({ getRedisConfig: () => ({ enabled: redisState.enabled }) }));
vi.mock('@/libs/redis', () => ({ initializeRedis: async () => redis }));

describe('connector runtime effective-state authority', () => {
  beforeEach(() => {
    redisState.enabled = true;
    redisState.epoch = 0;
    redisState.transition = null;
    redisState.value = null;
    vi.clearAllMocks();
    resetConnectorRuntimeEffectiveStateForTest();
  });

  it('lets a post-commit authority outrank a reader that observed pre-commit DB state', async () => {
    const preBlockEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    await publishConnectorRuntimeEffectiveState({
      epoch: preBlockEpoch,
      mode: 'blocked',
      revision: 8,
    });
    const oldReaderEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    await publishConnectorRuntimeEffectiveState({
      epoch: oldReaderEpoch,
      mode: 'legacy',
      revision: 8,
    });
    const postCommitEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    await publishConnectorRuntimeEffectiveState({
      epoch: postCommitEpoch,
      mode: 'enforced',
      revision: 9,
    });

    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toEqual({ epoch: postCommitEpoch, mode: 'enforced', revision: 9 });
  });

  it('fails closed across instances when shared Redis authority is disabled', async () => {
    redisState.enabled = false;
    const staleEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    const currentEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    await publishConnectorRuntimeEffectiveState({
      epoch: currentEpoch,
      mode: 'enforced',
      revision: 9,
    });
    await publishConnectorRuntimeEffectiveState({
      epoch: staleEpoch,
      mode: 'legacy',
      revision: 8,
    });

    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toEqual({ epoch: 0, mode: 'blocked', revision: 0 });
  });

  it('keeps capability writers blocked until the transition token finalizes atomically', async () => {
    const token = await beginConnectorRuntimeEffectiveStateTransition(8);
    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 8 });
    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toMatchObject({ mode: 'blocked', revision: 8 });

    await finalizeConnectorRuntimeEffectiveStateTransition({
      mode: 'enforced',
      revision: 9,
      token,
    });
    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toMatchObject({ mode: 'enforced', revision: 9 });
  });

  it('rejects a stale capability writer that finishes after a newer policy publish', async () => {
    const staleEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    const currentEpoch = await reserveConnectorRuntimeEffectiveStateEpoch();
    await publishConnectorRuntimeEffectiveState({
      epoch: currentEpoch,
      mode: 'enforced',
      revision: 9,
    });

    await publishConnectorRuntimeEffectiveState({
      epoch: staleEpoch,
      mode: 'legacy',
      revision: 8,
    });

    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toEqual({ epoch: currentEpoch, mode: 'enforced', revision: 9 });
  });
});
