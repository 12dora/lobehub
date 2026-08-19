import { toast } from '@lobehub/ui/base-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAiProviderService } from './index';
import { getDetail } from './shared';

const mocks = vi.hoisted(() => ({
  applyImmediate: vi.fn(),
  confirmModal: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  getBatch: vi.fn(),
  list: vi.fn(),
  withAdminReauthRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviders: {
        applyImmediate: { mutate: mocks.applyImmediate },
        delete: { mutate: mocks.delete },
        get: { query: mocks.get },
        getBatch: { query: mocks.getBatch },
        list: { query: mocks.list },
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
  confirmModal: mocks.confirmModal,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const detailFixture = {
  baseRevision: 1,
  draft: {
    checkModel: null,
    connectionTest: null,
    config: { endpoint: 'https://keep.example' },
    description: null,
    displayName: 'P',
    enabled: true,
    fetchOnClient: false,
    id: 'uuid-p',
    logo: null,
    models: [
      {
        abilities: {},
        config: null,
        contextWindowTokens: null,
        description: null,
        displayName: 'M1',
        enabled: true,
        id: 'model-uuid',
        modelKey: 'm1',
        parameters: {},
        pricing: null,
        providerId: 'uuid-p',
        revision: 1,
        settings: {},
        sort: 0,
        status: 'published',
        type: 'chat',
      },
    ],
    providerKey: 'prov',
    revision: 1,
    secret: { configured: true, fingerprint: 'fp', updatedAt: null },
    settings: {},
    sort: 0,
    source: 'custom',
    status: 'published',
  },
  draftToken: 'b'.repeat(64),
  published: null,
};

describe('AdminAiProviderService adapter', () => {
  const service = new AdminAiProviderService();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmModal.mockReset();
    mocks.list.mockResolvedValue({
      items: [
        {
          config: {},
          displayName: 'P',
          enabled: true,
          id: 'uuid-p',
          providerKey: 'prov',
          settings: {},
          sort: 0,
          source: 'custom',
          status: 'published',
        },
      ],
      nextCursor: null,
    });
    mocks.get.mockResolvedValue(detailFixture);
    mocks.getBatch.mockResolvedValue({
      failedIds: [],
      failedProviderKeys: [],
      items: [detailFixture],
    });
    mocks.applyImmediate.mockResolvedValue({
      auditId: 'a1',
      draft: detailFixture.draft,
      revision: 2,
    });
    mocks.delete.mockResolvedValue({ deleted: true });
    mocks.withAdminReauthRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('B1 only baseURL → config.endpoint merge, no secret operation', async () => {
    await service.updateAiProviderConfig('prov', {
      keyVaults: { baseURL: 'https://new.endpoint' },
    });
    expect(mocks.get).toHaveBeenCalledWith({ providerKey: 'prov' });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ endpoint: 'https://new.endpoint' }),
        secret: undefined,
      }),
    );
  });

  it('B1 only apiKey → secret merge, keeps config.endpoint from draft', async () => {
    await service.updateAiProviderConfig('prov', {
      keyVaults: { apiKey: 'rotated-key-value' },
    });
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ endpoint: 'https://keep.example' }),
        secret: {
          operation: 'merge',
          value: { apiKey: 'rotated-key-value' },
        },
      }),
    );
  });

  it('B1 empty keyVaults save does not send secret clear/replace', async () => {
    await service.updateAiProviderConfig('prov', { keyVaults: { apiKey: '', baseURL: '' } });
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: undefined,
      }),
    );
  });

  it('explicit empty baseURL clears public config.endpoint while secret stays undefined', async () => {
    await service.updateAiProviderConfig('prov', { keyVaults: { baseURL: '' } });
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.not.objectContaining({ endpoint: expect.anything() }),
        secret: undefined,
      }),
    );
    const payload = mocks.applyImmediate.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(payload.config).not.toHaveProperty('endpoint');
    expect(payload.config).not.toEqual(
      expect.objectContaining({ endpoint: 'https://keep.example' }),
    );
  });

  it('create maps baseURL to config.endpoint and apiKey to replace secret', async () => {
    await service.createAiProvider({
      id: 'custom-1',
      keyVaults: { apiKey: 'first', baseURL: 'https://c.example' },
      name: 'Custom',
      source: 'custom',
    } as never);
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ endpoint: 'https://c.example' }),
        mode: 'create',
        secret: { operation: 'replace', value: { apiKey: 'first' } },
      }),
    );
  });

  it('getDetail resolves providerKey without list scan', async () => {
    const detail = await getDetail('prov');
    expect(detail.draft).toMatchObject({ id: 'uuid-p', providerKey: 'prov' });
    expect(mocks.get).toHaveBeenCalledWith({ providerKey: 'prov' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('getDetail resolves platform UUID via id lookup', async () => {
    await getDetail('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(mocks.get).toHaveBeenCalledWith({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  });

  it('getAiProviderRuntimeState uses getBatch instead of N get.query', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          config: {},
          displayName: 'P1',
          enabled: true,
          id: 'uuid-1',
          providerKey: 'p1',
          settings: {},
          sort: 0,
          source: 'custom',
          status: 'published',
        },
        {
          config: {},
          displayName: 'P2',
          enabled: true,
          id: 'uuid-2',
          providerKey: 'p2',
          settings: {},
          sort: 1,
          source: 'custom',
          status: 'published',
        },
      ],
      nextCursor: null,
    });
    mocks.getBatch.mockResolvedValue({
      failedIds: [],
      failedProviderKeys: [],
      items: [
        {
          ...detailFixture,
          draft: {
            ...detailFixture.draft,
            id: 'uuid-1',
            models: detailFixture.draft.models,
            providerKey: 'p1',
          },
        },
        {
          ...detailFixture,
          draft: {
            ...detailFixture.draft,
            enabled: true,
            id: 'uuid-2',
            models: [],
            providerKey: 'p2',
          },
        },
      ],
    });

    const state = await service.getAiProviderRuntimeState();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.getBatch).toHaveBeenCalledTimes(1);
    expect(mocks.getBatch).toHaveBeenCalledWith({ ids: ['uuid-1', 'uuid-2'] });
    expect(state.enabledAiProviders.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(state.enabledAiModels.some((m) => m.providerId === 'p1' && m.id === 'm1')).toBe(true);
  });

  it('getAiProviderRuntimeState rejects partial batch failures instead of empty models', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          config: {},
          displayName: 'P1',
          enabled: true,
          id: 'uuid-1',
          providerKey: 'p1',
          settings: {},
          sort: 0,
          source: 'custom',
          status: 'published',
        },
        {
          config: {},
          displayName: 'P2',
          enabled: true,
          id: 'uuid-2',
          providerKey: 'p2',
          settings: {},
          sort: 1,
          source: 'custom',
          status: 'published',
        },
      ],
      nextCursor: null,
    });
    mocks.getBatch.mockResolvedValue({
      failedIds: ['uuid-2'],
      failedProviderKeys: ['p2'],
      items: [
        {
          ...detailFixture,
          draft: {
            ...detailFixture.draft,
            id: 'uuid-1',
            models: detailFixture.draft.models,
            providerKey: 'p1',
          },
        },
      ],
    });

    await expect(service.getAiProviderRuntimeState()).rejects.toMatchObject({
      data: {
        errorData: {
          code: 'PLATFORM_AI_PROVIDER_PARTIAL_LOAD',
          details: { count: 2 },
        },
      },
      message: 'PLATFORM_AI_PROVIDER_PARTIAL_LOAD',
    });
  });

  it('updateAiProviderOrder resolves details once without list scan', async () => {
    await service.updateAiProviderOrder([
      { id: 'prov', sort: 0 },
      { id: 'prov', sort: 1 },
    ]);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith({ providerKey: 'prov' });
    expect(mocks.applyImmediate).toHaveBeenCalledTimes(2);
    expect(mocks.applyImmediate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'uuid-p', sort: 0 }),
    );
    expect(mocks.applyImmediate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'uuid-p', sort: 1 }),
    );
  });

  it.each([0, 1, 2])(
    'attempts every reorder write even when position %i rejects',
    async (failureIndex) => {
      const providerIds = ['provider-a', 'provider-b', 'provider-c'];
      mocks.get.mockImplementation(async ({ providerKey }: { providerKey: string }) => ({
        ...detailFixture,
        draft: { ...detailFixture.draft, id: `uuid-${providerKey}`, providerKey },
      }));
      mocks.applyImmediate.mockImplementation(async () =>
        mocks.applyImmediate.mock.calls.length - 1 === failureIndex
          ? Promise.reject(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'))
          : { auditId: 'a', draft: detailFixture.draft, revision: 2 },
      );

      await expect(
        service.updateAiProviderOrder(providerIds.map((id, sort) => ({ id, sort }))),
      ).rejects.toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
      // Never abort early: a half-applied order matches neither the old nor the requested one.
      expect(mocks.applyImmediate).toHaveBeenCalledTimes(3);
    },
  );

  it('reports exactly one toast when several reorder writes reject', async () => {
    mocks.get.mockImplementation(async ({ providerKey }: { providerKey: string }) => ({
      ...detailFixture,
      draft: { ...detailFixture.draft, id: `uuid-${providerKey}`, providerKey },
    }));
    mocks.applyImmediate.mockRejectedValue(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'));

    await expect(
      service.updateAiProviderOrder([
        { id: 'provider-a', sort: 0 },
        { id: 'provider-b', sort: 1 },
        { id: 'provider-c', sort: 2 },
      ]),
    ).rejects.toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(mocks.applyImmediate).toHaveBeenCalledTimes(3);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('hard-deletes every provider, published or not, under the detail CAS', async () => {
    await service.deleteAiProvider('prov');
    expect(mocks.delete).toHaveBeenCalledWith({
      expectedDraftToken: detailFixture.draftToken,
      expectedRevision: 1,
      id: 'uuid-p',
      reason: expect.any(String),
    });
  });

  it('reauth retry succeeds after one reauth', async () => {
    let calls = 0;
    mocks.withAdminReauthRetry.mockImplementation(async (fn: () => Promise<unknown>) => {
      calls += 1;
      return fn();
    });
    await service.toggleProviderEnabled('prov', false);
    expect(calls).toBe(1);
    expect(mocks.applyImmediate).toHaveBeenCalled();
  });

  it('getAiProviderById falls back to synthetic built-in only for PLATFORM_NOT_FOUND', async () => {
    mocks.get.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_NOT_FOUND' } },
    });
    const synthetic = await service.getAiProviderById('openai');
    expect(synthetic?.id).toBe('openai');
    expect(synthetic?.enabled).toBe(false);
  });

  it('getAiProviderById rethrows non-not-found failures', async () => {
    mocks.get.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
    await expect(service.getAiProviderById('openai')).rejects.toMatchObject({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
  });

  it('toggleProviderEnabled does not create when get fails with non-not-found', async () => {
    mocks.get.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
    await expect(service.toggleProviderEnabled('openai', true)).rejects.toMatchObject({
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
    });
    expect(mocks.applyImmediate).not.toHaveBeenCalled();
  });

  it('toggle-off success path does not toast error', async () => {
    mocks.applyImmediate.mockResolvedValue({
      auditId: 'a-off',
      draft: { ...detailFixture.draft, enabled: false },
      revision: 3,
    });
    await service.toggleProviderEnabled('prov', false);
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, mode: 'update' }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reauth cancel propagates and toasts', async () => {
    const { AdminReauthCancelledError } =
      await import('@/enterprise/client/features/admin/reauth/requestAdminReauth');
    mocks.withAdminReauthRetry.mockRejectedValue(new AdminReauthCancelledError());
    await expect(service.toggleProviderEnabled('prov', true)).rejects.toBeInstanceOf(
      AdminReauthCancelledError,
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it('apply failures rethrow after toast — nothing is left half-applied', async () => {
    mocks.applyImmediate.mockRejectedValue(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'));
    await expect(service.toggleProviderEnabled('prov', true)).rejects.toThrow(
      'PLATFORM_CONFIG_VALIDATION_FAILED',
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it('toggle-off with force passes force through to applyImmediate', async () => {
    await service.toggleProviderEnabled('prov', false, true);
    expect(mocks.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, force: true, mode: 'update' }),
    );
    expect(mocks.confirmModal).not.toHaveBeenCalled();
  });

  it('toggle-off PLATFORM_RESOURCE_IN_USE confirms then retries with force', async () => {
    const inUse = {
      data: {
        errorData: {
          code: 'PLATFORM_RESOURCE_IN_USE',
          details: {
            dependentCount: 2,
            dependents: [
              { label: 'Support bot', resourceId: 'agent-1', resourceType: 'agent' },
              {
                label: 'systemAgent.topic',
                resourceId: 'systemAgent.topic',
                resourceType: 'setting',
              },
            ],
          },
        },
      },
    };
    mocks.applyImmediate.mockRejectedValueOnce(inUse).mockResolvedValueOnce({
      auditId: 'a-force',
      draft: { ...detailFixture.draft, enabled: false },
      revision: 4,
    });
    mocks.confirmModal.mockImplementation(({ onOk }: { onOk?: () => void }) => {
      onOk?.();
    });

    await service.toggleProviderEnabled('prov', false);

    expect(mocks.confirmModal).toHaveBeenCalledOnce();
    expect(mocks.applyImmediate).toHaveBeenCalledTimes(2);
    expect(mocks.applyImmediate.mock.calls[1][0]).toMatchObject({
      enabled: false,
      force: true,
      mode: 'update',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toggle-off confirm cancel does not retry or toast', async () => {
    mocks.applyImmediate.mockRejectedValue({
      data: {
        errorData: {
          code: 'PLATFORM_RESOURCE_IN_USE',
          details: {
            dependentCount: 1,
            dependents: [{ label: 'Support bot', resourceId: 'agent-1', resourceType: 'agent' }],
          },
        },
      },
    });
    mocks.confirmModal.mockImplementation(({ onCancel }: { onCancel?: () => void }) => {
      onCancel?.();
    });

    await expect(service.toggleProviderEnabled('prov', false)).rejects.toMatchObject({
      data: { errorData: { code: 'PLATFORM_RESOURCE_IN_USE' } },
    });
    expect(mocks.applyImmediate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when the forced retry fails', async () => {
    mocks.applyImmediate
      .mockRejectedValueOnce({
        data: {
          errorData: {
            code: 'PLATFORM_RESOURCE_IN_USE',
            details: {
              dependentCount: 1,
              dependents: [{ label: 'Support bot', resourceId: 'agent-1', resourceType: 'agent' }],
            },
          },
        },
      })
      .mockRejectedValueOnce({
        data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
      });
    mocks.confirmModal.mockImplementation(({ onOk }: { onOk?: () => void }) => {
      onOk?.();
    });

    await expect(service.toggleProviderEnabled('prov', false)).rejects.toMatchObject({
      data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
    });
    expect(mocks.applyImmediate).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalled();
  });
});
