// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type { ArtifactState, InstanceStatusView } from '@/types/platform/networkProxy';

import type { NetworkProxyActions, NetworkProxyEntry } from '../useNetworkProxyActions';
import EngineSection from './EngineSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@/libs/trpc/client', () => ({ lambdaClient: {} }));

vi.mock('@lobehub/ui', () => ({
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span data-tooltip={String(title ?? '')}>{children}</span>
  ),
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
}));

vi.mock('./EngineLogsDrawer', () => ({ default: () => <div data-testid="logs" /> }));

// The upload affordance is the only place the expected digest belongs — assert what it was given.
vi.mock('./ArtifactUploadButton', () => ({
  default: ({
    disabled,
    expectedDigest,
    kind,
  }: {
    disabled?: boolean;
    expectedDigest?: string | null;
    kind: string;
  }) => (
    <button
      data-digest={expectedDigest ?? ''}
      data-disabled={String(Boolean(disabled))}
      data-testid={`upload-${kind}`}
      type="button"
    >
      upload
    </button>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
  }: {
    columns: {
      dataIndex: string;
      key: string;
      render?: (value: unknown, row: InstanceStatusView) => ReactNode;
      title: ReactNode;
    }[];
    dataSource: InstanceStatusView[];
  }) => (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key}>{column.title}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataSource.map((row) => (
          <tr key={row.instanceId}>
            {columns.map((column) => (
              <td key={column.key}>
                {column.render
                  ? column.render(
                      (row as unknown as Record<string, unknown>)[column.dataIndex],
                      row,
                    )
                  : null}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const artifact = (kind: ArtifactState['kind'], installed: boolean): ArtifactState => ({
  installed,
  kind,
  source: installed ? 'download' : null,
  version: installed ? 'v1.19.30' : null,
});

const instance = (overrides: Partial<InstanceStatusView> = {}): InstanceStatusView => ({
  activeNode: 'node-a',
  aliveNodeCount: 1,
  appliedRevision: 4,
  arch: 'arm64',
  artifacts: [artifact('engine', true), artifact('geoip', false), artifact('geosite', false)],
  engineState: 'running',
  engineVersion: 'v1.19.30',
  fallbackCount: 0,
  healing: null,
  instanceId: 'pinst_1',
  isCurrent: true,
  lastHeartbeatAt: '2026-08-17T00:00:00.000Z',
  lastIssue: null,
  platform: 'linux',
  proxiedCount: 0,
  updatedAt: '2026-08-17T00:00:00.000Z',
  ...overrides,
});

const stubActions = (entries: Record<string, NetworkProxyEntry> = {}): NetworkProxyActions =>
  ({
    conflicts: [],
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
    valueOf: <T,>(_field: string, serverValue: T): T => serverValue,
  }) as unknown as NetworkProxyActions;

const renderSection = (
  actions: NetworkProxyActions = stubActions(),
  instances: InstanceStatusView[] = [instance()],
) =>
  render(
    <EngineSection
      canManage
      actions={actions}
      instances={instances}
      revision={4}
      service={{} as unknown as AdminNetworkProxyService}
      onReloadArtifacts={vi.fn()}
      onReloadStatus={vi.fn()}
    />,
  );

describe('EngineSection dependency panel', () => {
  it('lists the engine and both rule files on a fresh deployment, before smart routing is on', () => {
    renderSection();

    // The old gate only rendered the rule files once smart mode was on — which needed them installed.
    expect(screen.getByTestId('engine-dependencies')).toBeTruthy();
    expect(screen.getByTestId('dependency-engine')).toBeTruthy();
    expect(screen.getByTestId('dependency-geoip')).toBeTruthy();
    expect(screen.getByTestId('dependency-geosite')).toBeTruthy();
    expect(screen.getAllByText('networkProxy.engine.geodata.stateMissing')).toHaveLength(2);
  });

  it('installs everything missing with one action — engine already installed, so only the rule data', () => {
    const actions = stubActions();
    renderSection(actions);

    fireEvent.click(screen.getByText('networkProxy.engine.deps.installAll'));
    expect(actions.installGeodata).toHaveBeenCalledTimes(1);
    expect(actions.installArtifact).not.toHaveBeenCalled();
  });

  it('installs the engine first when it is missing too', async () => {
    const actions = stubActions();
    renderSection(actions, [
      instance({
        artifacts: [
          artifact('engine', false),
          artifact('geoip', false),
          artifact('geosite', false),
        ],
        engineState: 'not_installed',
      }),
    ]);

    fireEvent.click(screen.getByText('networkProxy.engine.deps.installAll'));
    await Promise.resolve();
    expect(actions.installArtifact).toHaveBeenCalledWith('engine');
    expect(actions.installGeodata).toHaveBeenCalledTimes(1);
  });

  it('turns the one-click button into a plain "all installed" state once nothing is missing', () => {
    renderSection(stubActions(), [
      instance({
        artifacts: [artifact('engine', true), artifact('geoip', true), artifact('geosite', true)],
      }),
    ]);
    const done = screen.getByText('networkProxy.engine.deps.allInstalled') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(screen.getAllByText('networkProxy.engine.geodata.stateInstalled')).toHaveLength(2);
  });

  it('says how far the fleet has got, but only when there is a fleet', () => {
    const { unmount } = renderSection();
    expect(screen.queryByText('networkProxy.engine.geodata.installedOn')).toBeNull();
    unmount();

    renderSection(stubActions(), [
      instance(),
      instance({
        artifacts: [artifact('engine', true), artifact('geoip', true), artifact('geosite', true)],
        instanceId: 'pinst_2',
        isCurrent: false,
      }),
    ]);
    expect(screen.getAllByText('networkProxy.engine.geodata.installedOn')).toHaveLength(2);
  });

  it('keeps the manual upload path but greys it out once the file is installed here', () => {
    renderSection();
    expect(screen.getByTestId('upload-geoip').getAttribute('data-disabled')).toBe('false');
    expect(screen.getByTestId('upload-geosite').getAttribute('data-disabled')).toBe('false');
    // The engine is already installed on this instance — nothing left to upload.
    expect(screen.getByTestId('upload-engine').getAttribute('data-disabled')).toBe('true');
  });

  it('shows the checksum as a small code next to the title and hands it to the upload check', () => {
    renderSection();
    expect(screen.queryByText(/networkProxy\.engine\.expectedDigestLine/)).toBeNull();
    expect(screen.getAllByText(/^SHA-256 /).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('upload-geoip').getAttribute('data-digest')).toBeTruthy();
  });

  it('offers a direct download of the official file for every dependency', () => {
    renderSection();
    // No artifact catalogue was passed, so the engine asset is unknown; the two rule files always have one.
    expect(screen.getAllByText('networkProxy.engine.downloadFile')).toHaveLength(2);
  });

  it('flags a file the administrator installed despite a checksum mismatch', () => {
    renderSection(stubActions(), [
      instance({
        artifacts: [
          { ...artifact('engine', true), pinnedDigestMatch: false, source: 'upload' },
          artifact('geoip', false),
          artifact('geosite', false),
        ],
      }),
    ]);
    expect(screen.getByText('networkProxy.engine.digestMismatch.installed')).toBeTruthy();
  });

  it('disables installing for a read-only admin', () => {
    render(
      <EngineSection
        actions={stubActions()}
        canManage={false}
        instances={[instance()]}
        revision={4}
        service={{} as unknown as AdminNetworkProxyService}
        onReloadArtifacts={vi.fn()}
        onReloadStatus={vi.fn()}
      />,
    );
    const install = screen.getByText('networkProxy.engine.deps.installAll') as HTMLButtonElement;
    expect(install.disabled).toBe(true);
  });
});

describe('EngineSection instances table', () => {
  it('names the engine problem in the admin’s language and hides the raw detail', () => {
    renderSection(stubActions(), [
      instance({
        engineState: 'error',
        lastIssue: {
          at: '2026-08-17T00:00:00.000Z',
          code: 'health_timeout',
          detail: 'TimeoutError',
        },
      }),
    ]);

    expect(screen.getByText('networkProxy.engine.columns.lastIssue')).toBeTruthy();
    const label = screen.getByText('networkProxy.engineIssue.health_timeout');
    expect(label).toBeTruthy();
    // The technical detail is a tooltip, never a line of copy.
    expect(screen.queryByText('TimeoutError')).toBeNull();
    expect(label.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('TimeoutError');
  });

  it('answers whether each instance is on the current configuration, not with a number', () => {
    renderSection(stubActions(), [
      instance(),
      instance({ appliedRevision: 3, instanceId: 'pinst_2', isCurrent: false }),
    ]);

    expect(screen.getByText('networkProxy.engine.configSynced')).toBeTruthy();
    expect(screen.getByText('networkProxy.engine.configPending')).toBeTruthy();
    // The raw revision must not be on screen at all.
    expect(screen.queryByText('4')).toBeNull();
    expect(screen.queryByText('3')).toBeNull();
  });

  it('names the current instance instead of showing its opaque id', () => {
    renderSection();
    expect(screen.getByText('networkProxy.engine.thisInstance')).toBeTruthy();
    // The pinst_… id is internal state — it never reaches the current-instance cell.
    expect(screen.queryByText(/pinst_1/)).toBeNull();
  });
});
