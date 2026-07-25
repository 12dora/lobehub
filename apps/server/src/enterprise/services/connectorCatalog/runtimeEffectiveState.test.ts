import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginConnectorRuntimeEffectiveStateTransition,
  cancelConnectorRuntimeEffectiveStateTransition,
  finalizeConnectorRuntimeEffectiveStateTransition,
  getConnectorRuntimeEffectiveState,
  getConnectorRuntimeLocalEpochForTest,
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
  // Mock implements generic transition/CAS-by-epoch semantics only.
  // Capability mode+revision short-circuit is intentionally NOT reimplemented here —
  // tests assert the real CAPABILITY_SCRIPT source is passed to eval (R5).
  eval: vi.fn(async (script: string, _keys: number, ...args: string[]) => {
    if (script.includes("'PX'")) {
      if (redisState.transition) return null;
      const previous = redisState.value
        ? (JSON.parse(redisState.value) as { mode: string; revision: number })
        : { mode: 'blocked', revision: 0 };
      redisState.epoch += 1;
      redisState.transition = args[3]!;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: 'blocked',
        previousMode: previous.mode,
        previousRevision: previous.revision,
        revision: Number(args[4]),
        transitionToken: args[3],
      });
      return redisState.value;
    }
    if (script.includes('mode = ARGV[1]')) {
      // Capability publish path: always apply (no JS reimplementation of Lua CAS).
      if (redisState.transition) return redisState.value;
      redisState.epoch += 1;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: args[3]!,
        revision: Number(args[4]),
      });
      return redisState.value;
    }
    if (script.includes('decoded.transitionToken ~= ARGV[1]')) {
      if (redisState.transition !== args[3]) return null;
      const current = JSON.parse(redisState.value!) as {
        previousMode: string;
        previousRevision: number;
      };
      redisState.epoch += 1;
      redisState.transition = null;
      redisState.value = JSON.stringify({
        epoch: redisState.epoch,
        mode: current.previousMode,
        revision: current.previousRevision,
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

const CAPABILITY_CAS_SNIPPET =
  'decoded.mode == ARGV[1] and tonumber(decoded.revision or 0) == tonumber(ARGV[2])';
const REDIS_KEY = 'platform:managed:connectors:effective:v1';
const REDIS_EPOCH_KEY = 'platform:managed:connectors:effective:epoch:v1';
const REDIS_TRANSITION_KEY = 'platform:managed:connectors:effective:transition:v1';

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

  it('rejects concurrent transition owners and restores the published strategy on cancel', async () => {
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 7 });
    const token = await beginConnectorRuntimeEffectiveStateTransition(7);
    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 8 });

    await expect(beginConnectorRuntimeEffectiveStateTransition(7)).rejects.toThrow(
      'transition state is invalid',
    );
    await expect(cancelConnectorRuntimeEffectiveStateTransition('not-owner')).resolves.toBe(false);
    await expect(cancelConnectorRuntimeEffectiveStateTransition(token)).resolves.toBe(true);
    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toMatchObject({ mode: 'enforced', revision: 7 });
  });

  it('stays blocked after a commit-unknown owner expires until DB authority republishes', async () => {
    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 6 });
    await beginConnectorRuntimeEffectiveStateTransition(6);
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 7 });
    redisState.transition = null;

    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toMatchObject({ mode: 'blocked', revision: 6 });

    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 7 });
    await expect(
      getConnectorRuntimeEffectiveState({ ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' }),
    ).resolves.toMatchObject({ mode: 'enforced', revision: 7 });
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

  it('passes CAPABILITY_SCRIPT with mode+revision CAS to redis.eval (not mock-reimplemented)', async () => {
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 3 });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const first = redis.eval.mock.calls[0]!;
    // Fail if the real Lua CAS short-circuit is removed from CAPABILITY_SCRIPT.
    expect(first[0]).toContain(CAPABILITY_CAS_SNIPPET);
    expect(first[0]).toContain("if redis.call('EXISTS', KEYS[3]) == 1 then");
    expect(first[0]).toContain("redis.call('INCR', KEYS[2])");
    expect(first.slice(1)).toEqual([
      3,
      REDIS_KEY,
      REDIS_EPOCH_KEY,
      REDIS_TRANSITION_KEY,
      'enforced',
      '3',
    ]);

    redis.eval.mockClear();
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 3 });
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 3 });

    // Idempotent republish still goes through the same CAS script + ARGV sequence.
    expect(redis.eval).toHaveBeenCalledTimes(2);
    for (const call of redis.eval.mock.calls) {
      expect(call[0]).toContain(CAPABILITY_CAS_SNIPPET);
      expect(call.slice(1)).toEqual([
        3,
        REDIS_KEY,
        REDIS_EPOCH_KEY,
        REDIS_TRANSITION_KEY,
        'enforced',
        '3',
      ]);
    }
  });

  it('does not advance process-local epoch on unchanged capability publish', async () => {
    redisState.enabled = false;
    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 1 });
    expect(getConnectorRuntimeLocalEpochForTest()).toBe(1);

    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 1 });
    await publishConnectorRuntimeCapabilityState({ mode: 'legacy', revision: 1 });
    // Without the Redis-off CAS at publishConnectorRuntimeCapabilityState, epoch would be 3.
    expect(getConnectorRuntimeLocalEpochForTest()).toBe(1);

    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 5 });
    expect(getConnectorRuntimeLocalEpochForTest()).toBe(2);
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 5 });
    await publishConnectorRuntimeCapabilityState({ mode: 'enforced', revision: 5 });
    expect(getConnectorRuntimeLocalEpochForTest()).toBe(2);
  });
});
