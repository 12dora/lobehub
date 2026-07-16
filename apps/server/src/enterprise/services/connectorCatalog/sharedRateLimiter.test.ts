import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedConnectorRuntimeRateLimiter } from './sharedRateLimiter';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  getAgentRuntimeRedisClient: mocks.getRedis,
}));

describe('SharedConnectorRuntimeRateLimiter', () => {
  beforeEach(() => {
    mocks.eval.mockReset();
    mocks.getRedis.mockReset().mockReturnValue({ eval: mocks.eval });
  });

  it('fails closed when the shared Redis authority is unavailable', async () => {
    mocks.getRedis.mockReturnValue(null);

    await expect(
      new SharedConnectorRuntimeRateLimiter().consume('connector-1:user-1'),
    ).resolves.toBe(false);
  });

  it('uses one atomic Redis operation and does not expose the raw scope in the key', async () => {
    mocks.eval.mockResolvedValue(30);

    await expect(
      new SharedConnectorRuntimeRateLimiter().consume('connector-1:user-1'),
    ).resolves.toBe(true);
    expect(mocks.eval).toHaveBeenCalledOnce();
    expect(mocks.eval.mock.calls[0]?.[2]).toMatch(/^platform:connector-runtime:rate:[a-f\d]{64}$/);
    expect(mocks.eval.mock.calls[0]?.[2]).not.toContain('connector-1');
  });

  it('denies the request after the shared window limit', async () => {
    mocks.eval.mockResolvedValue(31);

    await expect(
      new SharedConnectorRuntimeRateLimiter().consume('connector-1:user-1'),
    ).resolves.toBe(false);
  });
});
