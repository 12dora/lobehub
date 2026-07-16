import { describe, expect, it, vi } from 'vitest';

import {
  assertLegacyConnectorRuntimeAllowed,
  resolveConnectorRuntimeMode,
} from './runtimeIntegration';

describe('connector runtime integration mode', () => {
  it('does no policy or readiness I/O when the feature flag is off', async () => {
    const resolveState = vi.fn();

    await expect(resolveConnectorRuntimeMode({ env: {}, resolveState })).resolves.toBe('legacy');
    expect(resolveState).not.toHaveBeenCalled();
  });

  it('preserves legacy execution from the trusted effective state', async () => {
    await expect(
      resolveConnectorRuntimeMode({
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        resolveState: async () => ({ mode: 'legacy', revision: 3 }),
      }),
    ).resolves.toBe('legacy');
  });

  it('fails closed when enforced catalog readiness is false', async () => {
    await expect(
      resolveConnectorRuntimeMode({
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        resolveState: async () => ({ mode: 'blocked', revision: 3 }),
      }),
    ).resolves.toBe('blocked');
  });

  it('enters enforced mode only after readiness succeeds', async () => {
    await expect(
      resolveConnectorRuntimeMode({
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        resolveState: async () => ({ mode: 'enforced', revision: 3 }),
      }),
    ).resolves.toBe('enforced');
  });

  it('denies direct MCP transport wholesale in enforced mode without inspecting client name/url', async () => {
    await expect(
      assertLegacyConnectorRuntimeAllowed({
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        resolveState: async () => ({ mode: 'enforced', revision: 3 }),
      }),
    ).rejects.toThrow('PLATFORM_CONNECTOR_TOOL_DENIED');
  });
});
