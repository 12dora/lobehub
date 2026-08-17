// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminNetworkProxyService,
  AdminNetworkProxySettings,
} from '@/enterprise/client/services/adminNetworkProxy';
import type {
  NetworkProxyEngineIssueCode,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';

import type { NetworkProxyProviderOption } from './hooks';
import NetworkProxyTab from './NetworkProxyTab';

const mocks = vi.hoisted(() => ({
  providers: [] as { enabled: boolean; id: string; name: string }[],
  t: vi.fn((key: string, _params?: Record<string, unknown>) => key),
  providersError: undefined as unknown,
  artifactsStaleError: undefined as unknown,
  providersStaleError: undefined as unknown,
  reloadFails: false,
  settings: null as AdminNetworkProxySettings | null,
  status: null as NetworkProxyStatusView | null,
  statusError: undefined as unknown,
  statusStaleError: undefined as unknown,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('i18next', () => ({
  default: { getFixedT: () => (key: string) => key, t: (key: string) => key },
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    description,
    message,
  }: {
    action?: ReactNode;
    description?: ReactNode;
    message?: ReactNode;
  }) => (
    <div data-testid="alert">
      <span>{message}</span>
      <span>{description}</span>
      {action}
    </div>
  ),
  Skeleton: { Block: () => <div data-testid="skeleton" /> },
  Tag: ({ children }: { children?: ReactNode }) => <span data-testid="tag">{children}</span>,
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
  DropdownMenu: ({
    children,
    items,
  }: {
    children?: ReactNode;
    items: { disabled?: boolean; key: string; label?: ReactNode; onClick?: () => void }[];
  }) => (
    <div>
      {children}
      {items.map((item) => (
        <button
          data-testid={`more-${item.key}`}
          disabled={item.disabled}
          key={item.key}
          type="button"
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (checked: boolean) => void;
  }) => (
    <input
      checked={Boolean(checked)}
      data-testid="master-switch"
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange?.(event.target.checked)}
    />
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/libs/trpc/client', () => ({ lambdaClient: {} }));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const swr = <T,>(data: T | undefined, error?: unknown) => ({
  data,
  error,
  isLoading: false,
  mutate: vi.fn(async () => data),
});

vi.mock('./hooks', () => ({
  invalidateNetworkProxyEngine: vi.fn(async () => undefined),
  invalidateNetworkProxyNodes: vi.fn(async () => undefined),
  invalidateNetworkProxyStatus: vi.fn(async () => undefined),
  invalidateNetworkProxySubscriptions: vi.fn(async () => undefined),
  useNetworkProxyArtifacts: () =>
    swr(
      mocks.artifactsStaleError
        ? {
            engine: {
              binSha256: 'abc',
              expectedAsset: 'mihomo.gz',
              platformKey: 'linux:x64',
              supported: true,
              version: 'v1.19.30',
            },
            geodata: { commit: 'c', files: [] },
            instances: [],
          }
        : undefined,
      mocks.artifactsStaleError,
    ),
  useNetworkProxyNodes: () => swr(undefined),
  useNetworkProxyProviderCatalog: () =>
    swr<NetworkProxyProviderOption[] | undefined>(
      mocks.providersError ? undefined : mocks.providers,
      mocks.providersError ?? mocks.providersStaleError,
    ),
  useNetworkProxySettings: () => ({
    data: mocks.settings ?? undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(async (next?: AdminNetworkProxySettings) => {
      if (next) {
        mocks.settings = next;
        return next;
      }
      if (mocks.reloadFails) throw new Error('reload failed');
      return mocks.settings ?? undefined;
    }),
  }),
  useNetworkProxyStatus: () =>
    swr(
      mocks.statusError ? undefined : (mocks.status ?? undefined),
      mocks.statusError ?? mocks.statusStaleError,
    ),
  useNetworkProxySubscriptions: () => swr({ items: [] }),
}));

// The engine block is stubbed, but it renders the REAL FieldStatus for the restart field so the
// assertions below go through the production status component rather than raw entry state.
vi.mock('./sections/EngineSection', async () => {
  const { default: FieldStatus } = await import('./FieldStatus');
  const { NETWORK_PROXY_FIELDS } = await import('./useNetworkProxyActions');
  return {
    default: ({ actions }: { actions: Parameters<typeof FieldStatus>[0]['actions'] }) => (
      <div data-testid="engine">
        <FieldStatus
          actions={actions}
          field={NETWORK_PROXY_FIELDS.restart}
          pendingLabel="networkProxy.engine.restarting"
          successLabel="networkProxy.engine.restartRequested"
        />
        <button
          data-testid="install-engine"
          type="button"
          onClick={() => void actions.installArtifact('engine')}
        >
          install
        </button>
        <FieldStatus
          actions={actions}
          field={NETWORK_PROXY_FIELDS.install('engine')}
          successLabel="networkProxy.engine.installRequested"
        />
      </div>
    ),
  };
});
vi.mock('./sections/OutletSection', async () => {
  const { default: FieldStatus } = await import('./FieldStatus');
  const { NETWORK_PROXY_FIELDS } = await import('./useNetworkProxyActions');
  return {
    default: ({ actions }: { actions: Parameters<typeof FieldStatus>[0]['actions'] }) => (
      <div data-testid="outlet">
        <button
          data-testid="select-node"
          type="button"
          onClick={() => void actions.selectNode('node-b')}
        >
          pin
        </button>
        <FieldStatus actions={actions} field={NETWORK_PROXY_FIELDS.selectNode} />
      </div>
    ),
  };
});
vi.mock('./sections/SubscriptionsSection', () => ({ default: () => <div data-testid="subs" /> }));
vi.mock('./sections/ScopesSection', () => ({ default: () => <div data-testid="scopes" /> }));

const settingsFixture = (
  overrides: Partial<AdminNetworkProxySettings> = {},
  providerScopes: Record<string, { enabled: boolean; onUnavailable: 'direct' | 'fail' }> = {},
): AdminNetworkProxySettings => ({
  config: {
    bypassHosts: [],
    downloadViaStaticProxy: false,
    engineLogLevel: 'warning',
    masterEnabled: false,
    outlet: {
      kind: 'engine',
      latencyIntervalSec: 300,
      latencyTestUrl: 'https://www.gstatic.com/generate_204',
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
      providers: providerScopes,
    },
    subscriptionUpdateViaOutlet: false,
  },
  desiredArtifacts: {},
  engineGeneration: 0,
  globalProxyActive: false,
  revision: 4,
  ...overrides,
});

const statusFixture = (
  overrides: Partial<NetworkProxyStatusView> = {},
  instanceOverrides: Partial<NetworkProxyStatusView['instances'][number]> = {},
): NetworkProxyStatusView => ({
  fallbackScopes: [],
  globalProxyActive: false,
  instances: [
    {
      activeNode: 'node-a',
      aliveNodeCount: 2,
      appliedRevision: 4,
      arch: 'arm64',
      artifacts: [{ installed: true, kind: 'engine', source: 'download', version: 'v1.19.30' }],
      engineState: 'running',
      engineVersion: 'v1.19.30',
      fallbackCount: 0,
      instanceId: 'pinst_1',
      healing: null,
      isCurrent: true,
      lastHeartbeatAt: '2026-08-17T00:00:00.000Z',
      lastIssue: null,
      platform: 'linux',
      proxiedCount: 12,
      updatedAt: '2026-08-17T00:00:00.000Z',
      ...instanceOverrides,
    },
  ],
  outlet: {
    activeNode: 'node-a',
    activeNodeDelayMs: 120,
    available: true,
    circuitOpen: false,
    kind: 'engine',
    unavailableReason: null,
  },
  revision: 4,
  ...overrides,
});

const engineIssue = (code: NetworkProxyEngineIssueCode, detail: string | null = null) => ({
  at: '2026-08-17T00:00:00.000Z',
  code,
  detail,
});

const stubService = (overrides: Partial<AdminNetworkProxyService> = {}) =>
  ({
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    getArtifactStatus: vi.fn(),
    getEngineLogs: vi.fn(),
    getSettings: vi.fn(),
    getStatus: vi.fn(),
    installArtifact: vi.fn(),
    installGeodata: vi.fn(),
    listNodes: vi.fn(),
    listSubscriptions: vi.fn(),
    refreshSubscription: vi.fn(),
    restartEngine: vi.fn(),
    selectNode: vi.fn(),
    testConnectivity: vi.fn(),
    testLatency: vi.fn(),
    updateScopes: vi.fn(),
    updateSettings: vi.fn(),
    updateSubscription: vi.fn(),
    uploadArtifact: vi.fn(),
    ...overrides,
  }) as unknown as AdminNetworkProxyService;

const localOk = (settings: AdminNetworkProxySettings) => ({
  ...settings,
  local: { error: null, ok: true },
});

const revisionConflict = () =>
  Object.assign(new Error('PLATFORM_REVISION_CONFLICT'), {
    data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
  });

const masterSwitch = () => screen.getByTestId('master-switch') as HTMLInputElement;

beforeEach(() => {
  mocks.t.mockClear();
  mocks.settings = settingsFixture();
  mocks.status = statusFixture();
  mocks.providers = [{ enabled: true, id: 'openai', name: 'OpenAI' }];
  mocks.providersError = undefined;
  mocks.artifactsStaleError = undefined;
  mocks.providersStaleError = undefined;
  mocks.reloadFails = false;
  mocks.statusError = undefined;
  mocks.statusStaleError = undefined;
});

describe('NetworkProxyTab', () => {
  it('renders the four blocks once the configuration has loaded', () => {
    render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.getByTestId('engine')).toBeTruthy();
    expect(screen.getByTestId('outlet')).toBeTruthy();
    expect(screen.getByTestId('subs')).toBeTruthy();
    expect(screen.getByTestId('scopes')).toBeTruthy();
  });

  it('turns the master switch on with the current revision', async () => {
    const updateSettings = vi.fn(async (_input: unknown) => settingsFixture({ revision: 5 }));
    render(<NetworkProxyTab canManage enabled service={stubService({ updateSettings })} />);

    await act(async () => {
      fireEvent.click(masterSwitch());
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({
      config: { masterEnabled: true },
      expectedRevision: 4,
    });
  });

  it('locks the master switch and explains why when PROXY_URL is active', () => {
    mocks.settings = settingsFixture({ globalProxyActive: true });
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(masterSwitch().disabled).toBe(true);
    expect(screen.getByText('networkProxy.banners.globalProxy')).toBeTruthy();
  });

  it('disables every write when the admin only has read access', () => {
    mocks.status = statusFixture({}, { engineState: 'error', lastIssue: engineIssue('exited') });
    render(<NetworkProxyTab enabled canManage={false} service={stubService()} />);

    expect(masterSwitch().disabled).toBe(true);
    expect(screen.getByText('networkProxy.readOnly')).toBeTruthy();
    // Including the restart button inside the engine-error banner.
    const restart = screen.getByRole('button', { name: 'networkProxy.engine.restart' });
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('more-restart-engine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the admin value visible and retries against the winning revision after a conflict', async () => {
    const updateSettings = vi
      .fn()
      // Another administrator already wrote revision 9 — that is why this call loses the CAS.
      .mockImplementationOnce(async () => {
        mocks.settings = settingsFixture({ revision: 9 });
        throw revisionConflict();
      })
      .mockImplementation(async () => settingsFixture({ revision: 10 }));

    render(<NetworkProxyTab canManage enabled service={stubService({ updateSettings })} />);

    await act(async () => {
      fireEvent.click(masterSwitch());
    });

    // The conflict is shown inline; the write is not silently rolled back...
    await waitFor(() => expect(screen.getByText('networkProxy.conflict.title')).toBeTruthy());
    // ...and the value the admin set is still the one on screen, even though the reloaded
    // server config still says the master switch is off.
    expect(masterSwitch().checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText('networkProxy.conflict.retryAll'));
    });

    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1]![0]).toMatchObject({
      config: { masterEnabled: true },
      expectedRevision: 9,
    });
  });

  it('keeps a pending conflict alive when an unrelated write succeeds', async () => {
    const updateSettings = vi.fn(async () => {
      mocks.settings = settingsFixture({ revision: 9 });
      throw revisionConflict();
    });
    const updateScopes = vi.fn(async (_input: unknown) => settingsFixture({ revision: 11 }));

    render(
      <NetworkProxyTab canManage enabled service={stubService({ updateScopes, updateSettings })} />,
    );

    await act(async () => {
      fireEvent.click(masterSwitch());
    });
    await waitFor(() => expect(screen.getByText('networkProxy.conflict.title')).toBeTruthy());

    // A different control saves successfully in the meantime.
    await act(async () => {
      fireEvent.click(screen.getByTestId('more-features-on'));
    });
    expect(updateScopes).toHaveBeenCalledTimes(1);

    // The master switch's conflict — and its retry — must survive that.
    expect(screen.getByText('networkProxy.conflict.title')).toBeTruthy();
    expect(masterSwitch().checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText('networkProxy.conflict.retryAll'));
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it('sends one bulk scope write from the more-actions menu', async () => {
    const updateScopes = vi.fn(async (_input: unknown) => settingsFixture({ revision: 5 }));
    render(<NetworkProxyTab canManage enabled service={stubService({ updateScopes })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('more-features-on'));
    });

    expect(updateScopes).toHaveBeenCalledWith({
      expectedRevision: 4,
      ops: [{ enabled: true, target: 'all_features' }],
    });
  });

  it('covers configured providers that the catalog no longer lists in a bulk write', async () => {
    mocks.settings = settingsFixture({}, { legacy: { enabled: true, onUnavailable: 'direct' } });
    const updateScopes = vi.fn(async (_input: unknown) => settingsFixture({ revision: 5 }));
    render(<NetworkProxyTab canManage enabled service={stubService({ updateScopes })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('more-providers-off'));
    });

    const ops = (updateScopes.mock.calls[0]![0] as { ops: { providerIds: string[] }[] }).ops;
    expect([...ops[0]!.providerIds].sort()).toEqual(['legacy', 'openai']);
  });

  it('disables provider bulk operations while the catalog is unavailable', () => {
    mocks.providersError = new Error('denied');
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect((screen.getByTestId('more-providers-off') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('more-providers-on') as HTMLButtonElement).disabled).toBe(true);
    // Feature scopes are fully known, so they stay available.
    expect((screen.getByTestId('more-features-on') as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns about the scopes that are silently falling back to direct', () => {
    mocks.status = statusFixture({ fallbackScopes: ['provider:openai'] });
    render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.getByText('networkProxy.banners.fallback')).toBeTruthy();
  });

  it('reports a restart that the instance could not carry out as a failure, not a success', async () => {
    const restartEngine = vi.fn(async () => ({
      ...settingsFixture({ revision: 5 }),
      local: { error: 'spawn_failed', ok: false },
    }));
    render(<NetworkProxyTab canManage enabled service={stubService({ restartEngine })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('more-restart-engine'));
    });

    // The desired state committed, so the engine's own reason has to reach the rendered status —
    // translated from the code it reported, never as raw text.
    expect(screen.getByText(/networkProxy\.engineIssue\.spawn_failed/)).toBeTruthy();
    // ...the task must never be reported as succeeded...
    expect(screen.queryByText('networkProxy.engine.restartRequested')).toBeNull();
    // ...and a retry has to be offered next to it.
    expect(screen.getAllByText('networkProxy.actions.retry').length).toBeGreaterThan(0);
  });

  it('keeps a successful local outcome as a success', async () => {
    const restartEngine = vi.fn(async () => localOk(settingsFixture({ revision: 5 })));
    render(<NetworkProxyTab canManage enabled service={stubService({ restartEngine })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('more-restart-engine'));
    });

    expect(screen.getByText('networkProxy.engine.restartRequested')).toBeTruthy();
    expect(screen.queryByText(/networkProxy\.engineIssue\./)).toBeNull();
  });

  it('reports an install the instance could not perform as a failure', async () => {
    const installArtifact = vi.fn(async () => ({
      ...settingsFixture({ revision: 5 }),
      local: { error: 'artifact_mismatch', ok: false },
    }));
    render(<NetworkProxyTab canManage enabled service={stubService({ installArtifact })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('install-engine'));
    });

    expect(screen.getByText(/networkProxy\.engineIssue\.artifact_mismatch/)).toBeTruthy();
    expect(screen.queryByText('networkProxy.engine.installRequested')).toBeNull();
  });

  it('reports a node selection the engine refused as a failure', async () => {
    const selectNode = vi.fn(async () => ({
      ...settingsFixture({ revision: 5 }),
      local: { error: 'node_select_failed', ok: false },
    }));
    render(<NetworkProxyTab canManage enabled service={stubService({ selectNode })} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('select-node'));
    });

    expect(screen.getByText(/networkProxy\.engineIssue\.node_select_failed/)).toBeTruthy();
  });

  it('offers a retry for a failing artifact refresh while keeping the cached install state', () => {
    mocks.artifactsStaleError = new Error('offline');
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.artifactsStale')).toBeTruthy();
    // Not the first-load "unknown" state — the cached answer is still on screen.
    expect(screen.queryByText('networkProxy.banners.artifactsUnknown')).toBeNull();
  });

  it('stays recoverable when the conflict reload itself fails', async () => {
    mocks.reloadFails = true;
    const updateSettings = vi.fn(async () => {
      throw revisionConflict();
    });
    render(<NetworkProxyTab canManage enabled service={stubService({ updateSettings })} />);

    await act(async () => {
      fireEvent.click(masterSwitch());
    });

    // Not stuck pending: the admin can see why and can act.
    await waitFor(() =>
      expect(screen.getByText('networkProxy.conflict.reloadFailed')).toBeTruthy(),
    );
    expect(masterSwitch().disabled).toBe(false);
    expect(masterSwitch().checked).toBe(true);
    expect(screen.getAllByText('networkProxy.actions.retry').length).toBeGreaterThan(0);
  });

  it('disables provider bulk operations when a revalidation fails over cached data', () => {
    mocks.providersStaleError = new Error('offline');
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    // Cached rows stay usable, but a bulk write over a possibly incomplete set does not.
    expect((screen.getByTestId('more-providers-on') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('more-providers-off') as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns that badges are stale when the status poll keeps failing', () => {
    mocks.statusStaleError = new Error('offline');
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.statusStale')).toBeTruthy();
    expect(screen.getByText('networkProxy.badges.stale')).toBeTruthy();
    // The last known engine state is still shown — it is old, not wrong.
    expect(screen.getByText('networkProxy.badges.engine')).toBeTruthy();
  });

  it('reports a failed status query as unknown rather than as a healthy "nothing installed"', () => {
    mocks.statusError = new Error('network');
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.statusUnknown')).toBeTruthy();
    // No engine / outlet / applied badges claiming a state we could not read.
    expect(screen.getByText('networkProxy.badges.unknown')).toBeTruthy();
    expect(screen.queryByText('networkProxy.badges.outletDown')).toBeNull();
    expect(screen.queryByText(/networkProxy\.badges\.applied/)).toBeNull();
  });

  it('names the engine problem without an instance id, and keeps the detail out of the banner', () => {
    mocks.status = statusFixture(
      {},
      { engineState: 'error', lastIssue: engineIssue('health_timeout', 'TimeoutError') },
    );
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.engineIssue')).toBeTruthy();
    expect(screen.getByText('networkProxy.engineIssue.health_timeout')).toBeTruthy();
    // `pinst_…` means nothing to the person reading this, and the raw reason is not copy.
    expect(screen.queryByText(/pinst_/)).toBeNull();
    expect(screen.queryByText('TimeoutError')).toBeNull();
  });

  it('reveals the technical detail only when the admin asks for it', () => {
    mocks.status = statusFixture(
      {},
      { engineState: 'error', lastIssue: engineIssue('exited', 'code=2 signal=null') },
    );
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    fireEvent.click(screen.getByText('networkProxy.engineIssue.detailToggle'));
    expect(screen.getByText('code=2 signal=null')).toBeTruthy();
  });

  it('leaves a live engine alone even when its row still carries the last issue', () => {
    mocks.status = statusFixture(
      {},
      { engineState: 'running', lastIssue: engineIssue('geodata_invalid') },
    );
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.queryByText('networkProxy.banners.engineIssue')).toBeNull();
  });

  it('counts the affected nodes instead of naming one of them', () => {
    const base = statusFixture();
    const first = base.instances[0]!;
    mocks.status = {
      ...base,
      instances: [
        { ...first, engineState: 'error', lastIssue: engineIssue('exited') },
        {
          ...first,
          engineState: 'error',
          instanceId: 'pinst_2',
          isCurrent: false,
          lastIssue: engineIssue('exited'),
        },
      ],
    };
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.engineIssueMulti')).toBeTruthy();
    expect(screen.queryByText('networkProxy.banners.engineIssue')).toBeNull();
  });

  it('says recovery is under way, with a countdown, instead of demanding a restart', () => {
    mocks.status = statusFixture(
      {},
      {
        engineState: 'error',
        healing: { attempt: 2, nextAttemptAt: new Date(Date.now() + 30_000).toISOString() },
        lastIssue: engineIssue('start_timeout'),
      },
    );
    render(<NetworkProxyTab canManage enabled service={stubService()} />);

    expect(screen.getByText('networkProxy.banners.selfHealing')).toBeTruthy();
    // One banner about one engine — not "it is down" next to "it is coming back".
    expect(screen.queryByText('networkProxy.banners.engineIssue')).toBeNull();
    // The reason survives, and so does the manual escape hatch.
    expect(screen.getByText('networkProxy.engineIssue.start_timeout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'networkProxy.engine.restart' })).toBeTruthy();
    expect(
      mocks.t.mock.calls.some(
        ([key, params]) =>
          key === 'networkProxy.banners.selfHealingDesc' &&
          (params as { seconds?: number } | undefined)?.seconds === 30,
      ),
    ).toBe(true);
  });

  it('confirms an engine that came back on its own', async () => {
    mocks.status = statusFixture({}, { engineState: 'error', lastIssue: engineIssue('exited') });
    const view = render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.getByText('networkProxy.banners.engineIssue')).toBeTruthy();

    mocks.status = statusFixture();
    await act(async () => {
      view.rerender(<NetworkProxyTab canManage enabled service={stubService()} />);
    });

    expect(screen.getByText('networkProxy.banners.selfHealed')).toBeTruthy();
    expect(screen.queryByText('networkProxy.banners.engineIssue')).toBeNull();
  });

  it('does not congratulate itself on an engine that was healthy all along', () => {
    render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.queryByText('networkProxy.banners.selfHealed')).toBeNull();
  });

  it('hides the applied-configuration ratio when there is only one node', () => {
    render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.queryByText('networkProxy.badges.applied')).toBeNull();
  });

  it('shows the applied-configuration ratio once there is a fleet', () => {
    const base = statusFixture();
    const first = base.instances[0]!;
    mocks.status = {
      ...base,
      instances: [first, { ...first, appliedRevision: 3, instanceId: 'pinst_2', isCurrent: false }],
    };
    render(<NetworkProxyTab canManage enabled service={stubService()} />);
    expect(screen.getByText('networkProxy.badges.applied')).toBeTruthy();
  });

  it('offers the rule-data install from the banner when smart routing has nothing to route with', async () => {
    mocks.settings = settingsFixture();
    mocks.settings.config.ruleMode = 'smart';
    const installGeodata = vi.fn(async () => ({
      ...localOk(settingsFixture({ revision: 5 })),
      results: [
        { error: null, kind: 'geoip' as const, ok: true },
        { error: null, kind: 'geosite' as const, ok: true },
      ],
    }));
    render(<NetworkProxyTab canManage enabled service={stubService({ installGeodata })} />);

    expect(screen.getByText('networkProxy.banners.geodata')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('networkProxy.engine.geodata.install'));
    });
    expect(installGeodata).toHaveBeenCalledWith({ expectedRevision: 4 });
  });
});
