import { renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ZodModule from 'zod';

import { mapFeatureFlagsEnvToState } from '@/config/featureFlags';
import { SettingsTabs } from '@/store/global/initialState';
import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { useUserStore } from '@/store/user';

import { useCategory } from './useCategory';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

const managedResourcesRef = vi.hoisted(() => ({
  current: {
    capabilities: {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
    },
    error: null as Error | null,
    loading: false,
  },
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/ManagedResources', () => ({
  isManagedResourceConfigurationAvailable: (
    resource: keyof typeof managedResourcesRef.current.capabilities,
    snapshot: typeof managedResourcesRef.current,
  ) => !snapshot.loading && !snapshot.error && !snapshot.capabilities[resource],
  useManagedResourceCapabilities: () => managedResourcesRef.current,
}));

const createWrapper = (showProvider: boolean) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider
      createStore={() =>
        initServerConfigStore({
          featureFlags: {
            ...mapFeatureFlagsEnvToState({
              provider_settings: true,
            }),
            showProvider,
          },
        })
      }
    >
      {children}
    </Provider>
  );

  return Wrapper;
};

const getItemKeys = () => {
  const { result } = renderHook(() => useCategory(), {
    wrapper: createWrapper(true),
  });

  return result.current.flatMap((group) => group.items.map((item) => item.key));
};

const initialUserStoreState = useUserStore.getState();

afterEach(() => {
  useUserStore.setState(initialUserStoreState, true);
  managedResourcesRef.current = {
    capabilities: {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
    },
    error: null,
    loading: false,
  };
});

describe('settings useCategory', () => {
  it('keeps Provider visible when provider settings are enabled', () => {
    expect(getItemKeys()).toContain(SettingsTabs.Provider);
  });

  it('hides Provider when provider settings are disabled', () => {
    const { result } = renderHook(() => useCategory(), {
      wrapper: createWrapper(false),
    });

    const keys = result.current.flatMap((group) => group.items.map((item) => item.key));

    expect(keys).not.toContain(SettingsTabs.Provider);
  });

  it('keeps Skill navigation visible as a read-only catalog when managed', () => {
    managedResourcesRef.current.capabilities.skills = true;

    expect(getItemKeys()).toContain(SettingsTabs.Skill);
  });

  it('hides Skill navigation while the capability snapshot is unavailable', () => {
    managedResourcesRef.current.loading = true;

    expect(getItemKeys()).not.toContain(SettingsTabs.Skill);
  });
});
