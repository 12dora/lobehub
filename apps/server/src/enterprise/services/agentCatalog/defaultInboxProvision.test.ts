import { DEFAULT_AGENT_CONFIG, DEFAULT_INBOX_AVATAR, DEFAULT_INBOX_TITLE } from '@lobechat/const';
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { buildDefaultInboxSeed } from './defaultInboxProvision';
import { PlatformAgentDependencyValidationError, PlatformAgentInvalidInputError } from './errors';

const getProviderByKey = vi.fn();
const getLatestPublishedProviderRevision = vi.fn();

vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: class {
    getLatestPublishedProviderRevision = getLatestPublishedProviderRevision;
    getProviderByKey = getProviderByKey;
  },
}));

const db = {} as LobeChatDatabase;
const checksum = 'c'.repeat(64);

describe('buildDefaultInboxSeed', () => {
  it('pins the merged legacy model onto a published provider revision', async () => {
    getProviderByKey.mockResolvedValue({
      id: 'provider-id',
      providerKey: DEFAULT_AGENT_CONFIG.provider,
      status: 'published',
    });
    getLatestPublishedProviderRevision.mockResolvedValue({
      checksum,
      payload: {
        models: [{ enabled: true, modelKey: DEFAULT_AGENT_CONFIG.model, type: 'chat' }],
        provider: { enabled: true, providerKey: DEFAULT_AGENT_CONFIG.provider },
      },
      revision: 4,
      status: 'published',
    });

    const seed = await buildDefaultInboxSeed(db, {
      getServerDefaultAgentConfig: () => ({
        openingMessage: 'Hello',
        params: { temperature: 0.2 },
        systemRole: 'Be helpful.',
      }),
      resolveBranding: async () => ({ defaultAgentDisplayName: 'Acme AI' }) as never,
    });

    expect(seed.config).toMatchObject({
      avatar: DEFAULT_INBOX_AVATAR,
      displayName: 'Acme AI',
      modelParameters: expect.objectContaining({ temperature: 0.2 }),
      openingMessage: 'Hello',
      systemRole: 'Be helpful.',
    });
    expect(seed.dependencySnapshot.model).toEqual({
      modelKey: DEFAULT_AGENT_CONFIG.model,
      providerChecksum: checksum,
      providerKey: DEFAULT_AGENT_CONFIG.provider,
      providerRevision: 4,
    });
  });

  it('falls back to the builtin inbox title when branding is empty', async () => {
    getProviderByKey.mockResolvedValue({
      id: 'provider-id',
      providerKey: DEFAULT_AGENT_CONFIG.provider,
      status: 'published',
    });
    getLatestPublishedProviderRevision.mockResolvedValue({
      checksum,
      payload: {
        models: [{ enabled: true, modelKey: DEFAULT_AGENT_CONFIG.model, type: 'chat' }],
        provider: { enabled: true, providerKey: DEFAULT_AGENT_CONFIG.provider },
      },
      revision: 1,
      status: 'published',
    });

    const seed = await buildDefaultInboxSeed(db, {
      getServerDefaultAgentConfig: () => ({}),
      resolveBranding: async () => ({ defaultAgentDisplayName: null }) as never,
    });

    expect(seed.config.displayName).toBe(DEFAULT_INBOX_TITLE);
    expect(seed.config.avatar).toBe(DEFAULT_INBOX_AVATAR);
    expect(seed.config.systemRole).toBe('');
  });

  it('keeps an empty legacy systemRole empty instead of substituting a canned prompt', async () => {
    getProviderByKey.mockResolvedValue({
      id: 'provider-id',
      providerKey: DEFAULT_AGENT_CONFIG.provider,
      status: 'published',
    });
    getLatestPublishedProviderRevision.mockResolvedValue({
      checksum,
      payload: {
        models: [{ enabled: true, modelKey: DEFAULT_AGENT_CONFIG.model, type: 'chat' }],
        provider: { enabled: true, providerKey: DEFAULT_AGENT_CONFIG.provider },
      },
      revision: 1,
      status: 'published',
    });

    const seed = await buildDefaultInboxSeed(db, {
      getServerDefaultAgentConfig: () => ({ systemRole: '' }),
      resolveBranding: async () => ({ defaultAgentDisplayName: null }) as never,
    });

    expect(seed.config.systemRole).toBe('');
  });

  it('rejects an out-of-range env model parameter before persisting a version', async () => {
    getProviderByKey.mockResolvedValue({
      id: 'provider-id',
      providerKey: DEFAULT_AGENT_CONFIG.provider,
      status: 'published',
    });
    getLatestPublishedProviderRevision.mockResolvedValue({
      checksum,
      payload: {
        models: [{ enabled: true, modelKey: DEFAULT_AGENT_CONFIG.model, type: 'chat' }],
        provider: { enabled: true, providerKey: DEFAULT_AGENT_CONFIG.provider },
      },
      revision: 1,
      status: 'published',
    });

    await expect(
      buildDefaultInboxSeed(db, {
        getServerDefaultAgentConfig: () => ({ params: { temperature: 99 } }),
        resolveBranding: async () => ({ defaultAgentDisplayName: null }) as never,
      }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_INVALID_INPUT',
      message: expect.stringMatching(/platformAgentVersionConfigSchema/),
    });
    await expect(
      buildDefaultInboxSeed(db, {
        getServerDefaultAgentConfig: () => ({ params: { temperature: 99 } }),
        resolveBranding: async () => ({ defaultAgentDisplayName: null }) as never,
      }),
    ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
  });

  it('fails closed when the legacy model is not a published chat model', async () => {
    getProviderByKey.mockResolvedValue(undefined);
    await expect(
      buildDefaultInboxSeed(db, {
        getServerDefaultAgentConfig: () => ({}),
        resolveBranding: async () => ({ defaultAgentDisplayName: null }) as never,
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDependencyValidationError);
  });
});
