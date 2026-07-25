// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiInfraServices } from '@/store/aiInfra';
import { AiInfraStoreProvider, createAiInfraStore } from '@/store/aiInfra';

import DisabledModels from './DisabledModels';

const userGetList = vi.fn();
const adminGetList = vi.fn();

vi.mock('@/services/aiModel', () => ({
  aiModelService: {
    getAiProviderModelList: (...args: unknown[]) => userGetList(...args),
  },
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      disabledModelsSortType: 'default',
      updateSystemStatus: vi.fn(),
    }),
}));

vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: {
    disabledModelsSortType: () => 'default',
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('./ModelItem', () => ({
  default: (props: { id: string; displayName?: string }) => (
    <div data-testid={`model-${props.id}`}>{props.displayName ?? props.id}</div>
  ),
}));

const noopLoose = async () => undefined;

const buildAdminServices = (): AiInfraServices => ({
  aiModel: {
    batchToggleAiModels: noopLoose,
    batchUpdateAiModels: noopLoose,
    clearModelsByProvider: noopLoose,
    clearRemoteModels: noopLoose,
    createAiModel: noopLoose,
    deleteAiModel: noopLoose,
    getAiProviderModelList: adminGetList,
    toggleModelEnabled: noopLoose,
    updateAiModel: noopLoose,
    updateAiModelOrder: noopLoose,
  },
  aiProvider: {
    createAiProvider: noopLoose,
    deleteAiProvider: noopLoose,
    getAiProviderById: async () => undefined,
    getAiProviderList: async () => [],
    getAiProviderRuntimeState: async () =>
      ({
        enabledAiModels: [],
        enabledAiProviders: [],
        enabledChatAiProviders: [],
        enabledImageAiProviders: [],
        enabledVideoAiProviders: [],
        runtimeConfig: {},
      }) as never,
    toggleProviderEnabled: noopLoose,
    updateAiProvider: noopLoose,
    updateAiProviderConfig: noopLoose,
    updateAiProviderOrder: noopLoose,
  },
  swrScope: 'admin',
});

describe('DisabledModels admin datasource isolation (AI-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userGetList.mockResolvedValue([
      {
        enabled: false,
        id: 'personal-sentinel',
        displayName: 'PERSONAL_SENTINEL',
        type: 'chat',
      },
    ]);
    adminGetList.mockResolvedValue([]);
  });

  it('pages disabled models through the scoped admin service, never the user singleton', async () => {
    const store = createAiInfraStore(buildAdminServices());
    // Fewer than PAGE_SIZE (30) so remote pagination enables immediately.
    store.setState({
      aiProviderModelList: [
        {
          enabled: false,
          id: 'org-disabled-1',
          displayName: 'Org Disabled',
          type: 'chat',
        },
      ],
      isAiModelListInit: true,
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AiInfraStoreProvider store={store}>{children}</AiInfraStoreProvider>
      </SWRConfig>
    );

    const { queryByText, queryByTestId } = render(
      <DisabledModels activeTab="all" providerId="openai" />,
      { wrapper },
    );

    await waitFor(() => {
      expect(adminGetList).toHaveBeenCalled();
    });

    expect(adminGetList).toHaveBeenCalledWith('openai', {
      enabled: false,
      limit: 30,
      offset: 1,
    });
    expect(userGetList).not.toHaveBeenCalled();
    expect(queryByText('PERSONAL_SENTINEL')).toBeNull();
    expect(queryByTestId('model-personal-sentinel')).toBeNull();
    expect(queryByTestId('model-org-disabled-1')).not.toBeNull();

    // Scoped SWR key includes admin prefix.
    const key = store.getState().getDisabledModelsPageKey('openai', 1);
    expect(key[0]).toBe('admin');
  });
});
