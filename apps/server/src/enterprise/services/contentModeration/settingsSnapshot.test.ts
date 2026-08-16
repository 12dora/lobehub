import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { getModerationSnapshot, resetModerationSnapshotForTest } from './settingsSnapshot';

const get = vi.fn();

vi.mock('@/database/models/platform/contentModerationSettings', () => ({
  PlatformContentModerationSettingsModel: class {
    get = get;
  },
}));

vi.mock('@/server/enterprise/runtimeConfig', () => ({
  DomainConfigCache: class {
    constructor(private readonly options: { load: () => Promise<unknown> }) {}
    get = () => this.options.load();
    invalidate = () => undefined;
  },
  invalidateDomainConfigCacheNamespace: () => undefined,
}));

vi.mock('@/server/enterprise/services/platformConfigInvalidation', () => ({
  getPlatformConfigScopeVersion: async () => '1',
}));

afterEach(() => {
  get.mockReset();
  resetModerationSnapshotForTest();
});

describe('getModerationSnapshot', () => {
  it('falls back to default (mode off) when load fails and there is no LKG', async () => {
    get.mockRejectedValueOnce(new Error('db down'));
    const snapshot = await getModerationSnapshot({} as never);
    expect(snapshot.config.mode).toBe('off');
    expect(snapshot.revision).toBe(0);
  });

  it('keeps serving the last-known-good snapshot after a later load failure', async () => {
    const db = {} as never;
    get.mockResolvedValueOnce({
      config: { ...createDefaultContentModerationConfig(), mode: 'enforce' },
      revision: 4,
      updatedAt: new Date('2026-01-01'),
    });
    const first = await getModerationSnapshot(db);
    expect(first.config.mode).toBe('enforce');
    expect(first.revision).toBe(4);

    get.mockRejectedValueOnce(new Error('db down'));
    const second = await getModerationSnapshot(db);
    expect(second.config.mode).toBe('enforce');
    expect(second.revision).toBe(4);
  });
});
