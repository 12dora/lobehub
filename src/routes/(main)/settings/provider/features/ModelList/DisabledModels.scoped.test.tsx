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

const buildUserServices = (): AiInfraServices => {
  const services = buildAdminServices();
  return {
    ...services,
    aiModel: { ...services.aiModel, getAiProviderModelList: userGetList },
    swrScope: undefined as never,
  };
};

describe('DisabledModels for a platform-managed provider (bug E)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userGetList.mockResolvedValue([]);
    adminGetList.mockResolvedValue([]);
  });

  it('renders admin-published models the viewer turned off instead of dropping them', async () => {
    // The settings list for an ACTIVE platform-managed provider is the published set overlaid
    // with the viewer's own choices, so a model the user disabled comes back with
    // `enabled: false` and must appear here — previously it vanished from settings entirely.
    const store = createAiInfraStore(buildUserServices());
    store.setState({
      aiProviderModelList: [
        { displayName: 'GPT-5.6 Sol', enabled: false, id: 'gpt-5.6-sol', type: 'chat' },
        { displayName: 'GPT-5.5', enabled: false, id: 'gpt-5.5', type: 'chat' },
      ],
      isAiModelListInit: true,
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <AiInfraStoreProvider store={store}>{children}</AiInfraStoreProvider>
      </SWRConfig>
    );

    const { queryByTestId } = render(<DisabledModels activeTab="all" providerId="chatgpt" />, {
      wrapper,
    });

    await waitFor(() => expect(queryByTestId('model-gpt-5.6-sol')).not.toBeNull());
    expect(queryByTestId('model-gpt-5.5')).not.toBeNull();
  });
});
