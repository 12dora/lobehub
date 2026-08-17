// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NetworkProxyConfigView } from '@/types/platform/networkProxy';

import type { NetworkProxyActions } from '../useNetworkProxyActions';
import ScopesSection from './ScopesSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/icons', () => ({ ProviderIcon: () => <span /> }));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div>
      <span>{message}</span>
      {action}
    </div>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  Select: () => <span />,
  Switch: () => <span />,
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({ dataSource }: { dataSource?: { id?: string; key?: string }[] }) => (
    <div data-testid="table">{(dataSource ?? []).map((row) => row.id ?? row.key).join(',')}</div>
  ),
}));

vi.mock('../../primitives/columnFilters', () => ({ searchColumnFilter: () => ({}) }));
vi.mock('../FieldStatus', () => ({ default: () => null }));

const config = (
  providers: NetworkProxyConfigView['scopes']['providers'] = {},
): NetworkProxyConfigView => ({
  bypassHosts: [],
  downloadViaStaticProxy: false,
  engineLogLevel: 'warning',
  masterEnabled: true,
  outlet: {
    kind: 'engine',
    latencyIntervalSec: 300,
    latencyTestUrl: 'https://example.com',
    mode: 'auto',
    toleranceMs: 150,
  },
  ruleMode: 'simple',
  scopes: {
    features: {
      content_moderation: { enabled: false, onUnavailable: 'direct' },
      import_fetch: { enabled: false, onUnavailable: 'direct' },
      market: { enabled: false, onUnavailable: 'direct' },
      mcp: { enabled: false, onUnavailable: 'direct' },
      web_search: { enabled: false, onUnavailable: 'direct' },
    },
    providers,
  },
  subscriptionUpdateViaOutlet: false,
});

const stubActions = (updateScopes = vi.fn()): NetworkProxyActions =>
  ({
    conflicts: [],
    dismiss: vi.fn(),
    dismissAll: vi.fn(),
    entryOf: () => undefined,
    installArtifact: vi.fn(),
    isBusy: () => false,
    lastConnectivity: null,
    latestNodes: null,
    patchConfig: vi.fn(),
    restartEngine: vi.fn(),
    retry: vi.fn(),
    retryAll: vi.fn(),
    selectNode: vi.fn(),
    testConnectivity: vi.fn(),
    testLatency: vi.fn(),
    updateScopes,
    valueOf: <T,>(_field: string, value: T) => value,
  }) as unknown as NetworkProxyActions;

const renderSection = (props: Partial<Parameters<typeof ScopesSection>[0]> = {}) => {
  const updateScopes = vi.fn();
  render(
    <ScopesSection
      canManage
      actions={stubActions(updateScopes)}
      config={config()}
      providerCatalogFailed={false}
      providerIds={['openai']}
      providers={[{ enabled: true, id: 'openai', name: 'OpenAI' }]}
      onReloadProviders={vi.fn()}
      {...props}
    />,
  );
  return { updateScopes };
};

describe('ScopesSection', () => {
  it('applies a bulk write over the ids the tab computed (catalog ∪ configured)', () => {
    const updateScopes = vi.fn();
    render(
      <ScopesSection
        canManage
        actions={stubActions(updateScopes)}
        config={config({ legacy: { enabled: true, onUnavailable: 'direct' } })}
        providerCatalogFailed={false}
        providerIds={['openai', 'legacy']}
        providers={[{ enabled: true, id: 'openai', name: 'OpenAI' }]}
        onReloadProviders={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('providers-disable-all'));
    expect(updateScopes).toHaveBeenCalledWith('scopes.bulk', undefined, [
      { enabled: false, providerIds: ['openai', 'legacy'], target: 'all_providers' },
    ]);
  });

  it('keeps a configured provider visible after it leaves the catalog', () => {
    renderSection({
      config: config({ legacy: { enabled: true, onUnavailable: 'direct' } }),
      providerIds: ['openai', 'legacy'],
    });
    expect(screen.getAllByTestId('table')[0]!.textContent).toBe('openai,legacy');
  });

  it('disables provider bulk operations and says why when the catalog failed to load', () => {
    renderSection({ providerCatalogFailed: true });
    expect((screen.getByTestId('providers-enable-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('providers-disable-all') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('networkProxy.scopes.bulkUnavailable')).toBeTruthy();
  });

  it('disables every bulk control for a read-only admin', () => {
    renderSection({ canManage: false });
    expect((screen.getByTestId('providers-enable-all') as HTMLButtonElement).disabled).toBe(true);
  });
});
