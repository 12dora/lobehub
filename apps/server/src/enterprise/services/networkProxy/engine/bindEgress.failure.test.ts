import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../moduleSettings', () => ({
  isBootModuleEnabled: () => true,
}));

vi.mock('../egress/scope', () => {
  throw new Error('MODULE_NOT_FOUND');
});

describe('bindNetworkProxyEgressIfEnabled import failure', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs at error level when the scope module fails to load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bindNetworkProxyEgressIfEnabled, resetNetworkProxyEgressBindForTest } =
      await import('./bindEgress');
    resetNetworkProxyEgressBindForTest();
    await bindNetworkProxyEgressIfEnabled();
    expect(error).toHaveBeenCalledWith(
      '[network-proxy] egress bind failed',
      expect.objectContaining({ errorClass: 'Error' }),
    );
    error.mockRestore();
  });
});
