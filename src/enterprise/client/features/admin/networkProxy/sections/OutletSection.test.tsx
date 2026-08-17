// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NetworkProxyConfigView, StaticProxyUpdate } from '@/types/platform/networkProxy';

import type { NetworkProxyGeodataState } from '../geodataState';
import type { NetworkProxyActions, NetworkProxyEntry } from '../useNetworkProxyActions';
import OutletSection from './OutletSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@/libs/trpc/client', () => ({ lambdaClient: {} }));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: ReactNode }) => <div>{message}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange?: (event: { target: { value: string } }) => void;
    placeholder?: string;
    value?: string;
  }) => (
    <input
      data-testid={placeholder ?? 'text'}
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  InputNumber: ({ value }: { value?: number | null }) => (
    <input readOnly data-testid="number" value={String(value ?? '')} />
  ),
  InputPassword: ({ value }: { value?: string }) => (
    <input readOnly data-testid="password" value={value ?? ''} />
  ),
  Segmented: ({ value }: { value?: string }) => <span data-testid="segmented">{value}</span>,
  Select: ({ value }: { value?: unknown }) => (
    <span data-testid="select">{String(value ?? '')}</span>
  ),
  Switch: ({ checked }: { checked?: boolean }) => (
    <input readOnly checked={Boolean(checked)} type="checkbox" />
  ),
}));

vi.mock('./NodesTable', () => ({ default: () => <div data-testid="nodes" /> }));

const config = (overrides: Partial<NetworkProxyConfigView> = {}): NetworkProxyConfigView => ({
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
    providers: {},
  },
  subscriptionUpdateViaOutlet: false,
  ...overrides,
});

const submittedDraft: StaticProxyUpdate = {
  password: { action: 'replace', value: 's3cret' },
  port: 8080,
  server: 'mine.example.com',
  type: 'http',
};

const stubActions = (entries: Record<string, NetworkProxyEntry>): NetworkProxyActions =>
  ({
    conflicts: Object.entries(entries)
      .filter(([, entry]) => entry.status === 'conflict')
      .map(([field]) => field),
    dismiss: vi.fn(),
    dismissAll: vi.fn(),
    entryOf: (field: string) => entries[field],
    installArtifact: vi.fn(),
    installGeodata: vi.fn(),
    isBusy: (field: string) => entries[field]?.status === 'pending',
    lastConnectivity: null,
    latestNodes: null,
    patchConfig: vi.fn(),
    restartEngine: vi.fn(),
    retry: vi.fn(),
    retryAll: vi.fn(),
    selectNode: vi.fn(),
    testConnectivity: vi.fn(),
    testLatency: vi.fn(),
    updateScopes: vi.fn(),
    valueOf: <T,>(field: string, serverValue: T): T => {
      const entry = entries[field];
      return entry && entry.status !== 'success' && 'draft' in entry
        ? (entry.draft as T)
        : serverValue;
    },
  }) as unknown as NetworkProxyActions;

const renderSection = (
  actions: NetworkProxyActions,
  view: NetworkProxyConfigView,
  extra: { geodataState?: NetworkProxyGeodataState; onInstallGeodata?: () => void } = {},
) =>
  render(
    <OutletSection
      canManage
      actions={actions}
      config={view}
      geodataState={extra.geodataState ?? 'ready'}
      subscriptions={[]}
      onInstallGeodata={extra.onInstallGeodata}
      onReloadNodes={vi.fn()}
    />,
  );

const serverInput = () =>
  screen.getByTestId('networkProxy.outlet.staticServerPlaceholder') as HTMLInputElement;

describe('OutletSection static proxy', () => {
  it('hides the static form when the outlet is the engine and nothing is pending', () => {
    renderSection(stubActions({}), config());
    expect(screen.queryByTestId('networkProxy.outlet.staticServerPlaceholder')).toBeNull();
  });

  it('keeps the submitted draft on screen when the winner switched the outlet back to the engine', () => {
    // The admin submitted a static proxy; another admin won the CAS race with an engine outlet.
    const actions = stubActions({
      staticProxy: {
        draft: submittedDraft,
        errorKey: 'networkProxy.conflict.field',
        retry: vi.fn(),
        status: 'conflict',
      },
    });
    renderSection(actions, config());

    // The form must not disappear — "Retry all" would otherwise re-send invisible credentials.
    expect(serverInput().value).toBe('mine.example.com');
    expect(screen.getByText('networkProxy.conflict.field')).toBeTruthy();
    expect(screen.getByText('networkProxy.actions.retry')).toBeTruthy();
    expect(screen.getByText('networkProxy.conflict.dismiss')).toBeTruthy();
  });

  it('routes Retry and Discard for that draft to the static-proxy field', () => {
    const actions = stubActions({
      staticProxy: {
        draft: submittedDraft,
        errorKey: 'networkProxy.conflict.field',
        retry: vi.fn(),
        status: 'conflict',
      },
    });
    renderSection(actions, config());

    fireEvent.click(screen.getByText('networkProxy.actions.retry'));
    fireEvent.click(screen.getByText('networkProxy.conflict.dismiss'));
    expect(actions.retry).toHaveBeenCalledWith('staticProxy');
    expect(actions.dismiss).toHaveBeenCalledWith('staticProxy');
  });

  it('still shows the form for an unresolved removal so the failure is not orphaned', () => {
    const actions = stubActions({
      staticProxy: {
        draft: null,
        errorKey: 'networkProxy.errors.generic',
        retry: vi.fn(),
        status: 'error',
      },
    });
    renderSection(actions, config());
    expect(screen.getByTestId('networkProxy.outlet.staticServerPlaceholder')).toBeTruthy();
    expect(screen.getByText('networkProxy.errors.generic')).toBeTruthy();
  });

  it('drops back to the engine view once the static-proxy write commits', () => {
    const actions = stubActions({ staticProxy: { status: 'success' } });
    renderSection(actions, config());
    expect(screen.queryByTestId('networkProxy.outlet.staticServerPlaceholder')).toBeNull();
  });
});

describe('OutletSection smart routing', () => {
  it('offers the install instead of a dead-end explanation when the rule data is missing', () => {
    const onInstallGeodata = vi.fn();
    renderSection(stubActions({}), config(), { geodataState: 'missing', onInstallGeodata });

    expect(screen.getByText('networkProxy.outlet.geodataInstallHint')).toBeTruthy();
    fireEvent.click(screen.getByText('networkProxy.outlet.geodataInstallAction'));
    expect(onInstallGeodata).toHaveBeenCalledTimes(1);
  });

  it('says nothing about the rule data once smart routing can be chosen', () => {
    renderSection(stubActions({}), config(), { onInstallGeodata: vi.fn() });
    expect(screen.queryByText('networkProxy.outlet.geodataInstallHint')).toBeNull();
    expect(screen.queryByText('networkProxy.outlet.geodataInstallAction')).toBeNull();
  });

  it('keeps a failed install visible next to the control it blocks', () => {
    renderSection(
      stubActions({
        'install:geodata': {
          detailKey: 'networkProxy.engineIssue.artifact_download_failed',
          errorKey: 'networkProxy.errors.localFailed',
          retry: vi.fn(),
          status: 'error',
        },
      }),
      config(),
      { geodataState: 'missing', onInstallGeodata: vi.fn() },
    );

    expect(screen.getByText(/networkProxy\.engineIssue\.artifact_download_failed/)).toBeTruthy();
    expect(screen.getByText('networkProxy.actions.retry')).toBeTruthy();
  });

  it('says the state is unreadable instead of offering an install it cannot justify', () => {
    const onInstallGeodata = vi.fn();
    renderSection(stubActions({}), config(), { geodataState: 'unknown', onInstallGeodata });

    expect(screen.getByText('networkProxy.outlet.geodataUnknown')).toBeTruthy();
    // No claim that it is missing, and nothing to click.
    expect(screen.queryByText('networkProxy.outlet.geodataInstallHint')).toBeNull();
    expect(screen.queryByText('networkProxy.outlet.geodataInstallAction')).toBeNull();
    expect(onInstallGeodata).not.toHaveBeenCalled();
  });
});
