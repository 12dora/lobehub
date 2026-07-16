import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAiInfraStore } from '@/store/aiInfra';

import { buildAiProviderRuntimeStoreState } from './action';

describe('AiProviderAction', () => {
  it.each(['ui-only', 'enforced'])(
    'hydrates a new-user picker from the secret-free managed runtime state in %s mode',
    async () => {
      const state = await buildAiProviderRuntimeStoreState(
        {
          enabledAiModels: [
            {
              abilities: {},
              displayName: 'Managed Model',
              enabled: true,
              id: 'managed-model',
              providerId: 'managed-provider',
              type: 'chat',
            },
          ],
          enabledAiProviders: [
            { id: 'managed-provider', name: 'Managed Provider', source: 'custom' },
          ],
          enabledChatAiProviders: [
            { id: 'managed-provider', name: 'Managed Provider', source: 'custom' },
          ],
          enabledImageAiProviders: [],
          enabledVideoAiProviders: [],
          runtimeConfig: {
            'managed-provider': {
              config: {},
              fetchOnClient: false,
              keyVaults: {},
              settings: {},
            },
          },
        },
        [],
      );

      expect(state.enabledAiProviders.map((item) => item.id)).toEqual(['managed-provider']);
      expect(state.enabledAiModels.map((item) => item.id)).toEqual(['managed-model']);
      expect(state.enabledChatModelList?.[0]).toMatchObject({
        children: [expect.objectContaining({ id: 'managed-model' })],
        id: 'managed-provider',
      });
      expect(state.runtimeConfig['managed-provider']).toEqual({
        config: {},
        fetchOnClient: false,
        keyVaults: {},
        settings: {},
      });
      expect(JSON.stringify(state)).not.toMatch(
        /endpoint|plaintext|ciphertext|fingerprint|api[-_]?key/i,
      );
    },
  );

  describe('ensureAiProviderRuntimeStateReady', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      useAiInfraStore.setState({ isInitAiProviderRuntimeState: false });
    });

    it('resolves immediately without refreshing when the runtime-state is already loaded', async () => {
      const refresh = vi.fn(async () => {});
      useAiInfraStore.setState({
        isInitAiProviderRuntimeState: true,
        refreshAiProviderRuntimeState: refresh,
      });

      await useAiInfraStore.getState().ensureAiProviderRuntimeStateReady();

      expect(refresh).not.toHaveBeenCalled();
    });

    it('triggers a refresh and awaits it when the runtime-state is not loaded', async () => {
      const refresh = vi.fn(async () => {});
      useAiInfraStore.setState({
        isInitAiProviderRuntimeState: false,
        refreshAiProviderRuntimeState: refresh,
      });

      await useAiInfraStore.getState().ensureAiProviderRuntimeStateReady();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('falls back after the timeout when the refresh never settles', async () => {
      vi.useFakeTimers();
      // A refresh that never resolves — e.g. still gated behind an unresolved
      // auth session. The caller must not be blocked forever.
      const refresh = vi.fn(() => new Promise<void>(() => {}));
      useAiInfraStore.setState({
        isInitAiProviderRuntimeState: false,
        refreshAiProviderRuntimeState: refresh,
      });

      const pending = useAiInfraStore.getState().ensureAiProviderRuntimeStateReady(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toBeUndefined();
    });

    it('does not reject when the refresh throws', async () => {
      const refresh = vi.fn(async () => {
        throw new Error('network down');
      });
      useAiInfraStore.setState({
        isInitAiProviderRuntimeState: false,
        refreshAiProviderRuntimeState: refresh,
      });

      await expect(
        useAiInfraStore.getState().ensureAiProviderRuntimeStateReady(),
      ).resolves.toBeUndefined();
    });
  });
});
