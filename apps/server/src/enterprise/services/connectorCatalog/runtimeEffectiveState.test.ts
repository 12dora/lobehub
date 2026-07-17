import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getConnectorRuntimeEffectiveState,
  publishConnectorRuntimeEffectiveState,
  reserveConnectorRuntimeEffectiveStateEpoch,
  resetConnectorRuntimeEffectiveStateForTest,
} from './runtimeEffectiveState';

const redisState = vi.hoisted(() => ({
  epoch: 0,
  value: null as string | null,
}));
const redis = vi.hoisted(() => ({
  eval: vi.fn(
    async (_script: string, _keys: number, _key: string, epoch: string, value: string) => {
      const current = redisState.value ? (JSON.parse(redisState.value) as { epoch: number }) : null;
      if (current && current.epoch > Number(epoch)) return 0;
      redisState.value = value;
      return 1;
    },
  ),
  get: vi.fn(async () => redisState.value),
  incr: vi.fn(async () => {
    redisState.epoch += 1;
    return redisState.epoch;
  }),
}));

vi.mock('@/envs/redis', () => ({ getRedisConfig: () => ({ enabled: true }) }));
vi.mock('@/libs/redis', () => ({ initializeRedis: async () => redis }));

describe('connector runtime effective-state authority', () => {
  beforeEach(() => {
    redisState.epoch = 0;
    redisState.value = null;
    vi.clearAllMocks();
    resetConnectorRuntimeEffectiveStateForTest();
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
