import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ModelTitle from './index';

const mocks = vi.hoisted(() => ({
  managed: false,
  permission: { allowed: true, reason: 'no permission to manage provider keys' },
  sync: {
    disabled: false,
    disabledReason: undefined as string | undefined,
    isSyncing: false,
    syncUpstream: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: (props: any) => <button data-testid="action-icon" {...props} />,
  Button: ({ children, icon: _icon, loading, ...props }: any) => (
    <button data-loading={String(Boolean(loading))} {...props}>
      {children}
    </button>
  ),
  DropdownMenu: ({ children, items }: any) => (
    <div>
      {children}
      <ul data-testid="dropdown-items">
        {items.map((item: any) => (
          <li data-disabled={String(Boolean(item.disabled))} data-key={item.key} key={item.key}>
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  ),
  Flexbox: ({ children }: any) => <div>{children}</div>,
  Skeleton: { Button: () => <div data-testid="skeleton" /> },
  Text: ({ children }: any) => <span>{children}</span>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: vi.fn() }));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), success: vi.fn() } }) },
  Space: { Compact: ({ children }: any) => <div>{children}</div> },
}));

vi.mock('antd-style', () => ({ cssVar: new Proxy({}, { get: () => 'var(--x)' }) }));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({ managed: mocks.managed }),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => mocks.permission }));

vi.mock('@/store/aiInfra/selectors', () => ({
  aiModelSelectors: {
    hasRemoteModels: () => false,
    isEmptyAiProviderModelList: () => false,
    totalAiProviderModelList: () => 5,
  },
}));

vi.mock('@/store/aiInfra', () => {
  const state = {
    clearModelsByProvider: vi.fn(),
    clearRemoteModels: vi.fn(),
    fetchRemoteModelList: vi.fn(),
    modelSearchKeyword: '',
    useFetchAiProviderModels: () => ({ isLoading: false }),
  };
  return {
    useAiInfraStoreApi: () => ({ getState: () => state, setState: vi.fn() }),
    useScopedAiInfraStore: (selector: any) => selector(state),
  };
});

vi.mock('../CreateNewModelModal', () => ({ createCreateNewModelModal: vi.fn() }));

vi.mock('../ProviderSettingsContext', async () => {
  const { createContext } = await import('react');
  return { ProviderSettingsContext: createContext({}) };
});

vi.mock('./Search', () => ({ default: () => <div data-testid="search" /> }));

vi.mock('../useSyncUpstreamModels', () => ({
  useSyncUpstreamModels: () => mocks.sync,
}));

const syncItem = () =>
  screen.getByTestId('dropdown-items').querySelector('[data-key="syncUpstream"]');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managed = false;
  mocks.permission = { allowed: true, reason: 'no permission to manage provider keys' };
  mocks.sync = {
    disabled: false,
    disabledReason: undefined,
    isSyncing: false,
    syncUpstream: vi.fn(),
  };
});

describe('ModelTitle sync upstream action', () => {
  it('offers the action in the admin panel, where the fetch button is force-hidden', () => {
    // The admin bridge sets showModelFetcher: false for every provider, and the chatgpt card
    // sets it false too — a fetcher-gated affordance would be invisible exactly where the
    // shared platform account makes it most useful.
    render(<ModelTitle provider="cursor" showModelFetcher={false} />);

    expect(syncItem()).not.toBeNull();
    expect(syncItem()).toHaveTextContent('providerModels.list.syncUpstream.action');
    expect(screen.queryByText('providerModels.list.fetcher.fetch')).toBeNull();
  });

  it('still offers the action alongside the fetch button on a BYOK provider', () => {
    render(<ModelTitle provider="cursor" showModelFetcher={true} />);

    expect(syncItem()).not.toBeNull();
    expect(screen.getByText('providerModels.list.fetcher.fetch')).toBeInTheDocument();
  });

  it('shows the in-flight label and marks the trigger busy while syncing', () => {
    mocks.sync.isSyncing = true;
    render(<ModelTitle provider="cursor" showModelFetcher={false} />);

    expect(syncItem()).toHaveTextContent('providerModels.list.syncUpstream.syncing');
    expect(syncItem()).toHaveAttribute('data-disabled', 'true');
  });

  it('explains why the action is unavailable instead of leaving a dead row', () => {
    mocks.sync.disabled = true;
    mocks.sync.disabledReason = 'providerModels.list.syncUpstream.managed';
    render(<ModelTitle provider="cursor" showModelFetcher={false} />);

    expect(syncItem()).toHaveAttribute('data-disabled', 'true');
    expect(syncItem()).toHaveTextContent('providerModels.list.syncUpstream.managed');
  });

  it('hides fetch/add/sync/reset when aiModels is managed and keeps search', () => {
    mocks.managed = true;
    render(<ModelTitle provider="cursor" showModelFetcher={true} />);

    expect(screen.getByTestId('search')).toBeInTheDocument();
    expect(screen.queryByText('providerModels.list.fetcher.fetch')).toBeNull();
    expect(screen.queryByTestId('dropdown-items')).toBeNull();
  });

  it('keeps the reset item after it, unchanged', () => {
    render(<ModelTitle provider="cursor" showModelFetcher={false} />);

    const keys = [...screen.getByTestId('dropdown-items').children].map((li) =>
      li.getAttribute('data-key'),
    );
    expect(keys).toEqual(['syncUpstream', 'reset']);
  });
});
