import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { resolveConnectorRuntimeMode } from './runtimeIntegration';

const db = {} as LobeChatDatabase;
const publishedSnapshot = (enforcementMode: 'enforced' | 'observe' | 'ui-only') => ({
  draft: {} as never,
  published: {
    connectors: { enforcementMode, managed: true },
  } as never,
  revision: 3,
  status: 'published' as const,
});

describe('connector runtime integration mode', () => {
  it('does no policy or readiness I/O when the feature flag is off', async () => {
    const policySnapshot = vi.fn();
    const readiness = vi.fn();

    await expect(
      resolveConnectorRuntimeMode({ db, env: {}, policySnapshot, readiness }),
    ).resolves.toBe('legacy');
    expect(policySnapshot).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  });

  it.each(['observe', 'ui-only'] as const)(
    'preserves legacy execution in %s mode without catalog readiness I/O',
    async (enforcementMode) => {
      const readiness = vi.fn();

      await expect(
        resolveConnectorRuntimeMode({
          db,
          env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
          policySnapshot: async () => publishedSnapshot(enforcementMode),
          readiness,
        }),
      ).resolves.toBe('legacy');
      expect(readiness).not.toHaveBeenCalled();
    },
  );

  it('fails closed when enforced catalog readiness is false', async () => {
    await expect(
      resolveConnectorRuntimeMode({
        db,
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        policySnapshot: async () => publishedSnapshot('enforced'),
        readiness: async () => false,
      }),
    ).resolves.toBe('blocked');
  });

  it('enters enforced mode only after readiness succeeds', async () => {
    await expect(
      resolveConnectorRuntimeMode({
        db,
        env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
        policySnapshot: async () => publishedSnapshot('enforced'),
        readiness: async () => true,
      }),
    ).resolves.toBe('enforced');
  });
});
