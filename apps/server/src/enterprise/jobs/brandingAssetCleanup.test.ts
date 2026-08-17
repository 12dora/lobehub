// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { runBrandingAssetCleanupBatch } from './brandingAssetCleanup';

describe('runBrandingAssetCleanupBatch', () => {
  it('runs the bounded sweep independently of an upload', async () => {
    const sweep = vi.fn().mockResolvedValue({ deleted: 2, failed: 0, scanned: 2 });

    await expect(
      runBrandingAssetCleanupBatch({} as LobeChatDatabase, {
        isStorageConfigured: async () => true,
        sweep,
      }),
    ).resolves.toEqual({ deleted: 2, failed: 0, scanned: 2 });
    expect(sweep).toHaveBeenCalledWith({ limit: 50 });
  });

  it('fails the scheduler attempt when object cleanup needs retry', async () => {
    const sweep = vi.fn().mockResolvedValue({ deleted: 0, failed: 1, scanned: 1 });

    await expect(
      runBrandingAssetCleanupBatch({} as LobeChatDatabase, {
        isStorageConfigured: async () => true,
        sweep,
      }),
    ).rejects.toThrow('Branding asset cleanup batch failed');
  });
});
