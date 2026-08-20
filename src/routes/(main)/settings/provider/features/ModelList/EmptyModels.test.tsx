import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EmptyModels from './EmptyModels';

const mocks = vi.hoisted(() => ({
  managed: false,
  store: {
    fetchRemoteModelList: vi.fn(),
    supportsUpstreamSync: false,
  },
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
  Button: ({ children, icon: _icon, loading, ...props }: any) => (
    <button data-loading={String(Boolean(loading))} {...props}>
      {children}
    </button>
  ),
  Center: ({ children }: any) => <div>{children}</div>,
  Flexbox: ({ children }: any) => <div>{children}</div>,
  Icon: () => <span />,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), success: vi.fn() } }) },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => 'style' }),
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({ managed: mocks.managed }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true, reason: 'no permission to manage provider keys' }),
}));

vi.mock('@/store/aiInfra', () => ({
  useAiInfraStoreApi: () => ({ getState: () => ({ aiProviderModelList: [] }) }),
  useScopedAiInfraStore: (selector: any) => selector(mocks.store),
}));

vi.mock('./CreateNewModelModal', () => ({ createCreateNewModelModal: vi.fn() }));

vi.mock('./ProviderSettingsContext', async () => {
  const { createContext } = await import('react');
  return { ProviderSettingsContext: createContext({}) };
});

vi.mock('./useSyncUpstreamModels', () => ({
  useSyncUpstreamModels: () => mocks.sync,
}));

describe('EmptyModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managed = false;
    mocks.store.supportsUpstreamSync = false;
    mocks.sync.disabled = false;
    mocks.sync.isSyncing = false;
  });

  it('hides add/fetch/sync when aiModels is managed', () => {
    mocks.managed = true;
    render(<EmptyModels provider="openai" />);
    expect(screen.getByText('providerModels.list.empty.title')).toBeInTheDocument();
    expect(screen.queryByText('providerModels.list.addNew')).not.toBeInTheDocument();
    expect(screen.queryByText('providerModels.list.fetcher.fetch')).not.toBeInTheDocument();
    expect(screen.queryByText('providerModels.list.syncUpstream.action')).not.toBeInTheDocument();
  });

  it('offers the BYOK fetch when the panel cannot sync upstream', () => {
    render(<EmptyModels provider="openai" />);

    expect(screen.getByText('providerModels.list.fetcher.fetch')).toBeInTheDocument();
    expect(screen.queryByText('providerModels.list.syncUpstream.action')).not.toBeInTheDocument();
  });

  /**
   * The panel that administers a shared platform account cannot use the BYOK fetch at all — it
   * reads the signed-in operator's own vault — so sync replaces it rather than sitting beside it.
   */
  it('replaces the BYOK fetch with upstream sync where sync is available', async () => {
    mocks.store.supportsUpstreamSync = true;
    render(<EmptyModels provider="supergrok" />);

    const sync = screen.getByText('providerModels.list.syncUpstream.action');
    expect(screen.queryByText('providerModels.list.fetcher.fetch')).not.toBeInTheDocument();

    sync.click();
    expect(mocks.sync.syncUpstream).toHaveBeenCalled();
    expect(mocks.store.fetchRemoteModelList).not.toHaveBeenCalled();
  });

  it('reports the in-flight sync on the button it started from', () => {
    mocks.store.supportsUpstreamSync = true;
    mocks.sync.isSyncing = true;
    render(<EmptyModels provider="supergrok" />);

    expect(screen.getByText('providerModels.list.syncUpstream.syncing')).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('disables sync a member may not run', () => {
    mocks.store.supportsUpstreamSync = true;
    mocks.sync.disabled = true;
    render(<EmptyModels provider="supergrok" />);

    expect(screen.getByText('providerModels.list.syncUpstream.action')).toBeDisabled();
  });
});
