// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { resolveConnectorCatalogRuntimeReadiness } from './runtimeReadiness';

const db = {} as LobeChatDatabase;
const masterKey = Buffer.alloc(32, 8).toString('base64');
const env = {
  APP_URL: 'https://aihub.example.test',
  ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
  PLATFORM_MASTER_KEY: masterKey,
};

describe('resolveConnectorCatalogRuntimeReadiness', () => {
  it('is ready in a fresh feature-on process only with production dependencies and a publication', async () => {
    const listConnectors = vi.fn().mockResolvedValue({
      items: [{} as never],
      nextCursor: null,
    });
    await expect(
      resolveConnectorCatalogRuntimeReadiness({ db, env, repository: { listConnectors } }),
    ).resolves.toBe(true);
  });

  it('fails closed when no published connector exists or M13 key material is missing', async () => {
    const listConnectors = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    const repository = { listConnectors };
    await expect(resolveConnectorCatalogRuntimeReadiness({ db, env, repository })).resolves.toBe(
      false,
    );
    await expect(
      resolveConnectorCatalogRuntimeReadiness({
        db,
        env: { APP_URL: env.APP_URL, ENABLE_PLATFORM_MANAGED_CONNECTORS: '1' },
        repository,
      }),
    ).rejects.toThrow();
  });
});
