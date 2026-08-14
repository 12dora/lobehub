import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAiCatalogService } from './adminAiCatalog';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  listRevisions: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviders: {
        get: { query: mocks.get },
        list: { query: mocks.list },
        listRevisions: { query: mocks.listRevisions },
      },
    },
  },
}));

describe('admin AI catalog client service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads provider detail by the caller-supplied lookup', async () => {
    mocks.get.mockResolvedValue({ baseRevision: 2 });

    await expect(adminAiCatalogService.getProvider({ id: 'provider-1' })).resolves.toMatchObject({
      baseRevision: 2,
    });
    expect(mocks.get).toHaveBeenCalledWith({ id: 'provider-1' });
  });

  it('passes list filters straight through (one server page per query)', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    const input = { limit: 100, query: 'open', status: 'published' as const };

    await adminAiCatalogService.listProviders(input);
    expect(mocks.list).toHaveBeenCalledWith(input);
  });

  it('reads revision history for the exact published checksum join', async () => {
    mocks.listRevisions.mockResolvedValue({ items: [], nextCursor: null });
    const input = { beforeRevision: 4, id: 'provider-1', limit: 100 };

    await adminAiCatalogService.listProviderRevisions(input);
    expect(mocks.listRevisions).toHaveBeenCalledWith(input);
  });
});
