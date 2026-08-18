import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as swr from '@/libs/swr';
import { type AiInfraServices, createAiInfraStore, useAiInfraStore } from '@/store/aiInfra';
import { useUserStore } from '@/store/user';
import type { AiProviderDetailItem, AiProviderListItem } from '@/types/aiProvider';

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

  // The admin providers surface recreates its scoped store on every route mount while SWR keeps
  // the response cached. Hydration therefore has to run from `onData` (cached AND fresh data),
  // never from `onSuccess` alone — see AdminProviderSettingsStore.hydration.test.tsx.
  describe('cache hydration wiring', () => {
    const createScopedStore = () => {
      const services = {
        aiModel: {},
        aiProvider: {
          getAiProviderById: vi.fn(),
          getAiProviderList: vi.fn(),
          getAiProviderRuntimeState: vi.fn(),
        },
        swrScope: 'admin',
      } as unknown as AiInfraServices;

      return createAiInfraStore(services);
    };

    /** Render a hook with `useClientDataSWRWithSync` stubbed and capture its arguments. */
    const captureSync = () => {
      const calls: { fetcher: unknown; key: unknown; options: any }[] = [];
      vi.spyOn(swr, 'useClientDataSWRWithSync').mockImplementation(((
        key: unknown,
        fetcher: unknown,
        options: any,
      ) => {
        calls.push({ fetcher, key, options });
        return { data: undefined, isValidating: false, mutate: vi.fn() };
      }) as any);
      return calls;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches the provider list through the cache-syncing SWR hook under the scoped key', () => {
      const calls = captureSync();
      const store = createScopedStore();

      renderHook(() => store.getState().useFetchAiProviderList());

      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe('admin:FETCH_AI_PROVIDER');
      expect(calls[0].options.onData).toEqual(expect.any(Function));
      expect(calls[0].options.onSuccess).toBeUndefined();
    });

    it('skips the provider-list request when disabled', () => {
      const calls = captureSync();
      const store = createScopedStore();

      renderHook(() => store.getState().useFetchAiProviderList({ enabled: false }));

      expect(calls[0].key).toBeNull();
    });

    it('marks the provider list initialised from cached data', () => {
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderList());

      const list = [{ enabled: true, id: 'openai' }] as unknown as AiProviderListItem[];
      act(() => calls[0].options.onData(list));

      expect(store.getState().aiProviderList).toBe(list);
      expect(store.getState().initAiProviderList).toBe(true);
    });

    it('keeps refreshing the provider list after initialisation', () => {
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderList());

      const first = [{ enabled: true, id: 'openai' }] as unknown as AiProviderListItem[];
      const second = [{ enabled: false, id: 'openai' }] as unknown as AiProviderListItem[];
      act(() => calls[0].options.onData(first));
      act(() => calls[0].options.onData(second));

      expect(store.getState().aiProviderList).toBe(second);
      expect(store.getState().initAiProviderList).toBe(true);
    });

    it('does not rewrite the store when the same provider list is replayed', () => {
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderList());

      const list = [{ enabled: true, id: 'openai' }] as unknown as AiProviderListItem[];
      act(() => calls[0].options.onData(list));

      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      act(() => calls[0].options.onData(list));
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
    });

    it('fills the provider detail map from cached data', () => {
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderItem('openai'));

      expect(calls[0].key).toEqual(['admin', 'FETCH_AI_PROVIDER_ITEM', 'openai']);

      const detail = { enabled: true, id: 'openai' } as unknown as AiProviderDetailItem;
      act(() => calls[0].options.onData(detail));

      expect(store.getState().aiProviderDetailMap.openai).toBe(detail);
      expect(store.getState().activeAiProvider).toBe('openai');
    });

    it('re-keys the detail request and store entry when the provider id changes', () => {
      const calls = captureSync();
      const store = createScopedStore();
      const { rerender } = renderHook(({ id }) => store.getState().useFetchAiProviderItem(id), {
        initialProps: { id: 'openai' },
      });

      const openai = { enabled: true, id: 'openai' } as unknown as AiProviderDetailItem;
      act(() => calls[0].options.onData(openai));

      rerender({ id: 'anthropic' });
      const latest = calls.at(-1)!;
      expect(latest.key).toEqual(['admin', 'FETCH_AI_PROVIDER_ITEM', 'anthropic']);

      const anthropic = { enabled: true, id: 'anthropic' } as unknown as AiProviderDetailItem;
      act(() => latest.options.onData(anthropic));

      expect(store.getState().activeAiProvider).toBe('anthropic');
      expect(store.getState().aiProviderDetailMap.anthropic).toBe(anthropic);
      // The previous provider stays cached in the map — only the active id moves.
      expect(store.getState().aiProviderDetailMap.openai).toBe(openai);
    });

    it('flags the runtime state as initialised from cached data', () => {
      useUserStore.setState({ isLoaded: true });
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderRuntimeState(true));

      expect(calls[0].key).toEqual(['admin', 'FETCH_AI_PROVIDER_RUNTIME_STATE', true]);

      act(() =>
        calls[0].options.onData({
          builtinAiModelList: [],
          enabledAiModels: [],
          enabledAiProviders: [],
          runtimeConfig: {},
        }),
      );

      expect(store.getState().isInitAiProviderRuntimeState).toBe(true);
    });

    it('applies a runtime-state refresh that only changed the runtime config', () => {
      // The enabled-model list is often untouched across refreshes (and may even be the very same
      // reference), while `runtimeConfig` / provider lists / redirects DO change — e.g. after a
      // provider key is saved. Treating the model list as a proxy for "nothing changed" dropped
      // those updates; deduping is the SWR helper's job, keyed on the whole payload.
      useUserStore.setState({ isLoaded: true });
      const calls = captureSync();
      const store = createScopedStore();
      renderHook(() => store.getState().useFetchAiProviderRuntimeState(true));

      const enabledAiModels: never[] = [];
      act(() =>
        calls[0].options.onData({
          builtinAiModelList: [],
          enabledAiModels,
          enabledAiProviders: [],
          modelRedirects: {},
          runtimeConfig: {},
        }),
      );

      const runtimeConfig = { openai: { fetchOnClient: true } };
      const modelRedirects = { 'gpt-4o': 'gpt-4o-mini' };
      act(() =>
        calls[0].options.onData({
          builtinAiModelList: [],
          enabledAiModels,
          enabledAiProviders: [{ id: 'openai', name: 'OpenAI', source: 'builtin' }],
          modelRedirects,
          runtimeConfig,
        }),
      );

      expect(store.getState().aiProviderRuntimeConfig).toBe(runtimeConfig);
      expect(store.getState().modelRedirects).toBe(modelRedirects);
      expect(store.getState().enabledAiProviders).toEqual([
        { id: 'openai', name: 'OpenAI', source: 'builtin' },
      ]);
    });
  });

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
