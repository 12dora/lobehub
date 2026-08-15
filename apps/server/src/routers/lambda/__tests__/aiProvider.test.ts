// @vitest-environment node
import type * as BusinessConst from '@lobechat/business-const';
import { OFFICIAL_PROVIDER_DISABLE_ERROR } from '@lobechat/business-const';
import { RequestTrigger } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiProviderModel } from '@/database/models/aiProvider';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';
import {
  AiCatalogExecutionResolver,
  clearAiCatalogRuntimeCache,
} from '@/server/enterprise/services/aiCatalog';
import type * as AiCatalogEnforcement from '@/server/enterprise/services/aiCatalog/enforcement';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { type AiProviderDetailItem, type AiProviderRuntimeState } from '@/types/aiProvider';

import { aiProviderRouter } from '../aiProvider';

vi.mock('@/server/globalConfig');
vi.mock('@/server/modules/KeyVaultsEncrypt');
vi.mock('@/database/repositories/aiInfra');
vi.mock('@/database/models/aiProvider');
vi.mock('@/database/models/user');
const catalogRepositoryMocks = vi.hoisted(() => ({
  getProviderSecretVersion: vi.fn(),
}));
const catalogAuthorityMocks = vi.hoisted(() => ({
  loadCurrentAiCatalogSnapshot: vi.fn(),
}));
// The published 平台托管 policy — not the feature flag — authorizes the platform takeover.
const enforcementMocks = vi.hoisted(() => ({ takeover: false }));
vi.mock('@/server/enterprise/services/aiCatalog/enforcement', async (importOriginal) => ({
  ...(await importOriginal<typeof AiCatalogEnforcement>()),
  isPlatformAiTakeoverActive: vi.fn(async () => enforcementMocks.takeover),
}));
vi.mock('@/database/repositories/platformAiCatalog', () => ({
  PlatformAiCatalogRepository: vi.fn(() => catalogRepositoryMocks),
}));
// Production path uses catalog pointer authority (not listLatestPublished*).
vi.mock('@/server/enterprise/services/platformInstance/catalogAuthority', () => ({
  loadCurrentAiCatalogSnapshot: (...args: unknown[]) =>
    catalogAuthorityMocks.loadCurrentAiCatalogSnapshot(...args),
}));
vi.mock('@/server/modules/ModelRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  initModelRuntimeFromDB: vi.fn(),
}));
vi.mock('@lobechat/business-const', async () => {
  const actual = await vi.importActual<typeof BusinessConst>('@lobechat/business-const');

  return {
    ...actual,
    BRANDING_PROVIDER: 'lobehub',
    ENABLE_BUSINESS_FEATURES: true,
    isOfficialProvider: (id: string) => id === 'lobehub',
  };
});

describe('aiProviderRouter', () => {
  const mockUserId = 'test-user-id';
  const mockProviderId = 'test-provider-id';
  const mockEncrypt = vi.fn();
  const mockDecrypt = vi.fn();

  const mockGateKeeper = {
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  };

  const mockProviderDetail: AiProviderDetailItem = {
    id: mockProviderId,
    name: 'Test Provider',
    enabled: true,
    description: 'Test Description',
    source: 'custom',
    settings: {},
  };

  const mockRuntimeState: AiProviderRuntimeState = {
    enabledAiModels: [],
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    enabledVideoAiProviders: [],
    runtimeConfig: {},
  };

  beforeEach(() => {
    delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    enforcementMocks.takeover = false;
    clearAiCatalogRuntimeCache();
    vi.clearAllMocks();

    vi.mocked(getServerGlobalConfig).mockReturnValue({
      aiProvider: {},
    } as any);

    vi.mocked(KeyVaultsGateKeeper.initWithEnvKey).mockResolvedValue(mockGateKeeper as any);
    // The personal hide-overlay is gone, but the repo is auto-mocked and some cases still seed
    // personal `ai_models` rows to prove they no longer affect the runtime state.
    vi.mocked(AiInfraRepos).prototype.aiModelModel = {
      getAllModels: vi.fn().mockResolvedValue([]),
    } as never;
  });

  const createMockContext = () => ({
    userId: mockUserId,
  });

  describe('checkProviderConnectivity', () => {
    it('should pass api trigger metadata to the runtime connectivity check', async () => {
      const mockChat = vi.fn().mockResolvedValue({ ok: true });
      const mockGetDetail = vi
        .fn()
        .mockResolvedValue({ ...mockProviderDetail, checkModel: 'gpt-4' });

      vi.mocked(AiInfraRepos).prototype.getAiProviderDetail = mockGetDetail;
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat: mockChat } as any);

      const caller = aiProviderRouter.createCaller(createMockContext());
      const result = await caller.checkProviderConnectivity({ id: mockProviderId });

      expect(result).toEqual({ model: 'gpt-4', ok: true });
      expect(mockChat).toHaveBeenCalledWith(
        {
          messages: [{ content: 'Hi', role: 'user' }],
          model: 'gpt-4',
          stream: false,
          temperature: 0,
        },
        {
          metadata: { trigger: RequestTrigger.Api },
        },
      );
    });
  });

  describe('createAiProvider', () => {
    it('should create a new AI provider', async () => {
      const mockCreate = vi.fn().mockResolvedValue({ id: mockProviderId });
      vi.mocked(AiProviderModel).prototype.create = mockCreate;

      const caller = aiProviderRouter.createCaller(createMockContext());
      const result = await caller.createAiProvider({
        id: mockProviderId,
        name: 'Test Provider',
        source: 'custom',
      });

      expect(result).toBe(mockProviderId);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockProviderId,
          name: 'Test Provider',
        }),
        mockGateKeeper.encrypt,
      );
    });
  });

  describe('getAiProviderById', () => {
    it('should get AI provider by id', async () => {
      const mockGetDetail = vi.fn().mockResolvedValue(mockProviderDetail);
      vi.mocked(AiInfraRepos).prototype.getAiProviderDetail = mockGetDetail;

      const caller = aiProviderRouter.createCaller(createMockContext());
      const result = await caller.getAiProviderById({ id: mockProviderId });

      expect(result).toEqual(mockProviderDetail);
      expect(mockGetDetail).toHaveBeenCalledWith(
        mockProviderId,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );
    });
  });

  describe('getAiProviderList', () => {
    it('should get AI provider list', async () => {
      const mockList = [mockProviderDetail];
      const mockGetList = vi.fn().mockResolvedValue(mockList);
      vi.mocked(AiInfraRepos).prototype.getAiProviderList = mockGetList;

      const caller = aiProviderRouter.createCaller(createMockContext());
      const result = await caller.getAiProviderList();

      expect(result).toEqual(mockList);
      expect(mockGetList).toHaveBeenCalled();
    });
  });

  describe('getAiProviderRuntimeState', () => {
    it('should get AI provider runtime state', async () => {
      const mockGetState = vi.fn().mockResolvedValue(mockRuntimeState);
      vi.mocked(AiInfraRepos).prototype.getAiProviderRuntimeState = mockGetState;

      const caller = aiProviderRouter.createCaller(createMockContext());
      const result = await caller.getAiProviderRuntimeState({});

      expect(result).toEqual(mockRuntimeState);
      expect(mockGetState).toHaveBeenCalledWith(KeyVaultsGateKeeper.getUserKeyVaults);
    });

    it('returns the caller upstream state byte-identical while the platform has not taken over', async () => {
      // Flag on + a published catalog is NOT authorization: without 平台托管 the response must
      // be exactly what the flag-off path returns, including decrypted runtimeConfig keyVaults.
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      enforcementMocks.takeover = false;
      catalogAuthorityMocks.loadCurrentAiCatalogSnapshot.mockRejectedValue(
        new Error('catalog must not be read without takeover'),
      );
      const upstream = {
        ...mockRuntimeState,
        enabledAiModels: [
          { abilities: {}, enabled: true, id: 'gpt-5.5', providerId: 'chatgpt', type: 'chat' },
        ],
        enabledAiProviders: [{ id: 'chatgpt', name: 'ChatGPT', source: 'builtin' as const }],
        enabledChatAiProviders: [{ id: 'chatgpt', name: 'ChatGPT', source: 'builtin' as const }],
        runtimeConfig: {
          chatgpt: { config: {}, keyVaults: { apiKey: 'user-own-key' }, settings: {} },
        },
      };
      const mockGetState = vi.fn().mockResolvedValue(upstream);
      vi.mocked(AiInfraRepos).prototype.getAiProviderRuntimeState = mockGetState;

      const state = await aiProviderRouter
        .createCaller(createMockContext())
        .getAiProviderRuntimeState({});

      expect(state).toBe(upstream);
      expect(mockGetState).toHaveBeenCalledWith(KeyVaultsGateKeeper.getUserKeyVaults);
    });

    it('unions the caller BYOK providers under takeover; published providers win on collision', async () => {
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      enforcementMocks.takeover = true;
      catalogAuthorityMocks.loadCurrentAiCatalogSnapshot.mockResolvedValue({
        revisions: [
          {
            checksum: 'a'.repeat(64),
            payload: {
              models: [
                { abilities: {}, enabled: true, modelKey: 'published-1', sort: 0, type: 'chat' },
                { abilities: {}, enabled: true, modelKey: 'published-2', sort: 1, type: 'chat' },
              ],
              provider: {
                config: {},
                displayName: 'Managed Provider',
                enabled: true,
                providerKey: 'managed-provider',
                sort: 0,
                source: 'custom',
              },
            },
            resourceId: 'provider-row-id',
            revision: 1,
            secretFingerprint: null,
          },
        ],
        token: { kind: 'immutable_id', value: 'c'.repeat(64) },
      });
      // 300 BYOK models on one provider: the old shadow builder capped at 20 providers /
      // 200 models per provider; the real response must never truncate the caller's own state.
      const byokModels = Array.from({ length: 300 }, (_, index) => ({
        abilities: {},
        enabled: true,
        id: `byok-${index}`,
        providerId: 'byok-provider',
        type: 'chat',
      }));
      vi.mocked(AiInfraRepos).prototype.getAiProviderRuntimeState = vi.fn().mockResolvedValue({
        ...mockRuntimeState,
        enabledAiModels: [
          ...byokModels,
          // Same id as the published provider ⇒ must lose entirely.
          {
            abilities: {},
            enabled: true,
            id: 'user-shadow',
            providerId: 'managed-provider',
            type: 'chat',
          },
        ],
        enabledAiProviders: [
          { id: 'byok-provider', name: 'BYOK', source: 'custom' as const },
          { id: 'managed-provider', name: 'User Copy', source: 'custom' as const },
        ],
        enabledChatAiProviders: [
          { id: 'byok-provider', name: 'BYOK', source: 'custom' as const },
          { id: 'managed-provider', name: 'User Copy', source: 'custom' as const },
        ],
        runtimeConfig: {
          'byok-provider': { config: {}, keyVaults: { apiKey: 'byok-key' }, settings: {} },
          'managed-provider': {
            config: {},
            keyVaults: { apiKey: 'user-secret-must-not-win' },
            settings: {},
          },
        },
      });

      clearAiCatalogRuntimeCache();
      const state = await aiProviderRouter
        .createCaller(createMockContext())
        .getAiProviderRuntimeState({});

      expect(state.enabledAiProviders.map((provider) => provider.id)).toEqual([
        'managed-provider',
        'byok-provider',
      ]);
      expect(
        state.enabledAiModels
          .filter((model) => model.providerId === 'managed-provider')
          .map((model) => model.id),
      ).toEqual(['published-1', 'published-2']);
      expect(
        state.enabledAiModels.filter((model) => model.providerId === 'byok-provider'),
      ).toHaveLength(300);
      expect(state.runtimeConfig['managed-provider']?.keyVaults).toEqual({});
      expect(state.runtimeConfig['byok-provider']?.keyVaults).toEqual({ apiKey: 'byok-key' });
      expect(JSON.stringify(state)).not.toContain('user-secret-must-not-win');
      expect(state.enabledChatAiProviders.map((provider) => provider.id)).toEqual([
        'managed-provider',
        'byok-provider',
      ]);
    });

    it('keeps the picker non-empty for the demo state: 4 published models + 4 personal disabled rows', async () => {
      // Regression for the reported empty chat picker. The personal hide overlay used to
      // subtract these four `ai_models` rows (written BEFORE the admin published the same four
      // models) and collapse `enabledChatAiProviders` to []. The overlay is gone.
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      enforcementMocks.takeover = true;
      const publishedKeys = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'];
      catalogAuthorityMocks.loadCurrentAiCatalogSnapshot.mockResolvedValue({
        revisions: [
          {
            checksum: 'a'.repeat(64),
            payload: {
              models: publishedKeys.map((modelKey, sort) => ({
                abilities: {},
                enabled: true,
                modelKey,
                sort,
                type: 'chat',
              })),
              provider: {
                config: {},
                displayName: 'ChatGPT',
                enabled: true,
                providerKey: 'chatgpt',
                sort: 0,
                source: 'builtin',
              },
            },
            resourceId: 'provider-row-id',
            revision: 1,
            secretFingerprint: null,
          },
        ],
        token: { kind: 'immutable_id', value: 'd'.repeat(64) },
      });
      vi.mocked(AiInfraRepos).prototype.getAiProviderRuntimeState = vi
        .fn()
        .mockResolvedValue(mockRuntimeState);
      vi.mocked(AiInfraRepos).prototype.aiModelModel = {
        getAllModels: vi.fn().mockResolvedValue(
          publishedKeys.map((id) => ({
            enabled: false,
            id,
            providerId: 'chatgpt',
            type: 'chat',
          })),
        ),
      } as never;

      clearAiCatalogRuntimeCache();
      const state = await aiProviderRouter
        .createCaller(createMockContext())
        .getAiProviderRuntimeState({});

      expect(state.enabledAiModels.map((model) => model.id)).toEqual(publishedKeys);
      expect(state.enabledChatAiProviders.map((provider) => provider.id)).toEqual(['chatgpt']);
    });

    it('never exposes execution secret material in either caller/execution order', async () => {
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      enforcementMocks.takeover = true;
      const plaintext = 'platform-caller-secret-not-for-client';
      const privateEndpoint = 'https://private-caller-endpoint.example.test/v1';
      const fingerprint = 'sha256:caller-secret-fingerprint';
      const keyProvider: KeyProvider = {
        getKek: async () => ({ key: new Uint8Array(32).fill(17), keyId: 'caller-test' }),
        providerId: 'test',
      };
      const secrets = new PlatformSecretService({ keyProvider });
      const ciphertext = await secrets.encrypt(JSON.stringify({ apiKey: plaintext }));
      const revision = {
        checksum: 'a'.repeat(64),
        payload: {
          models: [
            {
              abilities: {},
              enabled: true,
              modelKey: 'managed-model',
              providerId: 'provider-row-id',
              sort: 0,
              type: 'chat',
            },
          ],
          provider: {
            config: { endpoint: privateEndpoint },
            displayName: 'Managed Provider',
            enabled: true,
            providerKey: 'managed-provider',
            sort: 0,
            source: 'custom',
          },
        },
        resourceId: 'provider-row-id',
        revision: 1,
        secretFingerprint: fingerprint,
      };
      catalogAuthorityMocks.loadCurrentAiCatalogSnapshot.mockResolvedValue({
        revisions: [revision],
        token: { kind: 'immutable_id', value: 'b'.repeat(64) },
      });
      catalogRepositoryMocks.getProviderSecretVersion.mockResolvedValue({
        ciphertext,
        fingerprint,
      });
      const mockGetState = vi.fn().mockResolvedValue({
        ...mockRuntimeState,
        runtimeConfig: {
          'managed-provider': {
            config: { endpoint: 'https://user-endpoint.example.test' },
            keyVaults: { apiKey: 'user-secret-must-not-win' },
            settings: {},
          },
        },
      });
      vi.mocked(AiInfraRepos).prototype.getAiProviderRuntimeState = mockGetState;
      vi.mocked(AiInfraRepos).prototype.getAiProviderList = vi.fn().mockResolvedValue([]);
      vi.mocked(AiInfraRepos).prototype.getAiProviderModelList = vi.fn().mockResolvedValue([]);
      const caller = aiProviderRouter.createCaller(createMockContext());
      const execution = new AiCatalogExecutionResolver({} as never, secrets);

      const serverFirst = await execution.resolveProviderExecutionConfig('managed-provider');
      expect(serverFirst.keyVaults).toEqual({ apiKey: plaintext, baseURL: privateEndpoint });
      const clientAfterServer = await caller.getAiProviderRuntimeState({});
      const clientAfterServerJson = JSON.stringify(clientAfterServer);

      clearAiCatalogRuntimeCache();
      const clientFirst = await caller.getAiProviderRuntimeState({});
      const serverAfterClient = await execution.resolveProviderExecutionConfig('managed-provider');
      expect(serverAfterClient.keyVaults.apiKey).toBe(plaintext);
      const clientFirstJson = JSON.stringify(clientFirst);

      for (const response of [clientAfterServerJson, clientFirstJson]) {
        expect(response).not.toContain(plaintext);
        expect(response).not.toContain(ciphertext);
        expect(response).not.toContain(privateEndpoint);
        expect(response).not.toContain(fingerprint);
        expect(response).not.toContain('user-secret-must-not-win');
        expect(response).not.toContain('user-endpoint.example.test');
      }
      // The caller state is now built from the caller's REAL upstream state (uncapped, with
      // decrypted vaults) — the platform half still wins for what it publishes, and the
      // user's same-id config never leaks.
      expect(mockGetState).toHaveBeenCalledWith(KeyVaultsGateKeeper.getUserKeyVaults);
      expect(catalogAuthorityMocks.loadCurrentAiCatalogSnapshot).toHaveBeenCalled();
    });
  });

  describe('removeAiProvider', () => {
    it('should remove AI provider', async () => {
      const mockDelete = vi.fn();
      vi.mocked(AiProviderModel).prototype.delete = mockDelete;

      const caller = aiProviderRouter.createCaller(createMockContext());
      await caller.removeAiProvider({ id: mockProviderId });

      expect(mockDelete).toHaveBeenCalledWith(mockProviderId);
    });
  });

  describe('toggleProviderEnabled', () => {
    it('should toggle provider enabled state', async () => {
      const mockToggle = vi.fn();
      vi.mocked(AiProviderModel).prototype.toggleProviderEnabled = mockToggle;

      const caller = aiProviderRouter.createCaller(createMockContext());
      await caller.toggleProviderEnabled({
        id: mockProviderId,
        enabled: true,
      });

      expect(mockToggle).toHaveBeenCalledWith(mockProviderId, true);
    });

    it('should reject disabling the official provider', async () => {
      const mockToggle = vi.fn();
      vi.mocked(AiProviderModel).prototype.toggleProviderEnabled = mockToggle;

      const caller = aiProviderRouter.createCaller(createMockContext());

      await expect(
        caller.toggleProviderEnabled({
          enabled: false,
          id: 'lobehub',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: OFFICIAL_PROVIDER_DISABLE_ERROR,
      });

      expect(mockToggle).not.toHaveBeenCalled();
    });
  });

  describe('updateAiProvider', () => {
    it('should update AI provider', async () => {
      const mockUpdate = vi.fn();
      vi.mocked(AiProviderModel).prototype.update = mockUpdate;

      const caller = aiProviderRouter.createCaller(createMockContext());
      await caller.updateAiProvider({
        id: mockProviderId,
        value: { name: 'Updated Provider' },
      });

      expect(mockUpdate).toHaveBeenCalledWith(mockProviderId, {
        name: 'Updated Provider',
      });
    });
  });

  describe('updateAiProviderConfig', () => {
    it('should update AI provider config', async () => {
      const mockUpdateConfig = vi.fn();
      vi.mocked(AiProviderModel).prototype.updateConfig = mockUpdateConfig;

      const caller = aiProviderRouter.createCaller(createMockContext());
      await caller.updateAiProviderConfig({
        id: mockProviderId,
        value: { checkModel: 'gpt-4' },
      });

      expect(mockUpdateConfig).toHaveBeenCalledWith(
        mockProviderId,
        { checkModel: 'gpt-4' },
        mockGateKeeper.encrypt,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );
    });
  });

  describe('updateAiProviderOrder', () => {
    it('should update AI provider order', async () => {
      const mockUpdateOrder = vi.fn();
      vi.mocked(AiProviderModel).prototype.updateOrder = mockUpdateOrder;

      const sortMap = [{ id: mockProviderId, sort: 1 }];
      const caller = aiProviderRouter.createCaller(createMockContext());
      await caller.updateAiProviderOrder({ sortMap });

      expect(mockUpdateOrder).toHaveBeenCalledWith(sortMap);
    });
  });
});
