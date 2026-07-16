import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAiCatalogService } from './adminAiCatalog';

const mocks = vi.hoisted(() => ({
  getCreateDraftContext: vi.fn(),
  getDeleteDraftContext: vi.fn(),
  getUpdateDraftContext: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiModels: {
        getCreateDraftContext: { query: mocks.getCreateDraftContext },
        getDeleteDraftContext: { query: mocks.getDeleteDraftContext },
        getUpdateDraftContext: { query: mocks.getUpdateDraftContext },
      },
    },
  },
}));

describe('admin AI catalog client service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests only the model draft context for model-only mutations', async () => {
    const context = {
      baseRevision: 2,
      draftToken: 'a'.repeat(64),
      modelIds: ['model-1', 'model-2'],
      providerId: 'provider-1',
    };
    mocks.getCreateDraftContext.mockResolvedValue(context);
    mocks.getDeleteDraftContext.mockResolvedValue(context);
    mocks.getUpdateDraftContext.mockResolvedValue(context);

    await Promise.all([
      adminAiCatalogService.getModelCreateDraftContext({ providerId: 'provider-1' }),
      adminAiCatalogService.getModelDeleteDraftContext({ providerId: 'provider-1' }),
      adminAiCatalogService.getModelUpdateDraftContext({ providerId: 'provider-1' }),
    ]);
    for (const query of [
      mocks.getCreateDraftContext,
      mocks.getDeleteDraftContext,
      mocks.getUpdateDraftContext,
    ]) {
      expect(query).toHaveBeenCalledWith({ providerId: 'provider-1' });
    }
  });
});
