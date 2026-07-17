import { describe, expect, it, vi } from 'vitest';

import { DeviceGateway } from './index';

const params = {
  deviceId: 'device-1',
  userId: 'user-1',
  workspaceId: 'opaque-workspace-id',
};

describe('DeviceGateway managed Skill cleanup', () => {
  it('checks both the RPC envelope and nested cleanup result before succeeding', async () => {
    const invokeRpc = vi
      .fn()
      .mockResolvedValueOnce({ data: { success: false }, success: true })
      .mockResolvedValueOnce({ data: { success: true }, success: true });
    const gateway = new DeviceGateway();
    vi.spyOn(gateway as any, 'getClient').mockReturnValue({ invokeRpc });

    await expect(gateway.cleanupInlineSkillWorkspace(params)).resolves.toBe(true);
    expect(invokeRpc).toHaveBeenCalledTimes(2);
  });

  it('returns false after bounded retries when the outer RPC fails', async () => {
    const invokeRpc = vi.fn().mockResolvedValue({ error: 'offline', success: false });
    const gateway = new DeviceGateway();
    vi.spyOn(gateway as any, 'getClient').mockReturnValue({ invokeRpc });

    await expect(gateway.cleanupInlineSkillWorkspace(params)).resolves.toBe(false);
    expect(invokeRpc).toHaveBeenCalledTimes(2);
  });
});
