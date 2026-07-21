import { toast } from '@lobehub/ui/base-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAiProviderService } from './index';

const mocks = vi.hoisted(() => ({
  applyImmediate: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  publishNow: vi.fn(),
  withAdminReauthRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviders: {
        applyImmediate: { mutate: mocks.applyImmediate },
        get: { query: mocks.get },
        list: { query: mocks.list },
        publishNow: { mutate: mocks.publishNow },
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
    models: [],
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
    mocks.list.mockResolvedValue({
      items: [
        {
          displayName: 'P',
          enabled: true,
          id: 'uuid-p',
          providerKey: 'prov',
          status: 'published',
        },
      ],
      nextCursor: null,
    });
    mocks.get.mockResolvedValue(detailFixture);
    mocks.applyImmediate.mockResolvedValue({
      auditId: 'a1',
      draft: detailFixture.draft,
      published: true,
      publishError: null,
      revision: 2,
    });
    mocks.withAdminReauthRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('B1 only baseURL → config.endpoint merge, no secret operation', async () => {
    await service.updateAiProviderConfig('prov', {
      keyVaults: { baseURL: 'https://new.endpoint' },
    });
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

  it('reauth cancel propagates and toasts', async () => {
    const { AdminReauthCancelledError } =
      await import('@/enterprise/client/features/admin/reauth/requestAdminReauth');
    mocks.withAdminReauthRetry.mockRejectedValue(new AdminReauthCancelledError());
    await expect(service.toggleProviderEnabled('prov', true)).rejects.toBeInstanceOf(
      AdminReauthCancelledError,
    );
    expect(toast.error).toHaveBeenCalled();
  });

  it('publish failures rethrow after toast', async () => {
    mocks.applyImmediate.mockRejectedValue(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'));
    await expect(service.toggleProviderEnabled('prov', true)).rejects.toThrow(
      'PLATFORM_CONFIG_VALIDATION_FAILED',
    );
    expect(toast.error).toHaveBeenCalled();
  });
});
