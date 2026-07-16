import { testService } from '~test-utils';

import { AiProviderService, aiProviderService } from './index';

const mocks = vi.hoisted(() => ({ runtimeState: vi.fn() }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aiProvider: { getAiProviderRuntimeState: { query: mocks.runtimeState } },
  },
}));

describe('aiProviderService', () => {
  testService(AiProviderService);

  it('forwards the single runtime-state source without client-side catalog merging', async () => {
    const state = {
      enabledAiModels: [
        { enabled: true, id: 'managed-model', providerId: 'managed-provider', type: 'chat' },
      ],
      enabledAiProviders: [{ id: 'managed-provider', name: 'Managed', source: 'custom' }],
      enabledChatAiProviders: [{ id: 'managed-provider', name: 'Managed', source: 'custom' }],
      enabledImageAiProviders: [],
      enabledVideoAiProviders: [],
      runtimeConfig: {
        'managed-provider': { config: {}, fetchOnClient: false, keyVaults: {}, settings: {} },
      },
    };
    mocks.runtimeState.mockResolvedValue(state);

    const result = await aiProviderService.getAiProviderRuntimeState(true);

    expect(result).toBe(state);
    expect(mocks.runtimeState).toHaveBeenCalledWith({ isLogin: true });
    expect(JSON.stringify(result)).not.toMatch(
      /endpoint|plaintext|ciphertext|fingerprint|api[-_]?key/i,
    );
  });
});
