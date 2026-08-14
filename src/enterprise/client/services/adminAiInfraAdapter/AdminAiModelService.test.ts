import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAiModelService } from './AdminAiModelService';

const mocks = vi.hoisted(() => ({
  applyImmediate: vi.fn(),
  get: vi.fn(),
  withAdminReauthRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiModels: {
        applyImmediate: { mutate: mocks.applyImmediate },
      },
      aiProviders: {
        get: { query: mocks.get },
      },
    },
  },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  AdminReauthBlockedError: class extends Error {
    code = 'ADMIN_REAUTH_BLOCKED';
  },
  AdminReauthCancelledError: class extends Error {
    code = 'ADMIN_REAUTH_CANCELLED';
  },
  withAdminReauthRetry: mocks.withAdminReauthRetry,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const detailFixture = {
  baseRevision: 2,
  draft: {
    checkModel: null,
    connectionTest: null,
    config: {},
    description: null,
    displayName: 'OpenAI',
    enabled: true,
    fetchOnClient: false,
    id: 'provider-uuid',
    logo: null,
    models: [
      {
        abilities: {},
        config: null,
        contextWindowTokens: null,
        description: null,
        displayName: 'Model One',
        enabled: true,
        id: 'model-uuid-1',
        modelKey: 'm1',
        parameters: {},
        pricing: null,
        providerId: 'provider-uuid',
        revision: 7,
        settings: {},
        sort: 0,
        status: 'published',
        type: 'chat',
      },
      {
        abilities: {},
        config: null,
        contextWindowTokens: null,
        description: null,
        displayName: 'Model Two',
        enabled: false,
        id: 'model-uuid-2',
        modelKey: 'm2',
        parameters: {},
        pricing: null,
        providerId: 'provider-uuid',
        revision: 3,
        settings: {},
        sort: 1,
        status: 'published',
        type: 'chat',
      },
    ],
    providerKey: 'openai',
    revision: 2,
    secret: { configured: true, fingerprint: 'fp', updatedAt: null },
    settings: {},
    sort: 0,
    source: 'builtin',
    status: 'published',
  },
  draftToken: 'd'.repeat(64),
  published: null,
};

describe('AdminAiModelService CAS and apply contract', () => {
  const service = new AdminAiModelService();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(detailFixture);
    mocks.applyImmediate.mockResolvedValue({
      auditId: 'a1',
      draft: detailFixture.draft,
      revision: 3,
    });
    mocks.withAdminReauthRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('maps providerKey + modelKey to platform UUIDs and sends both CAS fields on update', async () => {
    await service.updateAiModel('m1', 'openai', { displayName: 'Renamed' });
    expect(mocks.get).toHaveBeenCalledWith({ providerKey: 'openai' });
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Renamed',
        expectedDraftToken: detailFixture.draftToken,
        expectedRevision: 7,
        id: 'model-uuid-1',
        operation: 'update',
        providerId: 'provider-uuid',
      }),
    );
  });

  it('toggleModelEnabled sends draft token and model revision CAS', async () => {
    await service.toggleModelEnabled({ enabled: false, id: 'm1', providerId: 'openai' });
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        expectedDraftToken: detailFixture.draftToken,
        expectedRevision: 7,
        id: 'model-uuid-1',
        operation: 'update',
        providerId: 'provider-uuid',
      }),
    );
  });

  it('reorder includes every model exactly once', async () => {
    await service.updateAiModelOrder('openai', [{ id: 'm2', sort: 0 }]);
    const payload = mocks.applyImmediate.mock.calls[0]![0] as {
      items: { id: string; sort: number }[];
      operation: string;
    };
    expect(payload.operation).toBe('reorder');
    expect(payload.items).toHaveLength(2);
    const ids = payload.items.map((i) => i.id).sort();
    expect(ids).toEqual(['model-uuid-1', 'model-uuid-2']);
  });

  it('batchToggle rejects unknown model keys', async () => {
    await expect(service.batchToggleAiModels('openai', ['missing-key'], true)).rejects.toThrow(
      /Model not found: missing-key/,
    );
    expect(mocks.applyImmediate).not.toHaveBeenCalled();
  });

  it('delete distinguishes not-found from other failures', async () => {
    await expect(service.deleteAiModel({ id: 'nope', providerId: 'openai' })).rejects.toThrow(
      /Model not found: nope/,
    );

    mocks.get.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
    await expect(service.deleteAiModel({ id: 'm1', providerId: 'openai' })).rejects.toMatchObject({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
  });

  it('surfaces a rejected apply instead of reporting a silent draft', async () => {
    mocks.applyImmediate.mockRejectedValue(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'));
    await expect(
      service.toggleModelEnabled({ enabled: true, id: 'm1', providerId: 'openai' }),
    ).rejects.toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
  });

  it('createAiModel maps modelKey onto the immediate apply payload', async () => {
    await service.createAiModel({
      id: 'new-model',
      providerId: 'openai',
      type: 'chat',
    } as never);
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftToken: detailFixture.draftToken,
        modelKey: 'new-model',
        operation: 'create',
        providerId: 'provider-uuid',
      }),
    );
  });

  it('normalizes the Unlimited sentinel to null when creating a model', async () => {
    await service.createAiModel({
      contextWindowTokens: 0,
      id: 'unlimited-model',
      providerId: 'openai',
      type: 'chat',
    } as never);

    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: null }),
    );
  });

  it.each([
    ['Unlimited sentinel', 0, null],
    ['explicit clear', null, null],
    ['positive limit', 32_768, 32_768],
    ['omitted limit', undefined, undefined],
  ])('preserves the admin contract for %s', async (_case, input, expected) => {
    await service.updateAiModel('m1', 'openai', {
      contextWindowTokens: input,
    } as never);

    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: expected }),
    );
  });

  it('normalizes Unlimited in a batch update', async () => {
    await service.batchUpdateAiModels('openai', [
      {
        ...detailFixture.draft.models[0],
        contextWindowTokens: 0,
        id: 'm1',
        providerId: 'openai',
        source: 'custom',
      },
    ] as never);

    const payload = mocks.applyImmediate.mock.calls[0]![0] as {
      models: { contextWindowTokens: number | null }[];
    };
    expect(payload.models[0]?.contextWindowTokens).toBeNull();
  });

  it('getAiProviderModelList merges builtin+db and honors enabled/pagination filters', async () => {
    // Custom provider with no builtin list — DB models only.
    mocks.get.mockResolvedValue({
      ...detailFixture,
      draft: {
        ...detailFixture.draft,
        models: [
          {
            ...detailFixture.draft.models[0],
            enabled: false,
            id: 'off-uuid',
            modelKey: 'off-model',
          },
          {
            ...detailFixture.draft.models[1],
            enabled: true,
            id: 'on-uuid',
            modelKey: 'on-model',
          },
        ],
        providerKey: 'custom-only',
      },
    });

    const disabled = await service.getAiProviderModelList('custom-only', {
      enabled: false,
      limit: 10,
      offset: 0,
    });
    expect(disabled.every((m) => m.enabled === false)).toBe(true);
    expect(disabled.some((m) => m.id === 'off-model')).toBe(true);
    expect(disabled.some((m) => m.id === 'on-model')).toBe(false);
  });
});
