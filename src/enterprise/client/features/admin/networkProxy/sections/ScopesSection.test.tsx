// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { TableColumnsType } from 'antd';
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
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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

/**
 * The provider table's columns and `onChange` are the contract under test, so the mock exposes
 * both: column keys as a data attribute, and a button that replays an antd filter payload.
 */
vi.mock('../../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
    onChange,
  }: {
    columns?: TableColumnsType<{ id?: string; key?: string }>;
    dataSource?: { id?: string; key?: string }[];
    onChange?: (meta: { filters: Record<string, string[] | null> }) => void;
  }) => (
    <div data-testid="table">
      <span data-testid="columns">
        {(columns ?? []).map((column) => String(column.key ?? '')).join(',')}
      </span>
      <span data-testid="rows">{(dataSource ?? []).map((row) => row.id ?? row.key).join(',')}</span>
      {(dataSource ?? []).map((row, index) => (
        <div data-testid="cells" key={row.id ?? row.key}>
          {(columns ?? []).map((column) => (
            <span key={String(column.key ?? '')}>
              {'render' in column && column.render
                ? (column.render(undefined, row, index) as ReactNode)
                : null}
            </span>
          ))}
        </div>
      ))}
      <button
        data-testid="filter-enabled"
        type="button"
        onClick={() => onChange?.({ filters: { status: ['enabled'] } })}
      />
      <button
        data-testid="filter-clear"
        type="button"
        onClick={() => onChange?.({ filters: { status: null } })}
      />
    </div>
  ),
}));

vi.mock('../../primitives/columnFilters', () => ({
  enumColumnFilter: () => ({}),
  firstColumnFilterValue: (value: string[] | null | undefined) =>
    Array.isArray(value) ? (value[0] ?? undefined) : undefined,
  searchColumnFilter: () => ({}),
}));
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
    expect(screen.getAllByTestId('rows')[0]!.textContent).toBe('openai,legacy');
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

  it('lists providers enabled in the AI catalogue before the ones that are not', () => {
    renderSection({
      providerIds: ['off', 'on'],
      providers: [
        { enabled: false, id: 'off', name: 'Off' },
        { enabled: true, id: 'on', name: 'On' },
      ],
    });
    expect(screen.getAllByTestId('rows')[0]!.textContent).toBe('on,off');
  });

  it('filters the provider table by catalogue status, and clearing the filter restores it', () => {
    renderSection({
      providerIds: ['off', 'on'],
      providers: [
        { enabled: false, id: 'off', name: 'Off' },
        { enabled: true, id: 'on', name: 'On' },
      ],
    });

    fireEvent.click(screen.getAllByTestId('filter-enabled')[0]!);
    expect(screen.getAllByTestId('rows')[0]!.textContent).toBe('on');

    fireEvent.click(screen.getAllByTestId('filter-clear')[0]!);
    expect(screen.getAllByTestId('rows')[0]!.textContent).toBe('on,off');
  });

  it('replaces the note column with a status column', () => {
    renderSection();
    const columns = screen.getAllByTestId('columns')[0]!.textContent;
    expect(columns).toContain('status');
    expect(columns).not.toContain('note');
  });

  it('keeps the delisted caveat next to the provider name and tags it as not enabled', () => {
    renderSection({
      config: config({ legacy: { enabled: true, onUnavailable: 'direct' } }),
      providerIds: ['openai', 'legacy'],
    });
    const legacyRow = screen.getAllByTestId('cells')[1]!.textContent ?? '';
    expect(legacyRow).toContain('networkProxy.scopes.notes.providerDelisted');
    expect(legacyRow).toContain('networkProxy.scopes.status.disabled');
    // The 状态 column replaced this note; a disabled tag already says it.
    expect(legacyRow).not.toContain('networkProxy.scopes.notes.providerDisabled');
  });
});
