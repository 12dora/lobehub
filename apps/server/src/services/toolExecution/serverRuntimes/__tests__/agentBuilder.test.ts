import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentBuilderRuntime } from '../agentBuilder';

const {
  mockCreatePlugin,
  mockFindById,
  mockGetAgentConfigById,
  mockGetAiProviderList,
  mockGetAiProviderModelList,
  mockGetAiProviderRuntimeState,
  mockResolveAiCatalogRuntimeState,
  mockUpdateConfig,
} = vi.hoisted(() => ({
  mockCreatePlugin: vi.fn(),
  mockFindById: vi.fn(),
  mockGetAgentConfigById: vi.fn(),
  mockGetAiProviderList: vi.fn(),
  mockGetAiProviderModelList: vi.fn(),
  mockGetAiProviderRuntimeState: vi.fn(),
  mockResolveAiCatalogRuntimeState: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn(() => ({
    getAgentConfigById: mockGetAgentConfigById,
    updateConfig: mockUpdateConfig,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(() => ({
    create: mockCreatePlugin,
    findById: mockFindById,
  })),
}));

vi.mock('@/database/repositories/aiInfra', () => ({
  AiInfraRepos: vi.fn(() => ({
    getAiProviderList: mockGetAiProviderList,
    getAiProviderModelList: mockGetAiProviderModelList,
    getAiProviderRuntimeState: mockGetAiProviderRuntimeState,
  })),
}));

vi.mock('@/server/enterprise/services/aiCatalog', () => ({
  getEmptyAiProviderRuntimeState: () => ({
    enabledAiModels: [],
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    enabledVideoAiProviders: [],
    runtimeConfig: {},
  }),
  resolveAiCatalogRuntimeState: mockResolveAiCatalogRuntimeState,
}));

vi.mock('@/server/services/discover', () => ({
  DiscoverService: vi.fn(() => ({})),
}));

const createRuntime = () =>
  agentBuilderRuntime.factory({
    editingAgentId: 'agent-1',
    serverDB: {} as never,
    toolManifestMap: {},
    userId: 'user-1',
  });

const originalManagedAiFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;

afterAll(() => {
  if (originalManagedAiFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
  else process.env.ENABLE_PLATFORM_MANAGED_AI = originalManagedAiFlag;
});

describe('agentBuilderRuntime', () => {
  beforeEach(() => {
    delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    vi.clearAllMocks();
  });

  describe('getAvailableModels', () => {
    it('preserves the upstream repositories and sort order when managed AI is disabled', async () => {
      mockGetAiProviderList.mockResolvedValue([
        { enabled: true, id: 'provider-z', name: 'Z', sort: 2 },
        { enabled: true, id: 'lobehub', name: 'LobeHub', sort: 99 },
        { enabled: false, id: 'disabled', name: 'Disabled', sort: 0 },
        { enabled: true, id: 'provider-a', name: 'A', sort: 1 },
      ]);
      mockGetAiProviderModelList.mockImplementation(async (providerId: string) => [
        { abilities: {}, displayName: `${providerId} model`, id: `${providerId}-model` },
      ]);

      const result = await createRuntime().getAvailableModels({});

      expect(result.success).toBe(true);
      expect(result.state).toMatchObject({
        providers: [{ id: 'lobehub' }, { id: 'provider-a' }, { id: 'provider-z' }],
      });
      expect(mockGetAiProviderRuntimeState).not.toHaveBeenCalled();
      expect(mockResolveAiCatalogRuntimeState).not.toHaveBeenCalled();
      expect(mockGetAiProviderModelList.mock.calls).toEqual([
        ['lobehub', { enabled: true, type: 'chat' }],
        ['provider-a', { enabled: true, type: 'chat' }],
        ['provider-z', { enabled: true, type: 'chat' }],
      ]);
    });

    it('preserves catalog provider order when managed AI is enabled', async () => {
      process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
      mockResolveAiCatalogRuntimeState.mockResolvedValue({
        enabledAiModels: [
          { enabled: true, id: 'beta-model', providerId: 'beta', type: 'chat' },
          { enabled: true, id: 'alpha-model', providerId: 'alpha', type: 'chat' },
        ],
        enabledAiProviders: [
          { id: 'beta', name: 'Beta' },
          { id: 'alpha', name: 'Alpha' },
        ],
      });

      const result = await createRuntime().getAvailableModels({});

      expect(result.success).toBe(true);
      expect(result.state).toMatchObject({ providers: [{ id: 'beta' }, { id: 'alpha' }] });
      expect(mockGetAiProviderRuntimeState).not.toHaveBeenCalled();
      expect(mockGetAiProviderList).not.toHaveBeenCalled();
      expect(mockGetAiProviderModelList).not.toHaveBeenCalled();
    });
  });

  describe('updateConfig - togglePlugin', () => {
    it('appends a new pinned entry when enabling an absent identifier', async () => {
      mockGetAgentConfigById.mockResolvedValue({ id: 'agent-1', plugins: ['plugin-a'] });

      const runtime = createRuntime();
      const result = await runtime.updateConfig(
        { togglePlugin: { enabled: true, pluginId: 'plugin-b' } },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).toHaveBeenCalledWith('agent-1', {
        plugins: ['plugin-a', { identifier: 'plugin-b', mode: 'pinned' }],
      });
    });

    it('flips an existing disabled object entry back to pinned in place, without duplicating it', async () => {
      mockGetAgentConfigById.mockResolvedValue({
        id: 'agent-1',
        plugins: ['plugin-a', { identifier: 'plugin-b', mode: 'disabled' }],
      });

      const runtime = createRuntime();
      const result = await runtime.updateConfig(
        { togglePlugin: { enabled: true, pluginId: 'plugin-b' } },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).toHaveBeenCalledWith('agent-1', {
        plugins: ['plugin-a', { identifier: 'plugin-b', mode: 'pinned' }],
      });
    });

    it('disabling (enabled: false) reverts the entry to auto, removing it from the array', async () => {
      mockGetAgentConfigById.mockResolvedValue({
        id: 'agent-1',
        plugins: ['plugin-a', 'plugin-b'],
      });

      const runtime = createRuntime();
      const result = await runtime.updateConfig(
        { togglePlugin: { enabled: false, pluginId: 'plugin-b' } },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).toHaveBeenCalledWith('agent-1', { plugins: ['plugin-a'] });
    });
  });

  describe('installPlugin', () => {
    it('flips an existing disabled builtin-tool entry back to pinned, without duplicating it', async () => {
      mockGetAgentConfigById.mockResolvedValue({
        id: 'agent-1',
        plugins: [{ identifier: 'lobe-web-browsing', mode: 'disabled' }],
      });

      const runtime = createRuntime();
      const result = await runtime.installPlugin(
        { identifier: 'lobe-web-browsing', source: 'official' },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).toHaveBeenCalledWith('agent-1', {
        plugins: [{ identifier: 'lobe-web-browsing', mode: 'pinned' }],
      });
    });

    it('is a no-op write when the builtin-tool identifier is already pinned', async () => {
      mockGetAgentConfigById.mockResolvedValue({
        id: 'agent-1',
        plugins: ['lobe-web-browsing'],
      });

      const runtime = createRuntime();
      const result = await runtime.installPlugin(
        { identifier: 'lobe-web-browsing', source: 'official' },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it('flips an existing disabled market-plugin entry back to pinned, without duplicating it', async () => {
      mockGetAgentConfigById.mockResolvedValue({
        id: 'agent-1',
        plugins: [{ identifier: 'market-plugin', mode: 'disabled' }],
      });
      mockFindById.mockResolvedValue({ identifier: 'market-plugin', manifest: { api: [] } });

      const runtime = createRuntime();
      const result = await runtime.installPlugin(
        { identifier: 'market-plugin', source: 'market' },
        { editingAgentId: 'agent-1', toolManifestMap: {} },
      );

      expect(result.success).toBe(true);
      expect(mockUpdateConfig).toHaveBeenCalledWith('agent-1', {
        plugins: [{ identifier: 'market-plugin', mode: 'pinned' }],
      });
    });
  });
});
